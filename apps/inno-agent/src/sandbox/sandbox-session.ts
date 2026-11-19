import { join } from "node:path";
import { logger } from "../logger.js";
import type { InnoSandboxConfig } from "../config.js";
import { incCounter, observeMs } from "../utils/metrics.js";
import { GuardedSandboxBackend, InMemorySandboxQuotaStore, quotaMessage, type SandboxQuotaStore } from "./sandbox-quota.js";
import type { SandboxBackend, SandboxProvider } from "./sandbox-backend.js";
import { WorkspaceSync } from "./workspace-sync.js";

/** Where a session's workspace and the shared skills live inside its sandbox. */
export const SANDBOX_WORKSPACE_ROOT = "/home/user/workspace";
export const SANDBOX_SKILLS_ROOT = "/home/user/.inno/skills";

/** What a durable runtime needs to work inside one session's sandbox. */
export interface SandboxRuntimeBinding {
	backend: SandboxBackend;
	remoteRoot: string;
	requireApproval: boolean;
	commandTimeoutSeconds: number;
	/** Before each turn: keep the sandbox alive and send host-side changes into it. */
	beforeTurn(): Promise<void>;
	/** Bring the agent's changes to the host workspace; failures are logged, never thrown. */
	pullToHost(): Promise<void>;
	/** Final sync and pause when the runtime closes. */
	release(): Promise<void>;
	/** Replace host paths in prompt text with their sandbox counterparts. */
	rebasePaths(text: string): string;
	promptSection: string;
}

export interface BindSandboxInput {
	sessionId: string;
	tenantId?: string;
	/** The sandbox recorded for this session, if any. */
	sandboxId?: string;
	hostWorkspaceDir: string;
	hostSkillsDir?: string;
	/** Directory for per-session sync manifests. */
	stateDir: string;
	/** How many sandboxes the tenant owns now; checked before creating another. */
	countTenantSandboxes?(): Promise<number>;
	/** Persist a newly created sandbox's ID on the session. */
	persistSandboxId(sandboxId: string): Promise<void>;
}

/** Creates, reconnects, pauses and destroys per-session sandboxes, within per-tenant limits. */
export class SandboxManager {
	constructor(
		private readonly provider: SandboxProvider,
		private readonly config: InnoSandboxConfig,
		private readonly quota: SandboxQuotaStore = new InMemorySandboxQuotaStore(),
	) {}

	private get timeoutMs(): number {
		return this.config.timeoutMinutes * 60_000;
	}

