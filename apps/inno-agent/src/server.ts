// Register source-map-support so that compiled JS stack traces and
// pino-caller call sites map back to the original TS source locations.
import "source-map-support/register.js";

import { PgSessionCatalog } from "./agent/pg-session-catalog.js";
import { createSandboxManager } from "./sandbox/index.js";
import { LocalExecManager } from "./sandbox/local-exec-manager.js";
import { PgSandboxQuotaStore } from "./sandbox/pg-sandbox-quota.js";
import type { SandboxBindingProvider } from "./sandbox/sandbox-session.js";
import { renderPrometheus } from "./utils/metrics.js";
import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { loadConfig, normalizeSandboxConfig, readLoggingDir, type InnoConfig } from "./config.js";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { ensureDir, readJson, readText, writeJson, writeText } from "./storage/file-store.js";
import { closeDeferredRuns, configureDeferredRuns } from "./scheduler/deferred-runs.js";
import { DurableSessionBusyError, DurableSessionService } from "./agent/durable-session-service.js";
import { DURABLE_JOB_BUSY_WAIT_MS, runDurableJobPrompt } from "./agent/durable-job-runner.js";
import { executeJob, type CreatedJobSession, type DurableJobExecution, type DurableJobExecutor } from "./scheduler/job-runner.js";
import type { ScheduledJob } from "./scheduler/types.js";
import { ChannelRegistry } from "./channels/channel.js";
import { FeishuChannel } from "./channels/feishu/feishu-channel.js";
import type { PersonalChannelDispatcherOptions, StreamEventCallback } from "./channels/personal-dispatcher.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { channelChatResourceId, channelUserResourceId, TenantChannelManager } from "./channels/tenant-channel-manager.js";
import { bridgeBearerToken, handleBridgeMessage } from "./channels/bridge/bridge-server.js";
import { BridgeChannel } from "./channels/bridge/bridge-channel.js";
import { WeChatChannel } from "./channels/wechat/wechat-channel.js";
import type { TokenData, WechatTokenPersistence } from "./channels/wechat/ilink-client.js";
import { PgJobStore, type JobStore } from "./scheduler/job-store.js";
import { TenantJsonLedger, TenantStateStore } from "./tenants/state-store.js";
import { PgCheckInStore, type CheckInStore } from "./checkins/check-in-store.js";
import { TenantCronScheduler } from "./scheduler/tenant-cron-scheduler.js";
import { HttpError, json, readBody } from "./server/http-helpers.js";
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
import { createObjectStore, isDurableObjectStorageProvider, normalizeObjectStorageConfig, type ObjectStore } from "./object-store/index.js";
import { handlePresetsRoutes } from "./server/routes/presets.js";
import { readPresetAgentMd, resolvePresetMeta } from "./presets/preset-store.js";
import { loadSkillsFromDir } from "./agent/skills.js";
import { SkillCatalogStore, type TenantSkillListing } from "./skills/catalog-store.js";
import { buildCatalogSkillsSection } from "./skills/materialize.js";
import { publishSkillsFromRoot } from "./skills/publish.js";
import type { CatalogSkillListing } from "./server/routes/skills.js";
import { createSchedulerTools } from "./scheduler/scheduler-tools.js";
import { handleChatRoutes } from "./server/routes/chat.js";
import { handleBtwRoutes } from "./server/routes/btw.js";
import {
} from "./server/session-model.js";
import { configureLogging, logger } from "./logger.js";
import { VIRTUAL_TENANT_ROOT } from "./tenants/paths.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { createGracefulShutdownHandler, installProcessFallbacks } from "./utils/process-fallback.js";
import { TEMP_WORKSPACE_ID, WorkspaceRegistry, type WorkspaceMeta } from "./workspace/workspace-registry.js";
import { WorkspaceReplica } from "./workspace/workspace-replica.js";
import { LocalFsWorkspaceStore } from "./workspace/local-fs-workspace-store.js";
import { ObjectWorkspaceStore } from "./workspace/object-workspace-store.js";
import type { WorkspaceStore } from "./workspace/workspace-store.js";
import type { RemoteContentSource } from "./content-source/index.js";
import { ContentHubCatalog } from "./content-source/catalog-service.js";
import { readAuthRuntimeConfig, readListenConfig } from "./auth/config.js";
import { assertSignUpAllowed, isPublicApiRequest, isTrustedOrigin, requireSession } from "./auth/http.js";
import { createAuthRuntime } from "./auth/runtime.js";
import { createBackgroundRequest, requireRequestTenant, setRequestTenant } from "./tenants/http.js";
import type { TenantContext } from "./tenants/store.js";
import { bufferBody, forwardDurableTenantRequest, readDurableShardConfig, replayBodyRequest } from "./tenants/durable-tenant-router.js";
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
configureLogging({ dir: readLoggingDir(paths.configPath) });

