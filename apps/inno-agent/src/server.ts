// Register source-map-support so that compiled JS stack traces and
// pino-caller call sites map back to the original TS source locations.
import "source-map-support/register.js";

import { auditDurableData } from "./agent/durable-audit.js";
import { PgSessionCatalog } from "./agent/pg-session-catalog.js";
import { createSandboxManager } from "./sandbox/index.js";
import { PgSandboxQuotaStore } from "./sandbox/pg-sandbox-quota.js";
import type { SandboxManager } from "./sandbox/sandbox-session.js";
import { renderPrometheus } from "./utils/metrics.js";
import { createServer, type IncomingMessage as HttpReq } from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { loadConfig, normalizeSandboxConfig, type InnoConfig } from "./config.js";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { ensureDir, readJson, readText, writeJson, writeText } from "./storage/file-store.js";
import { closeDeferredRuns, configureDeferredRuns } from "./scheduler/deferred-runs.js";
import { DurableSessionService } from "./agent/durable-session-service.js";
import { DURABLE_JOB_BUSY_WAIT_MS, runDurableJobPrompt } from "./agent/durable-job-runner.js";
import { executeJob, type CreatedJobSession, type DurableJobExecution, type DurableJobExecutor } from "./scheduler/job-runner.js";
import type { ScheduledJob } from "./scheduler/types.js";
import { ChannelRegistry } from "./channels/channel.js";
import { FeishuChannel } from "./channels/feishu/feishu-channel.js";
import { PersonalChannelDispatcher, type PersonalChannelDispatcherOptions, type StreamEventCallback } from "./channels/personal-dispatcher.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { bridgeChannelResourceId, TenantChannelManager } from "./channels/tenant-channel-manager.js";
import { bridgeBearerToken, handleBridgeMessage } from "./channels/bridge/bridge-server.js";
import { BridgeChannel } from "./channels/bridge/bridge-channel.js";
import { WeChatChannel } from "./channels/wechat/wechat-channel.js";
import type { PersonalBridgeChannelConfig } from "./config.js";
import { ScopedJobStore } from "./scheduler/scoped-job-store.js";
import { CheckInStore } from "./checkins/check-in-store.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { TenantCronScheduler } from "./scheduler/tenant-cron-scheduler.js";
import { HttpError, json } from "./server/http-helpers.js";
import { serveStatic } from "./server/static-serve.js";
import { createRouteDispatcher } from "./server/route-dispatch.js";
import {
	safeJoinReal,
	slugifySkillName,
} from "./server/file-helpers.js";
import { extractFrontmatterFields } from "./server/skill-frontmatter.js";
import { handleChannelsRoutes } from "./server/routes/channels.js";
import { handleJobsRoutes } from "./server/routes/jobs.js";
import { handleCheckInsRoutes } from "./server/routes/checkins.js";
import { handleSettingsRoutes } from "./server/routes/settings.js";
import { handleSkillsRoutes } from "./server/routes/skills.js";
import { handleWorkspacesRoutes } from "./server/routes/workspaces.js";
import { handleSessionsRoutes } from "./server/routes/sessions.js";
import { handleWikiRoutes } from "./server/routes/wiki.js";
import { setL2BackendResolver } from "./memory/l2/l2-backend.js";
import { PgL2Backend } from "./memory/l2/pg-l2-backend.js";
import { createObjectStore, normalizeObjectStorageConfig, type ObjectStore } from "./object-store/index.js";
import { handlePresetsRoutes } from "./server/routes/presets.js";
import { loadSkillsFromDir } from "./agent/skills.js";
import { createSchedulerTools } from "./scheduler/scheduler-tools.js";
import { handleChatRoutes } from "./server/routes/chat.js";
import { handleBtwRoutes } from "./server/routes/btw.js";
import {
	mergeChannels,
	type SessionChannel,
	type SessionChannelMetadata,
} from "./server/session-model.js";
import { logger } from "./logger.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { createGracefulShutdownHandler, installProcessFallbacks } from "./utils/process-fallback.js";
import { DEFAULT_WORKSPACE_ID, TEMP_WORKSPACE_ID, WorkspaceRegistry, type WorkspaceMeta } from "./workspace/workspace-registry.js";
import { WorkspaceReplica } from "./workspace/workspace-replica.js";
import type { RemoteContentSource } from "./content-source/index.js";
import { ContentHubCatalog } from "./content-source/catalog-service.js";
import { readAuthRuntimeConfig, readListenConfig } from "./auth/config.js";
import { assertSignUpAllowed, isPublicApiRequest, isTrustedOrigin, requireSession } from "./auth/http.js";
import { createAuthRuntime } from "./auth/runtime.js";
import { createBackgroundRequest, setRequestTenant } from "./tenants/http.js";
import { syncTenantConfigFromStore } from "./tenants/config.js";
import { forwardDurableTenantRequest, readDurableShardConfig } from "./tenants/durable-tenant-router.js";
import { resolveCurrentTenantDataRoot, resolveRequestTenantDataRoot } from "./tenants/paths.js";
import { getCurrentTenant, getCurrentTenantStore, runWithoutTenantContext } from "./tenants/current.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// bodyTimeout: 15 min safety net for LLM provider requests. Provider-level
// timeout (retry.provider.timeoutMs, default 10 min) should fire first; this
// ensures a hung connection can't live longer than 15 minutes even if the
// provider timeout fails to abort.
// headersTimeout: keep undici's 300s default so a provider that never sends
// response headers cannot leave the route waiting indefinitely.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 900_000, headersTimeout: 300_000 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
applyRuntimeEnvironment(paths);

const authConfig = readAuthRuntimeConfig(process.env);
const durableShardConfig = readDurableShardConfig(process.env);
const listenConfig = readListenConfig(process.env, authConfig.mode);
const auth = createAuthRuntime(authConfig);
await auth.checkConnection();

// Port is resolved from CLI / env only — config.json is read lazily.
const port = parsed.options.port
	?? (process.env.INNO_PORT ? Number.parseInt(process.env.INNO_PORT, 10) : undefined)
	?? 3000;

// Config is loaded on first API request, not at startup.
let config!: InnoConfig;

// ---------------------------------------------------------------------------
// Lazy bootstrap — directories, stores, channels, and agent session are
// deferred until the first meaningful web request (not /health or static files).
// Before that, no INNO_HOME subdirectories or files are created.
// ---------------------------------------------------------------------------

const dataDir = paths.dataDir;
const l2DataDir = paths.l2DataDir;
const skillsDir = paths.skillsDir;

// Authenticated tenants keep L2 wiki state in PostgreSQL + object storage
// (H3): wiki pages, logs and raw text go to l2_* tables; binary originals go
// to the configured ObjectStore. Local mode keeps the file backend.
let sharedObjectStore: ObjectStore | null = null;
const getSharedObjectStore = (): ObjectStore => {
	if (!sharedObjectStore) {
		sharedObjectStore = createObjectStore(normalizeObjectStorageConfig(config?.objectStorage));
	}
	return sharedObjectStore;
};
if (auth.tenantStore) {
	const l2Pool = auth.tenantStore.database;
	const tenantL2Root = resolve(dataDir, "tenants");
	setL2BackendResolver((resolvedDir) => {
		const parts = relative(tenantL2Root, resolvedDir).split(sep);
		if (parts.length !== 2 || parts[1] !== "l2") return null;
		const tenantId = parts[0];
		if (!tenantId || tenantId.startsWith(".")) return null;
		return new PgL2Backend(l2Pool, tenantId, getSharedObjectStore(), resolvedDir);
	});
}

