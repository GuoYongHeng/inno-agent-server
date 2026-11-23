import { mkdirSync } from "node:fs";
import { logger } from "../logger.js";
import { incCounter } from "../utils/metrics.js";
import type { WorkspaceReplica } from "../workspace/workspace-replica.js";
import { LocalDirSandbox } from "./local-backend.js";
import type { BindSandboxInput, SandboxBindingProvider, SandboxRuntimeBinding } from "./sandbox-session.js";

export interface LocalExecManagerOptions {
	/** Authenticated mode: workspace bytes/rows are refreshed from and pushed to durable storage. */
	replica?: WorkspaceReplica;
	/** Upper bound for one shell command, in seconds. */
	commandTimeoutSeconds?: number;
	/** Ask the user before each shell command; headless runs cannot ask, so they are denied. */
	requireApproval?: boolean;
}

/**
 * Local execution provider (roadmap H5 phase 1): every tool — bash included —
 * runs on this worker inside the session's workspace directory, through the
 * same `SandboxRuntimeBinding`/`SandboxBackend` contract a remote sandbox
 * uses, so switching providers later changes this class, not the tools.
 *
 * The directory is a disposable working copy, not durable state: in
 * authenticated mode `beforeTurn` pulls replica changes (so writes made
 * through the object store or on another worker appear before the turn) and
 * `pullToHost`/`release` push local changes back — after every settled
 * submission and on close. Without a replica (local or in-memory object
 * storage) the directory is the only copy, as before.
 */
export class LocalExecManager implements SandboxBindingProvider {
	constructor(private readonly options: LocalExecManagerOptions = {}) {}

	async bind(input: BindSandboxInput): Promise<SandboxRuntimeBinding> {
		const dir = input.hostWorkspaceDir;
		mkdirSync(dir, { recursive: true });
		const replica = this.options.replica;
		const tenant = input.tenantContext;
		const workspaceId = input.workspaceId;

		const pull = async () => {
			if (!replica || !tenant || !workspaceId) return;
			try {
				await replica.pull(tenant, workspaceId, dir);
			} catch (error) {
				incCounter("inno_local_exec_pull_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId, workspaceId }, "failed to pull workspace replica before turn");
			}
		};
		const push = async () => {
			if (!replica || !tenant || !workspaceId) return;
			try {
				await replica.push(tenant, workspaceId, dir);
			} catch (error) {
				incCounter("inno_local_exec_push_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId, workspaceId }, "failed to push workspace replica on release");
			}
		};

		return {
			backend: new LocalDirSandbox(`local-${input.sessionId}`, dir),
			remoteRoot: "/",
			requireApproval: this.options.requireApproval ?? false,
			commandTimeoutSeconds: this.options.commandTimeoutSeconds ?? 600,
			beforeTurn: pull,
			pullToHost: push,
			release: push,
			rebasePaths: (text) => text.split(`${dir}/`).join("/").split(dir).join("/"),
			promptSection: [
				"# 本地执行环境",
				"你的 bash、read、write、edit 都运行在这台服务器上你的工作目录里，不是一个隔离的沙箱。",
				"工作目录（/）就是用户的工作区：你在里面创建或修改的文件，用户随后能在工作面板里看到。",
			].join("\n"),
		};
	}

	/** Nothing to destroy: the workspace directory is shared working state, not a per-session sandbox. */
	async destroy(_sandboxId: string): Promise<void> {}
}