const authConfig = readAuthRuntimeConfig(process.env);
const durableShardConfig = readDurableShardConfig(process.env);
const listenConfig = readListenConfig(process.env);
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

const dataDir = VIRTUAL_TENANT_ROOT;
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

let skillCatalogStore: SkillCatalogStore | null = null;
const getSkillCatalog = (): SkillCatalogStore => {
	if (!skillCatalogStore) {
		skillCatalogStore = new SkillCatalogStore(auth.tenantStore.database);
	}
	return skillCatalogStore;
};

function toCatalogSkillListing(row: TenantSkillListing): CatalogSkillListing {
	return {
		name: row.name,
		description: row.description,
		enabled: row.enabled,
		loaded: row.enabled,
		filePath: `catalog:${row.skillId}@${row.version}`,
		size: 0,
		updatedAt: row.publishedAt,
		diagnostics: [],
		skillId: row.skillId,
		version: row.version,
		disableModelInvocation: row.disableModelInvocation,
		source: row.source,
		publishedAt: row.publishedAt,
	};
}

/** Publish image-baked skills into object store + catalog, then opt tenants in. */
async function seedSkillCatalogFromImage(): Promise<void> {
	try {
		const results = await publishSkillsFromRoot({
			objects: getSharedObjectStore(),
			catalog: getSkillCatalog(),
			skillsRoot: skillsDir,
			source: "image-seed",
		});
		const enabled = await getSkillCatalog().enableAllForAllTenants();
		if (results.length > 0 || enabled > 0) {
			logger.info({ published: results.length, tenantSkillRows: enabled }, "skill catalog seed complete");
		}
	} catch (err) {
		logger.warn({ err }, "skill catalog seed failed");
	}
}
/**
 * The in-memory object store loses all bytes on restart, so manifest-backed
 * reads would list files whose objects are gone forever. Only s3/fs providers
 * may back the workspace-panel read path; "memory" keeps the old disk reads.
 */
const objectStorageIsDurable = (): boolean =>
	isDurableObjectStorageProvider(normalizeObjectStorageConfig(config?.objectStorage).provider);
/**
 * Per-request workspace store: manifest + object store for authenticated
 * tenants on durable object storage; the local filesystem otherwise. Shared
 * by the workspace routes and the durable session service (T1.4).
 */