// Workspace replication (H4): registry rows, session bindings and workspace
// file bytes mirror into PostgreSQL + object storage so a takeover worker can
// reconstruct a session's workspace. `memory` object storage is per-process
// and cannot carry state across workers — replication still runs (it keeps
// rows consistent for tests) but real deployments need "s3" or "fs". Created
// lazily next to the workspace registry it materializes into.
let workspaceReplica: WorkspaceReplica | null = null;

const contentHubCatalog = new ContentHubCatalog({
	dataDir,
	paths,
	skillsDir,
	getConfig: () => config,
});

// All stateful services are declared with !: — they are guaranteed to be
// initialised before any API handler that uses them runs, because the HTTP
// handler calls ensureBootstrapped() before dispatching.
let jobStore!: ScopedJobStore;
let checkInStore!: CheckInStore;
let channelRegistry!: ChannelRegistry;
let workspaceRegistry!: WorkspaceRegistry;
let feishuChannel: FeishuChannel | null = null;
let wechatChannel: WeChatChannel | null = null;
let dispatcher: PersonalChannelDispatcher | null = null;
let tenantChannelManager: TenantChannelManager | null = null;
let scheduler: CronScheduler | TenantCronScheduler | null = null;
let scheduledSessionFactory: ((job: ScheduledJob, request?: HttpReq) => Promise<CreatedJobSession | null>) | undefined;

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;
let bridgeToken: string | undefined;

/**
 * One-shot lazy bootstrap. Idempotent — concurrent requests while the first
 * bootstrap is still in-flight all await the same promise.
 */