	/**
	 * The binding is always returned. When the tenant is over a limit the sandbox
	 * stays switched off (every tool call reports why) and each later turn tries
	 * again, so reading a session never fails because of quota and a session
	 * recovers by itself once capacity frees up.
	 */
	async bind(input: BindSandboxInput): Promise<SandboxRuntimeBinding> {
		const limits = this.config.limits;
		const tenantKey = input.tenantId ?? "local";
		const guarded = new GuardedSandboxBackend(undefined, input.sandboxId ?? "unavailable");
		guarded.block("沙箱尚未就绪");
		let inner: SandboxBackend | undefined;
		let sync: WorkspaceSync | undefined;
		let active = false;
		let knownSandboxId = input.sandboxId;
		const self = this;
		const timeoutMs = this.timeoutMs;
		const hostSkills = input.hostSkillsDir;
		const hostWorkspace = input.hostWorkspaceDir;

		const deny = (reason: "concurrent" | "time" | "sandboxes", message: string) => {
			incCounter(`inno_sandbox_quota_denied_${reason}_total`);
			guarded.block(message);
			return false;
		};

		/** Take a lease and connect, or stay blocked. */
		const activate = async (): Promise<boolean> => {
			const decision = await this.quota.acquire(tenantKey, input.sessionId, limits);
			if (!decision.ok) return deny(decision.reason, decision.message);
			if (!knownSandboxId && limits.maxSandboxes > 0 && input.countTenantSandboxes
				&& await input.countTenantSandboxes() >= limits.maxSandboxes) {
				await this.quota.release(tenantKey, input.sessionId);
				return deny("sandboxes", quotaMessage("sandboxes", limits));
			}
			const started = performance.now();
			try {
				let backend = knownSandboxId ? await this.provider.connect(knownSandboxId, { timeoutMs }) : null;
				const created = !backend;
				if (!backend) {
					backend = await this.provider.create({
						timeoutMs,
						metadata: { app: "inno-agent", sessionId: input.sessionId, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
					});
					incCounter("inno_sandbox_created_total");
					if (knownSandboxId) logger.warn({ sessionId: input.sessionId, lostSandboxId: knownSandboxId }, "sandbox no longer exists; created a new one");
					knownSandboxId = backend.id;
					await input.persistSandboxId(backend.id);
				} else {
					incCounter("inno_sandbox_resumed_total");
				}
				const workspaceSync = new WorkspaceSync(backend, hostWorkspace, SANDBOX_WORKSPACE_ROOT, join(input.stateDir, "sandbox-sync.json"));
				// A new sandbox is empty whatever the manifest says.
				if (created) workspaceSync.reset();
				await workspaceSync.pushHost();
				if (hostSkills) {
					const skills = new WorkspaceSync(backend, hostSkills, SANDBOX_SKILLS_ROOT, join(input.stateDir, "sandbox-sync-skills.json"));
					if (created) skills.reset();
					await skills.pushHost();
				}
				inner = backend;
				sync = workspaceSync;
				guarded.attach(backend);
				guarded.unblock();
				active = true;
				observeMs("inno_sandbox_bind_ms", performance.now() - started);
				return true;
			} catch (error) {
				await this.quota.release(tenantKey, input.sessionId).catch(() => undefined);
				throw error;
			}
		};

		const pullToHost = async () => {
			if (!active || !sync) return;
			try {
				await sync.pullRemote();
			} catch (error) {
				incCounter("inno_sandbox_sync_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId }, "failed to pull sandbox workspace changes to the host");
			}
		};

		const stop = async () => {
			if (!active) return;
			await pullToHost();
			active = false;
			try {
				await inner?.pause();
				incCounter("inno_sandbox_paused_total");
			} catch (error) {
				incCounter("inno_sandbox_pause_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId }, "failed to pause sandbox");
			}
			await this.quota.release(tenantKey, input.sessionId).catch((error) => logger.warn({ err: error }, "failed to release sandbox lease"));
		};

		await activate();

		return {
			backend: guarded,
			remoteRoot: SANDBOX_WORKSPACE_ROOT,
			requireApproval: this.config.requireApproval === "always",
			commandTimeoutSeconds: this.config.commandTimeoutSeconds,
			async beforeTurn() {
				if (!active) {
					if (!await activate()) return;
				} else {
					const decision = await self.quota.heartbeat(tenantKey, input.sessionId, limits);
					if (!decision.ok) {
						// Out of time: bring the work home, stop the meter, and keep reporting why.
						await stop();
						deny(decision.reason, decision.message);
						return;
					}
					await inner!.keepAlive(timeoutMs).catch((error) => logger.warn({ err: error }, "failed to extend sandbox lifetime"));
				}
				await sync!.pushHost();
			},
			pullToHost,
			release: stop,
			rebasePaths: (text) => {
				let out = text.split(hostWorkspace).join(SANDBOX_WORKSPACE_ROOT);
				if (hostSkills) out = out.split(hostSkills).join(SANDBOX_SKILLS_ROOT);
				return out;
			},
			promptSection: [
				"# 沙箱执行环境",
				`你的 bash、read、write、edit 都运行在一个隔离的云端沙箱里，不是用户的电脑。工作目录是 ${SANDBOX_WORKSPACE_ROOT}，它与用户的工作区同步：用户新增或修改的文件会在你下一轮对话前出现在这里，你创建或修改的文件会在本轮结束后回到用户的工作区。`,
				"沙箱里装的软件和依赖只在沙箱里有效；不要假设用户的电脑上有同样的环境。",
				!this.config.allowInternetAccess
					? "沙箱不能访问互联网。"
					: this.config.allowedDomains.length
						? `沙箱只能访问这些地址：${this.config.allowedDomains.join("、")}；其他网络请求会失败。`
						: "沙箱可以访问互联网。",
				"沙箱可能因为用量上限暂时不可用；此时工具会返回原因，请如实告诉用户，不要反复重试。",
			].join("\n"),
		};
	}

	async destroy(sandboxId: string): Promise<void> {
		try {
			await this.provider.destroy(sandboxId);
			incCounter("inno_sandbox_destroyed_total");
		} catch (error) {
			incCounter("inno_sandbox_destroy_errors_total");
			logger.warn({ err: error, sandboxId }, "failed to destroy sandbox");
		}
	}
}