const workspaceStoreForRequest = (request: HttpReq): WorkspaceStore => {
	const tenant = requireRequestTenant(request);
	if (objectStorageIsDurable()) {
		return new ObjectWorkspaceStore({ objects: getSharedObjectStore(), store: auth.tenantStore, context: tenant });
	}
	// memory provider: bytes die with the process — the local dir stays
	// the source of truth even for authenticated requests.
	return new LocalFsWorkspaceStore({ resolveRoot: (id) => workspaceRegistry.resolveWorkspaceDir(id) });
};
{
	const l2Pool = auth.tenantStore.database;
	const tenantL2Root = resolve(dataDir, "tenants");
	setL2BackendResolver((resolvedDir) => {
		const parts = relative(tenantL2Root, resolvedDir).split(sep);
		if (parts.length !== 2 || parts[1] !== "l2") return null;
		const tenantId = parts[0];
		if (!tenantId || tenantId.startsWith(".")) return null;
		return new PgL2Backend(l2Pool, tenantId, getSharedObjectStore());
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
	paths,
	skillsDir,
	getConfig: () => config,
});

// All stateful services are declared with !: — they are guaranteed to be
// initialised before any API handler that uses them runs, because the HTTP
// handler calls ensureBootstrapped() before dispatching.
let jobStore!: JobStore;
let tenantStateStore: TenantStateStore | undefined;
let checkInStore!: CheckInStore;
let channelRegistry!: ChannelRegistry;
let workspaceRegistry!: WorkspaceRegistry;
let tenantChannelManager: TenantChannelManager | null = null;
let scheduler: TenantCronScheduler | null = null;
let scheduledSessionFactory: ((job: ScheduledJob, request?: HttpReq) => Promise<CreatedJobSession | null>) | undefined;

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;

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
		ensureDir(paths.skillsDir);
		ensureDir(paths.workspaceDir);

		// ---- stores ----
		jobStore = new PgJobStore(auth.tenantStore.database, config.scheduler?.timezone);
		tenantStateStore = new TenantStateStore(auth.tenantStore.database);
		await jobStore.normalizePersistedJobs();
		checkInStore = new PgCheckInStore(auth.tenantStore.database, config.scheduler?.timezone, jobStore);

		channelRegistry = new ChannelRegistry();

		workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir);
		workspaceRegistry.ensureBootstrapped();
		{
			workspaceReplica = new WorkspaceReplica(getSharedObjectStore(), auth.tenantStore, workspaceRegistry);
			if (!objectStorageIsDurable()) {
				logger.warn("object storage is in-memory: workspace panel reads this worker's disk; not safe for takeover");
			}
		}
		migrateLegacyPiSkills();
		await seedSkillCatalogFromImage();

		// ---- channels ----

		const runDurableChannelPrompt = (
			sessionId: string,
			prompt: string,
			onEvent?: StreamEventCallback,
			images?: ImageContent[],
		) => {
			const turnId = `channel-${randomUUID()}`;
			const tenant = getCurrentTenant();
			return runDurableJobPrompt(backgroundTenantRequest(), durableSessions, sessionId, prompt, {
				requestId: `channel-request-${randomUUID()}`,
				turnId,
				onEvent,
				images,
				noUi: true,
				...(tenant ? { forwardToOwner: (payload: InternalPromptPayload) => forwardJobToOwner(tenant, payload) } : {}),
			});
		};
		const dispatcherOptions: Omit<PersonalChannelDispatcherOptions, "channelRegistry" | "channelsDataDir"> = {
			runPrompt: async () => { throw new Error("Channel prompts require an owned durable session"); },
			getCurrentSessionId: () => "",
			onSessionCreated: async (sessionId, channel) => {
				const tenant = getCurrentTenant();
				const store = getCurrentTenantStore();
				if (!tenant || !store) throw new Error("Channel session creation requires a tenant context");
				const ws = workspaceRegistry.ensureChannelWorkspace(channel, tenant.tenantId);
				await store.claimResource(tenant, "workspace", ws.id);
				workspaceRegistry.bindSession(sessionId, ws.id);
				if (workspaceReplica) {
					await workspaceReplica.replicateWorkspace(tenant, ws);
					await workspaceReplica.setSessionBinding(tenant, sessionId, ws.id);
				}
			},
			runPromptInSession: (sessionId, prompt, images) => runDurableChannelPrompt(sessionId, prompt, undefined, images),
			runPromptStreamingInSession: (sessionId, prompt, onEvent, images) => runDurableChannelPrompt(sessionId, prompt, onEvent, images),
			createNewSession: async (channel = "web") => {
				const tenant = getCurrentTenant();
				const store = getCurrentTenantStore();
				if (!tenant || !store) throw new Error("Durable channel session creation requires a tenant context");
				const req = backgroundTenantRequest();
				const workspace = workspaceRegistry.ensureChannelWorkspace(channel, tenant.tenantId);
				await store.claimResource(tenant, "workspace", workspace.id);
				const summary = await durableSessions.create(req, { workspaceId: workspace.id });
				if (!workspaceRegistry.bindSession(summary.id, workspace.id)) throw new Error("Channel workspace not found");
				if (workspaceReplica) {
					await workspaceReplica.replicateWorkspace(tenant, workspace);
					await workspaceReplica.setSessionBinding(tenant, summary.id, workspace.id);
				}
				return summary.id;
			},
			resolveSessionTarget: async (sessionId) => await durableSessions.get(backgroundTenantRequest(), sessionId) ? sessionId : null,
		};

		{
			tenantChannelManager = new TenantChannelManager({
				tenantStore: auth.tenantStore,
				getLocalConfig: () => config,
				dispatcher: dispatcherOptions,
				createChannels: ({ config: tenantConfig, registry, dispatch, wechatTokenPersistence }) => {
					let tenantFeishu: FeishuChannel | null = null;
					let tenantWechat: WeChatChannel | null = null;
					if (tenantConfig.feishu?.appId && tenantConfig.channels?.feishu?.enabled) {
						tenantFeishu = new FeishuChannel(tenantConfig.feishu, tenantConfig.channels.feishu);
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
						tenantWechat = new WeChatChannel(wechatTokenPersistence!, wechatConfig);
						registry.register(tenantWechat);
						tenantWechat.onMessage((msg) => dispatch(tenantWechat!, msg));
						void tenantWechat.start().catch((err) => logger.error({ err }, "[wechat] failed to start channel"));
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
		// ---- post-init: cron, WebSocket ----

		async function createScheduledSession(job: ScheduledJob, request?: HttpReq): Promise<CreatedJobSession | null> {
			try {
				{
					const req = request ?? backgroundTenantRequest();
					const tenant = getCurrentTenant();
					const store = getCurrentTenantStore();
					if (!tenant || !store) throw new Error("Scheduled session creation requires a tenant context");
					const ws = workspaceRegistry.ensureChannelWorkspace("scheduler", tenant.tenantId);
					await store.claimResource(tenant, "workspace", ws.id);
					const summary = await durableSessions.create(req, { workspaceId: ws.id, origin: "scheduler" });
					try {
						await store.claimResource(tenant, "session", summary.id);
						if (!workspaceRegistry.bindSession(summary.id, ws.id)) throw new Error("Workspace not found");
						if (workspaceReplica) {
							await workspaceReplica.replicateWorkspace(tenant, ws);
							await workspaceReplica.setSessionBinding(tenant, summary.id, ws.id);
						}
						return { id: summary.id, runtime: "durable" };
					} catch (error) {
						await durableSessions.delete(req, summary.id).catch(() => undefined);
						workspaceRegistry.unbindSession(summary.id);
						if (workspaceReplica) await workspaceReplica.clearSessionBinding(tenant, summary.id).catch(() => undefined);
						await store.releaseResource(tenant, "session", summary.id).catch(() => undefined);
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
			durableClaims: true,
		});
		scheduler = new TenantCronScheduler(auth.tenantStore, jobStore, channelRegistry, checkInStore, {
			createSession: createScheduledSession,
			durableExecutor,
		});
		scheduler.start();

		logger.info("[inno-server] tenant-scoped channels");
		logger.info({ jobCount: (await jobStore.normalizePersistedJobs()).length }, "[inno-server] jobs loaded");

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

/** Reload the current tenant's Feishu channel after PUT /api/settings/channels
 * so new credentials take effect without a server restart. */
async function reloadFeishuChannel(): Promise<void> {
	await tenantChannelManager?.reloadCurrent();
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

/** Ambient-tenant state ledger shared by channel runtimes. */
function tenantState(): TenantStateStore {
	if (!tenantStateStore) throw new Error("tenant state store is not initialized");
	return tenantStateStore;
}

/**
 * WeChat iLink token persistence backed by `tenant_state`: a worker restart on
 * another host keeps the logged-in iLink session.
 */
function wechatTokenPersistence(): WechatTokenPersistence {
	const ledger = new TenantJsonLedger<TokenData>(tenantState(), "wechat-token");
	let cached: TokenData | undefined;
	return {
		read: () => cached,
		write: (data) => {
			cached = data;
			void ledger.save(data).catch((err) => logger.error({ err }, "[wechat] failed to persist token"));
		},
		hydrate: async () => {
			cached = await ledger.load();
		},
	};
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
	// The session does not exist on this worker (sharded deployment): the
	// owner worker applies the scheduler origin when it claims the run.
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
// Without a remote sandbox, INNO_EXEC_BACKEND=local runs every tool — bash
// included — on this worker inside the session's workspace directory
// (roadmap H5 phase 1); any other value keeps the workspace-file-only env.
let sandboxManager: SandboxBindingProvider | null | undefined;
function getSandboxManager(): SandboxBindingProvider | undefined {
	if (sandboxManager === undefined) {
		const sandboxConfig = normalizeSandboxConfig(config?.sandbox);
		sandboxManager = sandboxConfig.enabled
			? createSandboxManager(sandboxConfig, new PgSandboxQuotaStore(auth.tenantStore.database))
			: process.env.INNO_EXEC_BACKEND === "local"
				? new LocalExecManager({
					...(workspaceReplica ? { replica: workspaceReplica } : {}),
					maxConcurrent: Math.max(0, Number(process.env.INNO_EXEC_LOCAL_MAX_CONCURRENT) || 0),
				})
				: null;
		if (sandboxManager) console.log(`[inno-server] ${sandboxConfig.enabled ? `sandbox enabled (${sandboxConfig.provider}, approval: ${sandboxConfig.requireApproval})` : "local execution backend enabled (bash runs on this worker)"}`);
	}
	return sandboxManager ?? undefined;
}

const durableSessions = new DurableSessionService({
	dataDir,
	getStateKv: () => tenantStateStore,
	getLocalConfig: () => config,
	enabled: true,
	resolveWorkspaceDir: (sessionId, fallbackWorkspaceId) => workspaceRegistry.resolveWorkspaceDir(
		workspaceRegistry.getSessionWorkspaceId(sessionId) || fallbackWorkspaceId,
	) ?? undefined,
	getChannelRegistry: () => channelRegistry,
	skillsDir,
	resolveCatalogSkillsSection: async ({ tenant, workspaceDir, extraSkillIds }) => {
		try {
			const catalog = getSkillCatalog();
			const enabled = await catalog.listEnabledForTenant(tenant.tenantId);
			const byId = new Map(enabled.map((row) => [row.skillId, row]));
			for (const skillId of extraSkillIds ?? []) {
				if (byId.has(skillId)) continue;
				const row = await catalog.get(skillId);
				if (row) byId.set(skillId, row);
				else logger.warn({ skillId, tenantId: tenant.tenantId }, "preset-bound skill missing from catalog");
			}
			const skills = [...byId.values()];
			if (skills.length === 0) return undefined;
			return await buildCatalogSkillsSection({
				objects: getSharedObjectStore(),
				skills,
				workspaceDir,
			});
		} catch (err) {
			logger.warn({ err, tenantId: tenant.tenantId }, "catalog skills section failed; falling back to skillsDir");
			return undefined;
		}
	},
	resolvePresetAgentSection: (presetId) => readPresetAgentMd(paths, presetId),
	resolvePresetSkillIds: (presetId) => {
		try {
			return resolvePresetMeta(paths, presetId).skills;
		} catch {
			return [];
		}
	},
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
	workspaceStoreFor: workspaceStoreForRequest,
	recoveryPool: auth.tenantStore.database,
	objectStore: getSharedObjectStore(),
	pgCatalog: new PgSessionCatalog(auth.tenantStore.database),
	workspaceReplica: {
		materializeSession: (tenant, sessionId, catalogWorkspaceId, options) =>
			workspaceReplica
				? workspaceReplica.materializeSessionWorkspace(tenant, sessionId, catalogWorkspaceId, options)
				: Promise.resolve(catalogWorkspaceId || TEMP_WORKSPACE_ID),
		pull: async (tenant, workspaceId, dir, options) => { await workspaceReplica?.pull(tenant, workspaceId, dir, options); },
		materializeFile: async (tenant, workspaceId, dir, relPath) =>
			workspaceReplica ? workspaceReplica.materializeFile(tenant, workspaceId, dir, relPath) : false,
		push: async (tenant, workspaceId, dir) => { await workspaceReplica?.push(tenant, workspaceId, dir); },
	},
});

const activeDurableJobTurns = new Map<string, string>();

// Worker-to-worker internal prompt forwarding: when a session's lease is held
// by another worker past the busy wait, internal prompts (scheduler jobs,
// channel inbound) are handed to the owner over POST /api/internal/durable-prompt
// authenticated by the shared INNO_WORKER_TOKEN. Without the token the endpoint
// is 404 and forwarding is off — the busy error propagates exactly as before.
const workerToken = process.env.INNO_WORKER_TOKEN?.trim() ?? "";
const INTERNAL_FORWARD_TIMEOUT_MS = 600_000;
const INTERNAL_PROMPT_PATH = "/api/internal/durable-prompt";

interface InternalPromptPayload {
	sessionId: string;
	prompt: string;
	requestId: string;
	turnId: string;
	notifyOnly?: boolean;
}

/** Forward an internal prompt to the worker recorded as the session owner. */
async function forwardJobToOwner(tenant: TenantContext, execution: InternalPromptPayload): Promise<string | null> {
	if (!workerToken || !durableShardConfig) return null;
	const hint = await auth.tenantStore.durableSessionRouteHint(tenant, execution.sessionId);
	const owner = hint.owner ?? hint.affinity;
	if (!owner || owner === durableShardConfig.localShardId) return null;
	const base = durableShardConfig.targets[owner];
	if (!base) return null;
	try {
		const response = await fetch(new URL(INTERNAL_PROMPT_PATH, base), {
			method: "POST",
			headers: { "content-type": "application/json", "x-inno-worker-token": workerToken },
			body: JSON.stringify(execution),
			// The remote turn runs to completion inside this request; the timeout
			// must exceed the longest expected job turn.
			signal: AbortSignal.timeout(INTERNAL_FORWARD_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const data = await response.json() as { text?: unknown };
		return typeof data.text === "string" ? data.text : null;
	} catch {
		return null;
	}
}

/** Execute a forwarded internal prompt on the owner worker (no re-forward). */
async function handleInternalDurablePrompt(req: HttpReq, res: ServerResponse): Promise<void> {
	const presented = typeof req.headers["x-inno-worker-token"] === "string" ? req.headers["x-inno-worker-token"] : "";
	const authenticated = Boolean(workerToken)
		&& presented.length === workerToken.length
		&& timingSafeEqual(Buffer.from(presented), Buffer.from(workerToken));
	if (!authenticated) { json(res, 404, { error: "Not found" }); return; }
	await ensureBootstrapped();
	const body = await readBody(req) as Record<string, unknown>;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	const prompt = typeof body.prompt === "string" ? body.prompt : "";
	if (!sessionId || !prompt) { json(res, 400, { error: "sessionId and prompt are required" }); return; }
	const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : `internal-${randomUUID()}`;
	const turnId = typeof body.turnId === "string" && body.turnId ? body.turnId : `internal-${randomUUID()}`;
	// The tenant comes from the session's own catalog row, never from the body;
	// tenant_memberships joins need the owning user, taken from the tenant row.
	const row = await auth.tenantStore.database.query<{ tenant_id: string; owner_user_id: string }>(
		`SELECT sessions.tenant_id, tenants.owner_user_id
		 FROM durable_sessions sessions JOIN tenants ON tenants.id = sessions.tenant_id
		 WHERE sessions.id = $1`, [sessionId]);
	const found = row.rows[0];
	if (!found) { json(res, 404, { error: "Session not found" }); return; }
	const breq = createBackgroundRequest({ tenantId: found.tenant_id, userId: found.owner_user_id, role: "owner" }, auth.tenantStore);
	// Internal prompts bypass the cookie gate where tenant config is normally
	// materialised — sync it here so the tenant's model/provider config exists.
	try {
		if (body.notifyOnly === true) {
			await durableSessions.appendAssistantNotification(breq, sessionId, prompt, requestId, { busyWaitMs: DURABLE_JOB_BUSY_WAIT_MS });
			json(res, 200, { text: prompt });
			return;
		}
		const text = await runDurableJobPrompt(breq, durableSessions, sessionId, prompt, {
			requestId, turnId, noUi: true, busyWaitMs: DURABLE_JOB_BUSY_WAIT_MS,
		});
		json(res, 200, { text });
	} catch (error) {
		if (error instanceof DurableSessionBusyError) { json(res, 409, { error: "Session is busy" }); return; }
		logger.error({ err: error, sessionId }, "internal durable prompt failed");
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

function backgroundTenantRequest(): HttpReq {
	const tenant = getCurrentTenant();
	if (!tenant) throw new Error("Background durable execution requires a tenant context");
	const store = getCurrentTenantStore();
	if (!store) throw new Error("Background durable execution requires a tenant store");
	return createBackgroundRequest(tenant, store);
}

async function executeDurableJob(req: HttpReq, execution: DurableJobExecution): Promise<string> {
	const tenant = requireRequestTenant(req);
	const forward = (payload: InternalPromptPayload) => forwardJobToOwner(tenant, payload);
	// A reminder is recorded as a notice in the run's conversation; no model turn.
	if (execution.notifyOnly) {
		try {
			await durableSessions.appendAssistantNotification(req, execution.sessionId, execution.prompt, execution.requestId, { busyWaitMs: DURABLE_JOB_BUSY_WAIT_MS });
		} catch (error) {
			if (forward && error instanceof DurableSessionBusyError) {
				const text = await forward({ ...execution, notifyOnly: true });
				if (text !== null) return text;
			}
			throw error;
		}
		return execution.prompt;
	}
	if (activeDurableJobTurns.has(execution.sessionId)) {
		throw new Error("Durable session already has an active job run");
	}
	activeDurableJobTurns.set(execution.sessionId, execution.turnId);
	try {
		return await runDurableJobPrompt(req, durableSessions, execution.sessionId, execution.prompt, {
			...execution,
			...(forward ? { forwardToOwner: forward } : {}),
		});
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
		configPath: paths.configPath,
		getConfig: () => config,
		setConfig: (next) => { config = next; },
		getDispatcher: () => tenantChannelManager,
		getBridgeToken: () => undefined,
		handleBridge: async (authHeader, body) => {
			const manager = tenantChannelManager!;
			const token = bridgeBearerToken(authHeader);
			const msg = body as { channel?: string; chatId?: string; userId?: string };
			const result = await manager.runWithBridgeMessage(token, msg,
				() => handleBridgeMessage({
					token,
					channelRegistry: manager,
					dispatcher: manager,
					requireChatId: true,
				}, authHeader, body));
			if (result !== null) return result;
			if (!manager.hasBridgeToken(token)) {
				return { status: 401, body: { ok: false as const, error: "Unauthorized" } };
			}
			// Valid sidecar token but no tenant claims this chat/user identity:
			// still run the body validation so malformed messages get their 400,
			// then reject the unroutable (well-formed) message.
			const validated = handleBridgeMessage({
				token,
				channelRegistry: manager,
				dispatcher: { handle: async () => {} },
				requireChatId: true,
			}, authHeader, body);
			if (validated.status !== 200) return validated;
			return { status: 401, body: { ok: false as const, error: "No tenant claims this channel identity" } };
		},
		reloadFeishuChannel,
		ensureChannelsReady: () => tenantChannelManager!.ready(),
		getWechatChannel: () => tenantChannelManager!.getWechatChannel(),
		setWechatChannel: (channel) => tenantChannelManager!.setWechatChannel(channel),
		startWechatChannel: (channel) => tenantChannelManager!.startWechatChannel(channel),
		wechatTokenPersistence: () => wechatTokenPersistence(),
		syncChannelOwnership: (previous, next) => tenantChannelManager!.syncOwnership(previous, next),
		beginFeishuRegistration: () => tenantChannelManager!.beginFeishuRegistration(),
		pollFeishuRegistration: (deviceCode) => tenantChannelManager!.pollFeishuRegistration(deviceCode),
		trackWechatQr: (qrId) => tenantChannelManager!.trackWechatQr(qrId),
		assertWechatQr: (qrId) => tenantChannelManager!.assertWechatQr(qrId),
		confirmWechatLogin: (qrId, botId, confirm) => tenantChannelManager!.confirmWechatLogin(qrId, botId, confirm),
	}),

	// --- Skills API ---
	skills: (req, res, method, url) => handleSkillsRoutes(req, res, method, url, {
		skillsDir,
		sharedSkillsReadOnly: true,
		catalog: {
			listForTenant: async () => {
				const tenant = requireRequestTenant(req);
				const rows = await getSkillCatalog().listForTenant(tenant.tenantId);
				return rows.map(toCatalogSkillListing);
			},
			setEnabled: async (skillId, enabled) => {
				const tenant = requireRequestTenant(req);
				const row = await getSkillCatalog().setEnabled(tenant.tenantId, skillId, enabled);
				return row ? toCatalogSkillListing(row) : null;
			},
			enableIfPublished: async (skillId) => {
				const tenant = requireRequestTenant(req);
				const existing = await getSkillCatalog().get(skillId);
				if (!existing) return null;
				const row = await getSkillCatalog().setEnabled(tenant.tenantId, skillId, true);
				return row ? toCatalogSkillListing(row) : null;
			},
		},
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
		workspaceRegistry, paths, tenantStore: auth.tenantStore, durableSessions,
		workspaceReplica, objectStorageDurable: objectStorageIsDurable(),
	}),

	// --- Wiki + L2 raw upload API (extracted to server/routes/wiki.ts) ---
	wiki: (req, res, method, url) => handleWikiRoutes(req, res, method, url, { dataDir }),


	// --- Workspace API + registry + session binding (extracted to server/routes/workspaces.ts) ---
	workspaces: (req, res, method, url) => handleWorkspacesRoutes(req, res, method, url, {
		workspaceRegistry, stateKv: tenantState(), paths, tenantStore: auth.tenantStore,
		installSkillZip, installSkillMarkdown, scheduleSkillsReload, importWorkspaceZip, durableSessions,
		workspaceReplica,
		// Read routes serve from the manifest + object store in authenticated
		// mode; local mode (and any test without a tenant) uses the filesystem.
		workspaceStoreFor: workspaceStoreForRequest,
		objects: getSharedObjectStore,
	}),

	// --- Presets API (extracted to server/routes/presets.ts) ---
	presets: (req, res, method, url) => handlePresetsRoutes(req, res, method, url, { paths }),

	// --- Settings API (extracted to server/routes/settings.ts) ---
	settings: (req, res, method, url) => handleSettingsRoutes(req, res, method, url, {
		paths,
		getConfig: () => config,
		setConfig: (next) => { config = next; },
		reloadFeishuChannel,
		syncChannelOwnership: (previous, next) => tenantChannelManager!.syncOwnership(previous, next),
		scheduleSkillsReload,
		invalidateContentSource,
		invalidateSandbox: () => { sandboxManager = undefined; },
	}),

	// --- Btw side-question API (extracted to server/routes/btw.ts) ---
	btw: (req, res, method, url) => handleBtwRoutes(req, res, method, url, {
		stateKv: tenantState(), tenantStore: auth.tenantStore,
		durableSessions,
	}),

	// --- Chat API (extracted to server/routes/chat.ts) ---
	chat: (req, res, method, url) => handleChatRoutes(req, res, method, url, {
		workspaceRegistry, tenantStore: auth.tenantStore, durableSessions,
		workspaceReplica, objectStorageDurable: objectStorageIsDurable(),
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
				mode: "better-auth",
				allowSignUp: auth.allowSignUp,
				durableEnabled: durableSessions.enabled,
				durableRequired: true,
				user: session?.principal ?? null,
			});
			return;
		}

		// Worker-to-worker prompt forwarding: token-authenticated, deliberately
		// outside the cookie gate and the durable shard forwarder (it is already
		// running on the intended owner; a busy session answers 409).
		if (method === "POST" && path === INTERNAL_PROMPT_PATH) {
			await handleInternalDurablePrompt(req, res);
			return;
		}

		if (path.startsWith("/api/") && !isPublicApiRequest(method, path)) {
			if (!isTrustedOrigin(req.headers.origin, authConfig)) {
				throw new HttpError(403, "Untrusted request origin");
			}
			const session = await requireSession(req, res, auth);
			if (!session) return;
			const tenant = await auth.tenantStore.ensurePersonalTenant(session.principal.userId);
			await getSkillCatalog().enableAllForTenant(tenant.tenantId).catch((err) => {
				logger.warn({ err, tenantId: tenant.tenantId }, "failed to opt tenant into skill catalog");
			});
			if (durableShardConfig) {
				const routedReq = await forwardDurableTenantRequest(req, res, tenant, durableShardConfig,
					(sessionId) => auth.tenantStore.durableSessionRouteHint(tenant, sessionId));
				if (!routedReq) return;
				req = routedReq;
			}
			setRequestTenant(req, tenant, auth.tenantStore);
			// Materialise the authoritative tenant config so this worker can
			// serve tenant-scoped reads after taking over from another worker.
			}

		// Public sidecar callbacks have no cookie. Recover their tenant only from
		// PostgreSQL token ownership, then forward the untouched body to the same
		// durable owner before bootstrapping any local channel runtime. The owner
		// repeats the bearer-token and ownership checks in the normal bridge route.
		if (durableShardConfig && method === "POST" && path === "/api/bridge/messages") {
			// The bridge token is shared; the owning tenant is resolved from the
			// claimed chat/user identity inside the buffered message body.
			const buffered = await bufferBody(req);
			let msg: { channel?: string; chatId?: string; userId?: string } = {};
			try { msg = JSON.parse(buffered.toString("utf8")) as typeof msg; } catch { /* handled downstream */ }
			const channel = typeof msg.channel === "string" ? msg.channel : "";
			const ids = [
				typeof msg.chatId === "string" && msg.chatId ? channelChatResourceId(channel, msg.chatId) : null,
				typeof msg.userId === "string" && msg.userId ? channelUserResourceId(channel, msg.userId) : null,
			].filter((id): id is string => Boolean(id));
			let tenant: Awaited<ReturnType<typeof auth.tenantStore.findResourceOwner>> = null;
			for (const id of ids) {
				tenant = await auth.tenantStore.findResourceOwner("channel", id);
				if (tenant) break;
			}
			req = replayBodyRequest(req, buffered);
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
});