async function ensureBootstrapped(): Promise<void> {
	if (bootstrapped) return;
	if (bootstrapPromise) return bootstrapPromise;

	bootstrapPromise = runWithoutTenantContext(async () => {
		logger.info("[inno-server] first meaningful request — bootstrapping...");

		// ---- config (loaded lazily, not at process start) ----
		config = loadConfig(paths.configPath);
		applyProviderProxyBypass(config);
		getSandboxManager(); // fail fast on a sandbox config that cannot work

		// ---- data directories ----
		ensureDir(paths.sessionDir);
		ensureDir(paths.jobsDir);
		ensureDir(paths.skillsDir);
		ensureDir(paths.workspaceDir);

		// ---- stores ----
		jobStore = new ScopedJobStore(dataDir, paths.jobsDir, config.scheduler?.timezone);
		jobStore.normalizePersistedJobs();
		checkInStore = new CheckInStore(() => resolveCurrentTenantDataRoot(dataDir), config.scheduler?.timezone, jobStore);

		channelRegistry = new ChannelRegistry(join(dataDir, "channels", "default-targets.json"));

		workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, dataDir);
		workspaceRegistry.ensureBootstrapped();
		if (auth.tenantStore) {
			workspaceReplica = new WorkspaceReplica(getSharedObjectStore(), auth.tenantStore, workspaceRegistry, join(dataDir, "workspaces", "replica"));
		}
		try {
			const sessionFiles = existsSync(paths.sessionDir)
				? readdirSync(paths.sessionDir).filter((f) => f.endsWith(".jsonl"))
				: [];
			workspaceRegistry.migrateUnboundSessions(sessionFiles, DEFAULT_WORKSPACE_ID);
		} catch (err) {
			logger.warn({ err }, "[sessions] unbound-session migration failed");
		}

		migrateLegacyPiSkills();

		// ---- channels ----
		function migrateReminderChannels(): void {
			const defaultFeishuTarget = channelRegistry.getDefaultTarget("feishu");
			if (!defaultFeishuTarget) return;
			for (const job of jobStore.list()) {
				if (job.taskType !== "push_reminder") continue;
				if (job.channel) continue;
				jobStore.update(job.id, {
					channel: "feishu",
					target: defaultFeishuTarget,
				});
			}
		}

		const runDurableChannelPrompt = (
			sessionId: string,
			prompt: string,
			onEvent?: StreamEventCallback,
			images?: ImageContent[],
		) => {
			const turnId = `channel-${randomUUID()}`;
			return runDurableJobPrompt(backgroundTenantRequest(), durableSessions, sessionId, prompt, {
				requestId: `channel-request-${randomUUID()}`,
				turnId,
				onEvent,
				images,
				noUi: true,
			});
		};
		const dispatcherOptions: Omit<PersonalChannelDispatcherOptions, "channelRegistry" | "channelsDataDir"> = {
			runPrompt: async () => { throw new Error("Channel prompts require an owned durable session"); },
			getCurrentSessionId: () => "",
			recordSessionChannel: (ch, sid?) => recordSessionChannel(ch as SessionChannel, sid, { setOriginIfEmpty: true }),
			onSessionCreated: async (sessionId, channel) => {
				const tenant = getCurrentTenant();
				if (tenant) {
					const store = getCurrentTenantStore();
					if (!store) throw new Error("Channel session creation requires a tenant store");
					const ws = workspaceRegistry.ensureChannelWorkspace(channel, tenant.tenantId);
					await store.claimResource(tenant, "workspace", ws.id);
					workspaceRegistry.bindSession(sessionId, ws.id);
					if (workspaceReplica) {
						await workspaceReplica.replicateWorkspace(tenant, ws);
						await workspaceReplica.setSessionBinding(tenant, sessionId, ws.id);
					}
					return;
				}
				try {
					const ws = workspaceRegistry.ensureChannelWorkspace(channel);
					workspaceRegistry.bindSession(sessionId, ws.id);
				} catch (err) {
					logger.warn({ err }, `[sessions] failed to bind channel session ${sessionId}`);
				}
			},
			sessionDir: join(dataDir, "sessions"),
			runPromptInSession: (sessionId, prompt, images) => runDurableChannelPrompt(sessionId, prompt, undefined, images),
			runPromptStreamingInSession: (sessionId, prompt, onEvent, images) => runDurableChannelPrompt(sessionId, prompt, onEvent, images),
			createNewSession: async (channel = "web") => {
				const tenant = getCurrentTenant();
				const store = getCurrentTenantStore();
				if (tenant && !store) throw new Error("Durable channel session creation requires a tenant store");
				const req = backgroundTenantRequest();
				const workspace = workspaceRegistry.ensureChannelWorkspace(channel, tenant?.tenantId);
				if (tenant) await store!.claimResource(tenant, "workspace", workspace.id);
				const summary = await durableSessions.create(req, { workspaceId: workspace.id });
				if (!workspaceRegistry.bindSession(summary.id, workspace.id)) throw new Error("Channel workspace not found");
				if (tenant && workspaceReplica) {
					await workspaceReplica.replicateWorkspace(tenant, workspace);
					await workspaceReplica.setSessionBinding(tenant, summary.id, workspace.id);
				}
				return summary.id;
			},
			resolveSessionTarget: async (sessionId) => await durableSessions.get(backgroundTenantRequest(), sessionId) ? sessionId : null,
		};

		if (auth.mode === "local") {
			if (config.feishu?.appId && config.channels?.feishu?.enabled) {
				feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
				channelRegistry.register(feishuChannel);
			}

			bridgeToken = config.bridge?.token;
			if (bridgeToken) {
				const qqConfig = config.channels?.qq as PersonalBridgeChannelConfig | undefined;
				if (qqConfig?.enabled && qqConfig.sidecarBaseUrl) {
					channelRegistry.register(new BridgeChannel("qq", qqConfig.sidecarBaseUrl, bridgeToken));
				}
				const wechatConfigBridge = config.channels?.wechat;
				if (wechatConfigBridge?.enabled && "sidecarBaseUrl" in wechatConfigBridge && (wechatConfigBridge as PersonalBridgeChannelConfig).mode === "bridge") {
					channelRegistry.register(new BridgeChannel("wechat", (wechatConfigBridge as PersonalBridgeChannelConfig).sidecarBaseUrl, bridgeToken));
				}
			}

			const wechatCfg = config.channels?.wechat;
			if (wechatCfg?.enabled && (!("mode" in wechatCfg) || (wechatCfg as { mode?: string }).mode !== "bridge")) {
				wechatChannel = new WeChatChannel(dataDir, wechatCfg);
				channelRegistry.register(wechatChannel);
			}
			migrateReminderChannels();
		} else {
			bridgeToken = undefined;
			tenantChannelManager = new TenantChannelManager({
				dataDir,
				tenantStore: auth.tenantStore!,
				dispatcher: dispatcherOptions,
				createChannels: ({ config: tenantConfig, channelsDataDir: tenantChannelsDir, registry, dispatch }) => {
					const tenantDataDir = dirname(tenantChannelsDir);
					let tenantFeishu: FeishuChannel | null = null;
					let tenantWechat: WeChatChannel | null = null;
					if (tenantConfig.feishu?.appId && tenantConfig.channels?.feishu?.enabled) {
						tenantFeishu = new FeishuChannel(tenantConfig.feishu, tenantDataDir, tenantConfig.channels.feishu);
						registry.register(tenantFeishu);
						tenantFeishu.onMessage((msg) => dispatch(tenantFeishu!, msg));
						tenantFeishu.start();
						if (!registry.getDefaultTarget("feishu")) {
							void tenantFeishu.discoverDefaultTarget().then((target) => {
								if (target) registry.setDefaultTarget(target);
							}).catch((err) => logger.warn({ err }, "[feishu] tenant target discovery failed"));
						}
					}
					const token = tenantConfig.bridge?.token;
					if (token) {
						const qq = tenantConfig.channels?.qq;
						if (qq?.enabled && qq.sidecarBaseUrl) registry.register(new BridgeChannel("qq", qq.sidecarBaseUrl, token));
						const wechat = tenantConfig.channels?.wechat;
						if (wechat?.enabled && "sidecarBaseUrl" in wechat && wechat.mode === "bridge") {
							registry.register(new BridgeChannel("wechat", wechat.sidecarBaseUrl, token));
						}
					}
					const wechatConfig = tenantConfig.channels?.wechat;
					if (wechatConfig?.enabled && (!("mode" in wechatConfig) || wechatConfig.mode !== "bridge")) {
						tenantWechat = new WeChatChannel(tenantDataDir, wechatConfig);
						registry.register(tenantWechat);
						tenantWechat.onMessage((msg) => dispatch(tenantWechat!, msg));
						tenantWechat.start();
					}
					return {
						wechatChannel: tenantWechat ?? undefined,
						stop: async () => {
							await tenantFeishu?.stop();
						},
					};
				},
			});
			channelRegistry = tenantChannelManager;
		}

		// ---- agent session ----
		// ---- post-init: dispatcher, channels, cron, WebSocket ----
		if (auth.mode === "local") {
			const channelsDataDir = join(dataDir, "channels");
			ensureDir(channelsDataDir);
			dispatcher = new PersonalChannelDispatcher({
				...dispatcherOptions,
				channelRegistry,
				channelsDataDir,
			});

			if (feishuChannel) {
				feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
				feishuChannel.start();

				// Auto-discover default target on first boot if none persisted
				if (!channelRegistry.getDefaultTarget("feishu")) {
					feishuChannel.discoverDefaultTarget().then((target) => {
						if (target) {
							channelRegistry.setDefaultTarget(target);
							logger.info({ chatId: target.chatId }, "[feishu] auto-set default target from chat list");
						}
					}).catch((err) => {
						logger.warn({ err }, "[feishu] initial target discovery failed");
					});
				}
			}
			if (wechatChannel) {
				wechatChannel.onMessage((msg) => dispatcher!.handle(wechatChannel!, msg));
				wechatChannel.start();
			}
		}

		async function createScheduledSession(job: ScheduledJob, request?: HttpReq): Promise<CreatedJobSession | null> {
			try {
				{
					const req = request ?? backgroundTenantRequest();
					const tenant = getCurrentTenant();
					const store = getCurrentTenantStore();
					if (tenant && !store) throw new Error("Scheduled session creation requires a tenant store");
					const ws = workspaceRegistry.ensureChannelWorkspace("scheduler", tenant?.tenantId);
					if (tenant) await store!.claimResource(tenant, "workspace", ws.id);
					const summary = await durableSessions.create(req, { workspaceId: ws.id, origin: "scheduler" });
					try {
						if (tenant) await store!.claimResource(tenant, "session", summary.id);
						if (!workspaceRegistry.bindSession(summary.id, ws.id)) throw new Error("Workspace not found");
						if (tenant && workspaceReplica) {
							await workspaceReplica.replicateWorkspace(tenant, ws);
							await workspaceReplica.setSessionBinding(tenant, summary.id, ws.id);
						}
						return { id: summary.id, runtime: "durable" };
					} catch (error) {
						await durableSessions.delete(req, summary.id).catch(() => undefined);
						workspaceRegistry.unbindSession(summary.id);
						if (tenant && workspaceReplica) await workspaceReplica.clearSessionBinding(tenant, summary.id).catch(() => undefined);
						if (tenant) await store!.releaseResource(tenant, "session", summary.id).catch(() => undefined);
						throw error;
					}
				}
			} catch (err) {
				logger.error({ err, jobId: job.id }, "scheduled run session creation failed");
				return null;
			}
		}

		scheduledSessionFactory = createScheduledSession;
		const durableExecutor: DurableJobExecutor = (execution) =>
			executeDurableJob(backgroundTenantRequest(), execution);

		configureDeferredRuns({
			jobStore,
			channelRegistry,
			checkInStore,
			createSession: createScheduledSession,
			durableExecutor,
			durableClaims: auth.mode === "better-auth",
		});
		if (auth.mode === "local") {
			scheduler = new CronScheduler(jobStore, channelRegistry, checkInStore, {
				createSession: createScheduledSession,
				durableExecutor,
			});
		} else {
			scheduler = new TenantCronScheduler(auth.tenantStore!, jobStore, channelRegistry, checkInStore, {
				createSession: createScheduledSession,
				durableExecutor,
			});
		}
		scheduler.start();

		logger.info({ channels: auth.mode === "local" ? channelRegistry.all().map((c) => c.name).join(", ") || "none" : "tenant-scoped" }, "[inno-server] channels");
		logger.info({ jobCount: jobStore.list().length }, "[inno-server] jobs loaded");

		bootstrapped = true;
		logger.info("[inno-server] bootstrap complete");
		// Simple Mode cards and the remote skill library are warmed in the
		// background. Never make the first meaningful API response wait on GitHub.
		void contentHubCatalog.warm();
	}).catch((err) => {
		logger.error({ err }, "[inno-server] bootstrap failed");
		bootstrapPromise = null; // allow retry on next request
		throw err;
	});

	return bootstrapPromise;
}

