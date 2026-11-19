import { join } from "node:path";
import { logger } from "../logger.js";
import type { InnoSandboxConfig } from "../config.js";
import { incCounter, observeMs } from "../utils/metrics.js";
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
	/** Persist a newly created sandbox's ID on the session. */
	persistSandboxId(sandboxId: string): Promise<void>;
}

/** Creates, reconnects, pauses and destroys per-session sandboxes. */
export class SandboxManager {
	constructor(
		private readonly provider: SandboxProvider,
		private readonly config: InnoSandboxConfig,
	) {}

	private get timeoutMs(): number {
		return this.config.timeoutMinutes * 60_000;
	}

	async bind(input: BindSandboxInput): Promise<SandboxRuntimeBinding> {
		const started = performance.now();
		let backend = input.sandboxId ? await this.provider.connect(input.sandboxId, { timeoutMs: this.timeoutMs }) : null;
		const created = !backend;
		if (!backend) {
			backend = await this.provider.create({
				timeoutMs: this.timeoutMs,
				metadata: { app: "inno-agent", sessionId: input.sessionId, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
			});
			incCounter("inno_sandbox_created_total");
			if (input.sandboxId) logger.warn({ sessionId: input.sessionId, lostSandboxId: input.sandboxId }, "sandbox no longer exists; created a new one");
			await input.persistSandboxId(backend.id);
		} else {
			incCounter("inno_sandbox_resumed_total");
		}
		const sync = new WorkspaceSync(backend, input.hostWorkspaceDir, SANDBOX_WORKSPACE_ROOT, join(input.stateDir, "sandbox-sync.json"));
		// A new sandbox is empty whatever the manifest says.
		if (created) sync.reset();
		await sync.pushHost();
		if (input.hostSkillsDir) {
			const skills = new WorkspaceSync(backend, input.hostSkillsDir, SANDBOX_SKILLS_ROOT, join(input.stateDir, "sandbox-sync-skills.json"));
			if (created) skills.reset();
			await skills.pushHost();
		}
		observeMs("inno_sandbox_bind_ms", performance.now() - started);
		const timeoutMs = this.timeoutMs;
		const hostSkills = input.hostSkillsDir;
		const hostWorkspace = input.hostWorkspaceDir;
		const pullToHost = async () => {
			try {
				await sync.pullRemote();
			} catch (error) {
				incCounter("inno_sandbox_sync_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId }, "failed to pull sandbox workspace changes to the host");
			}
		};
		return {
			backend,
			remoteRoot: SANDBOX_WORKSPACE_ROOT,
			requireApproval: this.config.requireApproval === "always",
			commandTimeoutSeconds: this.config.commandTimeoutSeconds,
			async beforeTurn() {
				await backend.keepAlive(timeoutMs).catch((error) => logger.warn({ err: error }, "failed to extend sandbox lifetime"));
				await sync.pushHost();
			},
			pullToHost,
			async release() {
				await pullToHost();
				try {
					await backend.pause();
					incCounter("inno_sandbox_paused_total");
				} catch (error) {
					incCounter("inno_sandbox_pause_errors_total");
					logger.warn({ err: error, sessionId: input.sessionId }, "failed to pause sandbox");
				}
			},
			rebasePaths: (text) => {
				let out = text.split(hostWorkspace).join(SANDBOX_WORKSPACE_ROOT);
				if (hostSkills) out = out.split(hostSkills).join(SANDBOX_SKILLS_ROOT);
				return out;
			},
			promptSection: [
				"# 沙箱执行环境",
				`你的 bash、read、write、edit 都运行在一个隔离的云端沙箱里，不是用户的电脑。工作目录是 ${SANDBOX_WORKSPACE_ROOT}，它与用户的工作区同步：用户新增或修改的文件会在你下一轮对话前出现在这里，你创建或修改的文件会在本轮结束后回到用户的工作区。`,
				"沙箱里装的软件和依赖只在沙箱里有效；不要假设用户的电脑上有同样的环境。",
				this.config.allowInternetAccess ? "沙箱可以访问互联网。" : "沙箱不能访问互联网。",
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