// ---------------------------------------------------------------------------
// Channel hot-reload
// ---------------------------------------------------------------------------

/**
 * Stop the current Feishu channel (if any) and reinitialize it from the
 * current in-memory config. Called after PUT /api/settings/channels so that
 * new credentials take effect without a server restart.
 */
async function reloadFeishuChannel(): Promise<void> {
	if (tenantChannelManager) {
		await tenantChannelManager.reloadCurrent();
		return;
	}
	// Tear down existing instance
	channelRegistry.unregister("feishu");
	if (feishuChannel) {
		try { await feishuChannel.stop(); } catch { /* best effort */ }
		feishuChannel = null;
	}

	// If feishu is now configured and enabled, create a new instance
	if (!config.feishu?.appId || !config.channels?.feishu?.enabled) {
		logger.info("[feishu] channel disabled or not configured, skipping reload");
		return;
	}

	feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
	channelRegistry.register(feishuChannel);

	if (dispatcher) {
		feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
	}
	feishuChannel.start();
	logger.info("[feishu] channel hot-reloaded with new credentials");

	// Auto-discover default target if none exists yet (fixes first-time setup
	// chicken-and-egg: user had to send FROM Feishu before agent could send TO it)
	if (!channelRegistry.getDefaultTarget("feishu")) {
		const target = await feishuChannel.discoverDefaultTarget();
		if (target) {
			channelRegistry.setDefaultTarget(target);
			logger.info({ chatId: target.chatId }, "[feishu] auto-set default target from chat list");
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static file serving (web/dist/)
// ---------------------------------------------------------------------------

const webDistDir = paths.webDistDir;

// ---------------------------------------------------------------------------
// Local data helpers
// ---------------------------------------------------------------------------

function parseSkillFrontmatter(content: string): Record<string, string | boolean> {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};
	const fm: Record<string, string | boolean> = {};
	for (const line of match[1].split("\n")) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		const raw = kv[2].trim();
		if (kv[1] in fm) continue; // 保留第一个值（标准YAML行为）
		fm[kv[1]] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^["']|["']$/g, "");
	}
	return fm;
}

function ensureSkillDocument(content: string, fallbackName: string): { name: string; content: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const frontmatter = parseSkillFrontmatter(normalized);
	const name = slugifySkillName(typeof frontmatter.name === "string" ? frontmatter.name : fallbackName);
	const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
		? frontmatter.description.trim()
		: `Project skill uploaded for ${name}. Use when the user's task matches this skill package.`;

	if (normalized.startsWith("---\n")) {
		return { name, content: normalized };
	}

	return {
		name,
		content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${normalized.trim()}\n`,
	};
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
	ensureDir(targetDir);
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX" || entry.name === ".DS_Store") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			cpSync(source, target, { recursive: true });
		} else if (entry.isFile()) {
			cpSync(source, target);
		}
	}
}

function findSkillFile(dir: string): string | null {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX") continue;
		const fullPath = join(dir, entry.name);
		if (entry.isFile() && entry.name === "SKILL.md") return fullPath;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
		const fullPath = join(dir, entry.name);
		if (!entry.isDirectory()) continue;
		const nested = findSkillFile(fullPath);
		if (nested) return nested;
	}
	return null;
}

function validateZipEntries(zipPath: string): void {
	if (process.platform === "win32") {
		// Windows: list zip entries via .NET ZipFile API (no system unzip).
		const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
			`$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); ` +
			`try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`;
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "Unable to inspect zip file");
		}
		for (const rawLine of result.stdout.split(/\r?\n/)) {
			const entry = rawLine.trim();
			if (!entry) continue;
			if (entry.startsWith("/") || entry.startsWith("\\") || entry.includes("..")) {
				throw new Error(`Unsafe zip entry path: ${entry}`);
			}
		}
		return;
	}
	const result = spawnSync("/usr/bin/unzip", ["-Z1", zipPath], { encoding: "utf-8" });
	if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "Unable to inspect zip file");
	}
	for (const rawLine of result.stdout.split("\n")) {
		const entry = rawLine.trim();
		if (!entry) continue;
		if (entry.startsWith("/") || entry.includes("..") || entry.includes("\\")) {
			throw new Error(`Unsafe zip entry path: ${entry}`);
		}
	}
}

function installSkillZip(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const fallbackName = slugifySkillName(basename(fileName, extname(fileName)));
	const tempRoot = join(tmpdir(), `inno-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, `${fallbackName}.zip`);
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	writeFileSync(zipPath, data);

	try {
		validateZipEntries(zipPath);
		if (process.platform === "win32") {
			// Windows: extract via .NET ZipFile.ExtractToDirectory (no system unzip).
			const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
				`[System.IO.Compression.ZipFile]::ExtractToDirectory(` +
				`'${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`;
			const unzipResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip skill package");
			}
		} else {
			const unzipResult = spawnSync("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", extractDir], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip skill package");
			}
		}

		return installSkillFromExtractedDir(extractDir, fallbackName, targetRoot);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

/**
 * Install a skill from an already-extracted directory: locate the SKILL.md,
 * normalize its frontmatter, and copy the package into the skills directory.
 * Shared by zip upload and skill-library import.
 */
function installSkillFromExtractedDir(extractDir: string, fallbackName: string, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skillFile = findSkillFile(extractDir);
	if (!skillFile) {
		throw new Error("Skill package must contain a SKILL.md file");
	}
	const skillRoot = dirname(skillFile);
	const skill = ensureSkillDocument(readText(skillFile), fallbackName);
	const targetDir = join(targetRoot, skill.name);
	rmSync(targetDir, { recursive: true, force: true });
	copyDirectoryContents(skillRoot, targetDir);
	writeText(join(targetDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(targetDir, "SKILL.md") };
}

function installSkillMarkdown(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skill = ensureSkillDocument(data.toString("utf-8"), basename(fileName, extname(fileName)));
	const skillDir = join(targetRoot, skill.name);
	rmSync(skillDir, { recursive: true, force: true });
	ensureDir(skillDir);
	writeText(join(skillDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(skillDir, "SKILL.md") };
}

// ---------------------------------------------------------------------------
// Workspace zip import
// ---------------------------------------------------------------------------

/** Entries that are archive noise, not workspace content. */
function isImportNoise(name: string): boolean {
	return name === "__MACOSX" || name === ".DS_Store" || name.startsWith("._");
}

/**
 * Locate the actual content root inside an extracted workspace archive:
 * a single top-level folder (the common "folder zipped by Finder" shape) or
 * the extract dir itself when files sit at the archive root. Returns null
 * when the archive has no importable content.
 */
function findWorkspaceContentRoot(extractDir: string): string | null {
	const entries = readdirSync(extractDir, { withFileTypes: true })
		.filter((entry) => !isImportNoise(entry.name));
	if (entries.length === 0) return null;
	if (entries.length === 1 && entries[0].isDirectory()) {
		const nested = join(extractDir, entries[0].name);
		const inner = readdirSync(nested, { withFileTypes: true })
			.filter((entry) => !isImportNoise(entry.name));
		return inner.length > 0 ? nested : null;
	}
	return extractDir;
}

/**
 * Recursively copy imported content into the new workspace directory.
 * File-by-file (not cpSync) to skip noise files cleanly. `preset.json` is
 * hub metadata, not content — it only contributes the default workspace
 * name and is not copied.
 */
function copyWorkspaceImportContents(sourceDir: string, targetDir: string): void {
	ensureDir(targetDir);
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (isImportNoise(entry.name) || entry.name === "preset.json") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			copyWorkspaceImportContents(source, target);
		} else if (entry.isFile()) {
			writeFileSync(target, readFileSync(source));
		}
	}
}

/**
 * Import a workspace from a zip archive (e.g. an exported preset workspace
 * bundle). Extraction reuses the skill-zip validation (no absolute paths or
 * `..` entries), then a fresh workspace is created and seeded with the
 * archive's content. Workspace name precedence: explicit `name` →
 * `preset.json` name → top-level folder name → zip file name.
 */
function importWorkspaceZip(fileName: string, data: Buffer, name?: string): WorkspaceMeta {
	const fallbackName = basename(fileName, extname(fileName)).trim() || "导入的工作区";
	const tempRoot = join(tmpdir(), `inno-ws-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, "workspace.zip");
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	writeFileSync(zipPath, data);

	try {
		validateZipEntries(zipPath);
		if (process.platform === "win32") {
			const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
				`[System.IO.Compression.ZipFile]::ExtractToDirectory(` +
				`'${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`;
			const unzipResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip workspace archive");
			}
		} else {
			const unzipResult = spawnSync("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", extractDir], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip workspace archive");
			}
		}

		const contentRoot = findWorkspaceContentRoot(extractDir);
		if (!contentRoot) {
			throw new Error("The archive does not contain any importable files");
		}

		// A bundled preset.json contributes the default display name.
		let presetName = "";
		const presetJsonPath = join(contentRoot, "preset.json");
		if (existsSync(presetJsonPath) && statSync(presetJsonPath).isFile()) {
			try {
				const meta = JSON.parse(readFileSync(presetJsonPath, "utf-8")) as { name?: unknown };
				if (typeof meta.name === "string") presetName = meta.name.trim();
			} catch {
				// Malformed preset.json is ignored — it is optional metadata.
			}
		}

		const wsName = name?.trim()
			|| presetName
			|| (contentRoot !== extractDir ? basename(contentRoot).trim() : "")
			|| fallbackName;
		const ws = workspaceRegistry.createWorkspace({ name: wsName });
		const destDir = workspaceRegistry.resolveWorkspaceDir(ws.id);
		if (!destDir) {
			throw new Error(`Failed to resolve workspace dir for ${ws.id}`);
		}
		copyWorkspaceImportContents(contentRoot, destDir);
		logger.info({ workspaceId: ws.id, fileName }, "imported workspace from zip archive");
		return ws;
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Remote content hub (skill library + preset workspaces)
//
// Backed by a RemoteContentSource (GitHub repo by default, or a self-hosted
// bundle service). The source is created lazily from config.contentHub and
// recreated whenever the hub config changes, so settings edits take effect
// without a restart.
// ---------------------------------------------------------------------------
/** Get (or rebuild) the content source for the current config.contentHub. */
function getContentSource(): RemoteContentSource {
	return contentHubCatalog.getSource();
}

/** Drop the source so the next call rebuilds it (and its cache) from config. */
function invalidateContentSource(): void {
	contentHubCatalog.invalidate();
}

function listSkillLibrary(forceRefresh = false) {
	return contentHubCatalog.listSkillLibrary(forceRefresh);
}

function listPresetLibrary(forceRefresh = false) {
	return contentHubCatalog.listPresetLibrary(forceRefresh);
}

/**
 * Import a skill from the remote library into the global skills directory.
 * Downloads the item's files into a temp dir, then installs through the same
 * path as a zip upload (validates SKILL.md, normalizes frontmatter).
 */
async function importSkillFromLibrary(skillName: string): Promise<{ name: string; filePath: string }> {
	const source = getContentSource();
	const tempRoot = join(tmpdir(), `inno-libskill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	try {
		await source.downloadItem("skills", skillName, extractDir);
		return installSkillFromExtractedDir(extractDir, slugifySkillName(skillName), skillsDir);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function migrateLegacyPiSkills(): void {
	const legacySkillsDir = join(paths.workspaceDir, ".pi", "skills");
	if (!existsSync(legacySkillsDir)) return;
	ensureDir(skillsDir);
	for (const entry of readdirSync(legacySkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const legacySkillDir = join(legacySkillsDir, entry.name);
		const legacySkillFile = join(legacySkillDir, "SKILL.md");
		if (!existsSync(legacySkillFile)) continue;
		const content = readText(legacySkillFile);
		const skill = ensureSkillDocument(content, entry.name);
		const targetDir = join(skillsDir, skill.name);
		if (!existsSync(targetDir)) {
			ensureDir(targetDir);
			cpSync(legacySkillDir, targetDir, { recursive: true });
			writeText(join(targetDir, "SKILL.md"), skill.content);
		}
	}
}

interface SkillRegistry {
	disabled: string[];
}

function skillRegistryPath(): string {
	return join(paths.configDir, "skills.json");
}

function readSkillRegistry(): SkillRegistry {
	const registry = readJson<Partial<SkillRegistry>>(skillRegistryPath(), {});
	return {
		disabled: Array.isArray(registry.disabled)
			? registry.disabled.filter((item): item is string => typeof item === "string")
			: [],
	};
}

function writeSkillRegistry(registry: SkillRegistry): void {
	ensureDir(paths.configDir);
	writeJson(skillRegistryPath(), registry);
}

function disabledSkillNames(): Set<string> {
	return new Set(readSkillRegistry().disabled);
}

function setSkillEnabled(name: string, enabled: boolean): void {
	const registry = readSkillRegistry();
	const disabled = new Set(registry.disabled);
	if (enabled) {
		disabled.delete(name);
	} else {
		disabled.add(name);
	}
	writeSkillRegistry({ disabled: Array.from(disabled).sort() });
	writeDisabledSkillsIgnoreFile(disabled);
}

function writeDisabledSkillsIgnoreFile(disabled: Set<string>): void {
	const lines = Array.from(disabled)
		.sort()
		.map((name) => `${name}/`);
	writeText(join(skillsDir, ".ignore"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function listProjectSkills(): unknown[] {
	ensureDir(skillsDir);
	const disabled = disabledSkillNames();
	const loaded = loadSkillsFromDir(skillsDir);
	const loadedByPath = new Map(loaded.skills.map((skill) => [resolve(skill.filePath), skill]));
	const diagnosticsByPath = new Map<string, string[]>();
	for (const diagnostic of loaded.diagnostics) {
		if (!diagnostic.path) continue;
		const diagnosticPath = resolve(diagnostic.path);
		const list = diagnosticsByPath.get(diagnosticPath) ?? [];
		list.push(diagnostic.message);
		diagnosticsByPath.set(diagnosticPath, list);
	}

	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const name = entry.name;
			const filePath = join(skillsDir, name, "SKILL.md");
			const content = existsSync(filePath) ? readText(filePath) : "";
			const stat = existsSync(filePath) ? statSync(filePath) : statSync(join(skillsDir, name));
			const loadedSkill = loadedByPath.get(resolve(filePath));
			const fields = extractFrontmatterFields(content);
			return {
				name,
				description: fields.description,
				category: fields.category || undefined,
				enabled: !disabled.has(name),
				loaded: Boolean(loadedSkill),
				filePath: relative(paths.workspaceDir, filePath),
				size: existsSync(filePath) ? stat.size : 0,
				updatedAt: stat.mtime.toISOString(),
				diagnostics: diagnosticsByPath.get(resolve(filePath)) ?? [],
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Refresh the agent's in-memory skills in the background.
 *
 * Skill listings (`listProjectSkills`) read from disk, so callers can respond
 * immediately without waiting for the agent runtime to reload. Awaiting the
 * reload inside a request handler could block the HTTP response indefinitely
 * (the reload is serialized behind the agent prompt queue), which left the
 * upload UI stuck on "uploading". Fire-and-forget keeps the request snappy.
 */
function scheduleSkillsReload(): void {
	// Durable sessions list the shared skills when their runtime opens, so there
	// is no process-wide skill cache to refresh. Open sessions pick up changes
	// the next time they are reopened.
}

function sessionChannelMetadataPath(): string {
	return join(resolveCurrentTenantDataRoot(dataDir), "sessions", "channels.json");
}

function readSessionChannelMetadata(): SessionChannelMetadata {
	return readJson<SessionChannelMetadata>(sessionChannelMetadataPath(), {});
}

function recordSessionChannel(
	channel: SessionChannel,
	explicitSessionId?: string,
	options?: { setOriginIfEmpty?: boolean },
): void {
	const id = explicitSessionId;
	if (!id) return;
	const metadata = readSessionChannelMetadata();
	const prev = metadata[id];
	metadata[id] = {
		channels: mergeChannels(prev?.channels ?? [], [channel]),
		// origin is the immutable birthplace of the session: set once and never
		// overwritten. Interaction tagging (e.g. a web session pushing a file to
		// feishu) must NOT change origin, so it omits setOriginIfEmpty.
		origin: prev?.origin ?? (options?.setOriginIfEmpty ? channel : undefined),
		updatedAt: new Date().toISOString(),
	};
	writeJson(sessionChannelMetadataPath(), metadata);
}

/**
 * A manual "run now" job always happens in a conversation created for it, so
 * the session's birthplace IS the scheduler. Override the "web" origin that
 * POST /api/sessions stamped at creation time so the sidebar can badge it.
 */
async function recordJobRunSession(sessionId: string, req?: HttpReq): Promise<void> {
	if (!sessionId) return;
	if (req && await durableSessions.get(req, sessionId)) {
		await durableSessions.markSchedulerOrigin(req, sessionId);
		return;
	}
	const metadata = readSessionChannelMetadata();
	const prev = metadata[sessionId];
	metadata[sessionId] = {
		channels: mergeChannels(prev?.channels ?? [], ["scheduler"]),
		origin: "scheduler",
		updatedAt: new Date().toISOString(),
	};
	writeJson(sessionChannelMetadataPath(), metadata);
}

/**
 * Auto-generate a topic for a session if it doesn't already have one.
 * Runs asynchronously — fire and forget.
 *
 * Two passes, both guarded by `_pendingAutoTopics`:
 * 1. First pass: no topic recorded yet and ≥2 messages (the first exchange).
 *    Persist the user's first-message preview immediately so the UI never
 *    shows a model-generated placeholder or a session-file id.
 * 2. Upgrade pass: the existing preview is auto-generated (never a manual
 *    rename), hasn't been upgraded yet, and the conversation has grown to
 *    TOPIC_UPGRADE_MESSAGE_THRESHOLD messages — generate a richer summary
 *    once there is enough context.
 */
// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

// Platform-level sandbox, built on first use because the config is loaded lazily.
let sandboxManager: SandboxManager | null | undefined;
function getSandboxManager(): SandboxManager | undefined {
	if (sandboxManager === undefined) {
		const sandboxConfig = normalizeSandboxConfig(config?.sandbox);
		sandboxManager = sandboxConfig.enabled
			? createSandboxManager(sandboxConfig, auth.tenantStore ? new PgSandboxQuotaStore(auth.tenantStore.database) : undefined)
			: null;
		if (sandboxManager) console.log(`[inno-server] sandbox enabled (${sandboxConfig.provider}, approval: ${sandboxConfig.requireApproval})`);
	}
	return sandboxManager ?? undefined;
}

const durableSessions = new DurableSessionService({
	dataDir,
	getLocalConfig: () => config,
	enabled: true,
	resolveWorkspaceDir: (sessionId, fallbackWorkspaceId) => workspaceRegistry.resolveWorkspaceDir(
		workspaceRegistry.getSessionWorkspaceId(sessionId) || fallbackWorkspaceId,
	) ?? undefined,
	getChannelRegistry: () => channelRegistry,
	skillsDir,
	getSchedulerTools: () => createSchedulerTools(jobStore, channelRegistry, checkInStore, {
		// "Run this job now" from a conversation: give the run a durable session of its own.
		runJob: async (job) => {
			const created = await scheduledSessionFactory?.(job);
			if (!created || typeof created === "string" || created.runtime !== "durable") {
				throw new Error("Could not create a session for the scheduled job");
			}
			return executeJob(job, jobStore, channelRegistry, "manual", checkInStore, {
				sessionId: created.id,
				sessionRuntime: "durable",
				durableExecutor: (execution) => executeDurableJob(backgroundTenantRequest(), execution),
			});
		},
	}),
	tenantStore: auth.tenantStore,
	getSandboxManager,
	...(auth.tenantStore ? {
		recoveryPool: auth.tenantStore.database,
		pgCatalog: new PgSessionCatalog(auth.tenantStore.database, (req) => join(resolveRequestTenantDataRoot(req, dataDir), "durable", "sessions.json")),
	} : {}),
	workspaceReplica: {
		materializeSession: (tenant, sessionId, catalogWorkspaceId) =>
			workspaceReplica
				? workspaceReplica.materializeSessionWorkspace(tenant, sessionId, catalogWorkspaceId)
				: Promise.resolve(catalogWorkspaceId || TEMP_WORKSPACE_ID),
		pull: async (tenant, workspaceId, dir) => { await workspaceReplica?.pull(tenant, workspaceId, dir); },
		push: async (tenant, workspaceId, dir) => { await workspaceReplica?.push(tenant, workspaceId, dir); },
	},
});

const activeDurableJobTurns = new Map<string, string>();

function backgroundTenantRequest(): HttpReq {
	const tenant = getCurrentTenant();
	if (!tenant) return createBackgroundRequest();
	const store = getCurrentTenantStore();
	if (!store) throw new Error("Background durable execution requires a tenant store");
	return createBackgroundRequest(tenant, store);
}

async function executeDurableJob(req: HttpReq, execution: DurableJobExecution): Promise<string> {
	// A reminder is recorded as a notice in the run's conversation; no model turn.
	if (execution.notifyOnly) {
		await durableSessions.appendAssistantNotification(req, execution.sessionId, execution.prompt, execution.requestId, { busyWaitMs: DURABLE_JOB_BUSY_WAIT_MS });
		return execution.prompt;
	}
	if (activeDurableJobTurns.has(execution.sessionId)) {
		throw new Error("Durable session already has an active job run");
	}
	activeDurableJobTurns.set(execution.sessionId, execution.turnId);
	try {
		return await runDurableJobPrompt(req, durableSessions, execution.sessionId, execution.prompt, execution);
	} finally {
		if (activeDurableJobTurns.get(execution.sessionId) === execution.turnId) {
			activeDurableJobTurns.delete(execution.sessionId);
		}
	}
}

const { dispatch: dispatchRoutes } = createRouteDispatcher({
	// --- Check-ins API ---
	checkins: (req, res, method, url) => handleCheckInsRoutes(req, res, method, url, { checkInStore, tenantStore: auth.tenantStore }),

	// --- Jobs CRUD (extracted to server/routes/jobs.ts) ---
	jobs: (req, res, method, url) => handleJobsRoutes(req, res, method, url, {
		jobStore,
		channelRegistry,
		checkInStore,
		resolveSession: async (sessionId) => await durableSessions.get(req, sessionId) ? { id: sessionId, runtime: "durable" } : null,
		createSession: async (request, job) => scheduledSessionFactory?.(job, request) ?? null,
		durableExecutor: executeDurableJob,
		disconnectJobRun: (sessionId, turnId) => {
			if (activeDurableJobTurns.get(sessionId) === turnId) {
				void Promise.all([
					durableSessions.cancelPermissionTurn(req, sessionId, turnId),
					durableSessions.cancelQuestionTurn(req, sessionId, turnId),
				]).catch((error) => logger.warn({ err: error, sessionId, turnId }, "cancelling a disconnected job run's pending prompts failed"));
			}
		},
		recordJobRunSession,
		tenantStore: auth.tenantStore,
		abortJobRun: async (sessionId) => {
			const durableTurnId = activeDurableJobTurns.get(sessionId);
			if (!durableTurnId || !await durableSessions.get(req, sessionId)) return false;
			await durableSessions.abort(req, sessionId, durableTurnId);
			return true;
		},
	}),

	// --- Channels + bridge (extracted to server/routes/channels.ts) ---
	channels: (req, res, method, url) => handleChannelsRoutes(req, res, method, url, {
		channelRegistry,
		dataDir,
		configPath: paths.configPath,
		getConfig: () => config,
		setConfig: (next) => { config = next; },
		getDispatcher: () => tenantChannelManager ?? dispatcher,
		getBridgeToken: () => bridgeToken,
		handleBridge: auth.mode === "better-auth" ? async (authHeader, body) => {
			const manager = tenantChannelManager!;
			const token = bridgeBearerToken(authHeader);
			const result = await manager.runWithBridgeToken(token, () => handleBridgeMessage({
				token,
				channelRegistry: manager,
				dispatcher: manager,
				requireChatId: true,
			}, authHeader, body));
			return result ?? { status: 401, body: { ok: false as const, error: "Unauthorized" } };
		} : undefined,
		reloadFeishuChannel,
		getWechatChannel: () => tenantChannelManager ? tenantChannelManager.getWechatChannel() : wechatChannel,
		setWechatChannel: (channel) => {
			if (tenantChannelManager) tenantChannelManager.setWechatChannel(channel);
			else wechatChannel = channel;
		},
		startWechatChannel: auth.mode === "better-auth"
			? (channel) => tenantChannelManager!.startWechatChannel(channel)
			: undefined,
		syncChannelOwnership: auth.mode === "better-auth"
			? (previous, next) => tenantChannelManager!.syncOwnership(previous, next)
			: undefined,
		beginFeishuRegistration: auth.mode === "better-auth" ? () => tenantChannelManager!.beginFeishuRegistration() : undefined,
		pollFeishuRegistration: auth.mode === "better-auth" ? (deviceCode) => tenantChannelManager!.pollFeishuRegistration(deviceCode) : undefined,
		trackWechatQr: auth.mode === "better-auth" ? (qrId) => tenantChannelManager!.trackWechatQr(qrId) : undefined,
		assertWechatQr: auth.mode === "better-auth" ? (qrId) => tenantChannelManager!.assertWechatQr(qrId) : undefined,
		confirmWechatLogin: auth.mode === "better-auth"
			? (qrId, botId, confirm) => tenantChannelManager!.confirmWechatLogin(qrId, botId, confirm)
			: undefined,
	}),

	// --- Skills API ---
	skills: (req, res, method, url) => handleSkillsRoutes(req, res, method, url, {
		skillsDir,
		sharedSkillsReadOnly: auth.mode === "better-auth",
		scheduleSkillsReload,
		listProjectSkills,
		setSkillEnabled,
		installSkillZip,
		installSkillMarkdown,
		listSkillLibrary,
		importSkillFromLibrary,
	}),

	// --- Sessions API (extracted to server/routes/sessions.ts) ---
	sessions: (req, res, method, url) => handleSessionsRoutes(req, res, method, url, {
		workspaceRegistry, paths, getContentSource, tenantStore: auth.tenantStore, durableSessions,
		workspaceReplica,
		getCachedPresetAvailability: (presetId) => contentHubCatalog.getCachedPresetAvailability(presetId),
	}),

	// --- Wiki + L2 raw upload API (extracted to server/routes/wiki.ts) ---
	wiki: (req, res, method, url) => handleWikiRoutes(req, res, method, url, { l2DataDir, dataDir }),


	// --- Workspace API + registry + session binding (extracted to server/routes/workspaces.ts) ---
	workspaces: (req, res, method, url) => handleWorkspacesRoutes(req, res, method, url, {
		workspaceRegistry, dataDir, paths, tenantStore: auth.tenantStore,
		installSkillZip, installSkillMarkdown, scheduleSkillsReload, importWorkspaceZip, durableSessions,
		workspaceReplica,
	}),

	// --- Presets API (extracted to server/routes/presets.ts) ---
	presets: (req, res, method, url) => handlePresetsRoutes(req, res, method, url, { paths, listPresetLibrary }),

	// --- Settings API (extracted to server/routes/settings.ts) ---
	settings: (req, res, method, url) => handleSettingsRoutes(req, res, method, url, {
		paths,
		getConfig: () => config,
		setConfig: (next) => { config = next; },
		reloadFeishuChannel,
		syncChannelOwnership: auth.mode === "better-auth"
			? (previous, next) => tenantChannelManager!.syncOwnership(previous, next)
			: undefined,
		scheduleSkillsReload,
		invalidateContentSource,
		invalidateSandbox: () => { sandboxManager = undefined; },
	}),

	// --- Btw side-question API (extracted to server/routes/btw.ts) ---
	btw: (req, res, method, url) => handleBtwRoutes(req, res, method, url, {
		dataDir, tenantStore: auth.tenantStore,
		durableSessions,
	}),

	// --- Chat API (extracted to server/routes/chat.ts) ---
	chat: (req, res, method, url) => handleChatRoutes(req, res, method, url, {
		workspaceRegistry, tenantStore: auth.tenantStore, durableSessions,
	}),
});

const requestIdSymbol = Symbol("requestId");
const server = createServer(async (req, response) => {
	const startedAt = performance.now();
	const requestId = randomUUID();
	const res = Object.assign(response, { [requestIdSymbol]: requestId });
	res.setHeader("x-request-id", requestId);
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	const path = url.split("?", 1)[0];
	const logLevel = path.startsWith("/api/") && path !== "/api/health" ? "info" : "debug";

	// Defensive only: response stream errors must have a listener.
	res.once("error", (err) => logger.debug({ err, requestId }, "HTTP response stream error"));
	let accessLogged = false;
	const logAccess = () => {
		// Normal responses emit close after finish; disconnected SSE may only emit close.
		if (accessLogged) return;
		accessLogged = true;
		logger[logLevel]({
			method,
			path,
			statusCode: res.statusCode,
			durationMs: Math.round(performance.now() - startedAt),
			requestId,
			outcome: res.writableFinished ? "finished" : "disconnected",
		}, "HTTP request");
	};
	res.once("finish", logAccess);
	res.once("close", logAccess);

	try {
		// --- Health check (no bootstrap needed) ---
		if (method === "GET" && (url === "/health" || url === "/api/health")) {
			json(res, 200, { status: "ok" });
			return;
		}

		// Process metrics for local scraping only: counters expose tenant-agnostic
		// totals, but there is no auth here, so non-loopback callers get 404.
		if (method === "GET" && path === "/metrics") {
			const remote = req.socket.remoteAddress ?? "";
			if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
				json(res, 404, { error: "Not found" });
				return;
			}
			res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
			res.end(renderPrometheus());
			return;
		}

		// Better Auth must receive the untouched request body and must not
		// initialize the agent just to sign in or register.
		if (path === "/api/auth" || path.startsWith("/api/auth/")) {
			assertSignUpAllowed(auth, method, path);
			await auth.handle(req, res);
			return;
		}
		if (method === "GET" && path === "/api/session") {
			const session = await auth.getSession(req);
			json(res, 200, {
				mode: auth.mode,
				allowSignUp: auth.allowSignUp,
				durableEnabled: durableSessions.enabled,
				durableRequired: true,
				user: session?.principal ?? null,
			});
			return;
		}

		if (path.startsWith("/api/") && !isPublicApiRequest(method, path)) {
			if (auth.mode === "better-auth" && !isTrustedOrigin(req.headers.origin, authConfig)) {
				throw new HttpError(403, "Untrusted request origin");
			}
			const session = await requireSession(req, res, auth);
			if (auth.mode === "better-auth" && !session) return;
			if (session && auth.tenantStore) {
				const tenant = await auth.tenantStore.ensurePersonalTenant(session.principal.userId);
				if (durableShardConfig) {
					const routedReq = await forwardDurableTenantRequest(req, res, tenant, durableShardConfig,
						(sessionId) => auth.tenantStore!.durableSessionRouteHint(tenant, sessionId));
					if (!routedReq) return;
					req = routedReq;
				}
				setRequestTenant(req, tenant, auth.tenantStore);
				// Materialise the authoritative tenant config so this worker can
				// serve tenant-scoped reads after taking over from another worker.
				await syncTenantConfigFromStore(auth.tenantStore, dataDir, tenant.tenantId);
			}
		}

		// Public sidecar callbacks have no cookie. Recover their tenant only from
		// PostgreSQL token ownership, then forward the untouched body to the same
		// durable owner before bootstrapping any local channel runtime. The owner
		// repeats the bearer-token and ownership checks in the normal bridge route.
		if (durableShardConfig && auth.tenantStore && method === "POST" && path === "/api/bridge/messages") {
			const token = bridgeBearerToken(req.headers.authorization);
			const tenant = token
				? await auth.tenantStore.findResourceOwner("channel", bridgeChannelResourceId(token))
				: null;
			if (tenant && !(await forwardDurableTenantRequest(req, res, tenant, durableShardConfig))) return;
		}

		// --- Lazy bootstrap on first API request ---
		// All /api/* endpoints need the agent session and data stores.
		// Static files and SPA fallback skip this so no directories are
		// created until the user actually interacts with the web UI.
		if (url.startsWith("/api/")) {
			await ensureBootstrapped();
		}

		if (await dispatchRoutes(req, res, method, url)) return;

		// --- Static files / SPA fallback ---
		if (method === "GET" || method === "HEAD") {
			const urlPath = decodeURIComponent(url.split("?")[0]);
			const staticPath = safeJoinReal(webDistDir, urlPath.replace(/^\/+/, ""));
			const sendBody = method === "GET";
			// Try exact file in web/dist
			if (staticPath && await serveStatic(req, res, staticPath, sendBody, webDistDir)) return;
			// Never route an asset miss through the SPA fallback. Returning
			// index.html with a 200 status for a stale hashed JS/CSS URL makes the
			// browser report an opaque dynamic-import failure instead of exposing
			// the real missing asset and prevents a panel retry from recovering.
			const isAssetRequest = urlPath === "/assets" || urlPath.startsWith("/assets/");
			// SPA fallback: serve index.html for non-API, non-asset paths only. An
			// unmatched /api/* route must fall through to the JSON 404 — returning
			// HTML with a 200 status breaks API client error handling.
			if (!isAssetRequest && urlPath !== "/api" && !urlPath.startsWith("/api/") && await serveStatic(req, res, join(webDistDir, "index.html"), sendBody, webDistDir)) return;
		}

		// --- 404 ---
		json(res, 404, { error: "Not found" });
	} catch (err) {
		logger.error({ err, requestId }, "unhandled error in HTTP handler");
		// SSE/streaming responses have already sent headers — calling json()
		// here would throw ERR_HTTP_HEADERS_SENT from inside this catch block
		// and kill the process. The only safe move is to end the stream.
		if (res.headersSent) {
			try { res.end(); } catch { /* best effort */ }
			return;
		}
		// readBody failures carry a client-facing status (400/413); anything
		// else is an internal error and must not leak details.
		if (err instanceof HttpError) {
			if (err.statusCode === 413) {
				// The oversized body was never consumed, so this connection is
				// unsafe for keep-alive — Node closes it after the response.
				res.setHeader("Connection", "close");
			}
			json(res, err.statusCode, { error: err.message });
			return;
		}
		json(res, 500, { error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// Start listening immediately — /health and static files work right away.
// All other endpoints call ensureBootstrapped() lazily on first request.
// ---------------------------------------------------------------------------

// Process-level last resort: a stray rejection or an exception escaping a
// catch block would otherwise kill the process silently (or via a secondary
// ERR_HTTP_HEADERS_SENT from the catch-all). Log at fatal level, close the
// HTTP/WS servers so clients see a clean close, then exit — after an
// uncaught exception the process state is untrustworthy, so we do not
// attempt to continue serving.
installProcessFallbacks({
	onFatal: () => {
		try { server.close(); } catch { /* best effort */ }
	},
});

const gracefulShutdown = createGracefulShutdownHandler({
	server,
	exit: (code) => process.exit(code),
	onClose: async () => {
		scheduler?.stop();
		await closeDeferredRuns();
		await durableSessions.close();
		await tenantChannelManager?.close();
		await auth.close();
	},
});
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

server.listen(port, listenConfig.host, () => {
	console.log(`[inno-server] listening on http://${listenConfig.host}:${port}`);
	console.log(`[inno-server] config: ${paths.configPath}`);
	// Report-only orphan audit; repair is an explicit offline step (durable-fsck).
	setImmediate(async () => {
		try {
			const pool = auth.tenantStore?.database;
			const audits = await auditDurableData(paths.dataDir, pool ? {
				knownIds: async (tenantId) => new Set((await pool.query<{ id: string }>(
					"SELECT id FROM durable_sessions WHERE tenant_id = $1", [tenantId])).rows.map((row) => row.id)),
			} : {});
			for (const audit of audits) {
				if (audit.error) logger.warn({ owner: audit.owner, error: audit.error }, "durable data audit failed");
				else if (audit.orphans.length) {
					logger.warn({ owner: audit.owner, orphans: audit.orphans.map((o) => o.sessionId) },
						"orphaned durable session data found; run `npm run durable:fsck -- --repair` to remove it");
				}
			}
		} catch (err) {
			logger.warn({ err }, "durable data audit crashed");
		}
	});
});
