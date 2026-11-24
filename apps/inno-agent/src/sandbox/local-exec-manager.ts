import { mkdirSync } from "node:fs";
import { posix } from "node:path";
import { logger } from "../logger.js";
import { incCounter, observeMs } from "../utils/metrics.js";
import type { WorkspaceReplica } from "../workspace/workspace-replica.js";
import { createReplicaPushGate } from "../server/replica-push.js";
import { LocalDirSandbox } from "./local-backend.js";
import { SandboxRunError, type SandboxBackend } from "./sandbox-backend.js";
import type { BindSandboxInput, SandboxBindingProvider, SandboxRuntimeBinding } from "./sandbox-session.js";

export interface LocalExecManagerOptions {
	/** Authenticated mode: workspace bytes/rows are refreshed from and pushed to durable storage. */
	replica?: WorkspaceReplica;
	/** Upper bound for one shell command, in seconds. */
	commandTimeoutSeconds?: number;
	/** Ask the user before each shell command; headless runs cannot ask, so they are denied. */
	requireApproval?: boolean;
	/**
	 * Upper bound on sessions with an active local backend at once; 0 (default)
	 * means unlimited. Over-cap calls fail with a retryable "busy" error so the
	 * model can tell the user instead of the turn dying.
	 */
	maxConcurrent?: number;
}

/**
 * Lazily materialises the real backend on the first file/command call so a
 * session that never touches the workspace never takes a concurrency slot.
 * Mutating calls fire `onMutated` once they settle; while a command is
 * running the trigger is deferred until it exits so a push never captures a
 * half-written file.
 */
class GatedLocalBackend implements SandboxBackend {
	private inner: LocalDirSandbox | null = null;
	private inflightRuns = 0;
	constructor(
		readonly id: string,
		private readonly root: string,
		private readonly acquire: () => boolean,
		private readonly busyMessage: string,
		private readonly onMutated?: () => void,
		/** Lazy-pull hook: fetch one manifest file (miss or drift) before a read. */
		private readonly materialize?: (relPath: string) => Promise<boolean>,
		/** Runs before every command — lazy pull's full-sync trigger for bash. */
		private readonly beforeRun?: () => Promise<void>,
	) {}

	/** Materialize `path` when a replica backs this dir; failures are logged-only
	 * upstream and the delegate then serves whatever the local copy has. */
	private async syncPath(path: string): Promise<void> {
		if (!this.materialize) return;
		const rel = posix.normalize(path).replace(/^\/+/, "");
		if (rel && rel !== "." && !rel.startsWith("..")) await this.materialize(rel);
	}

	private delegate(): LocalDirSandbox {
		if (!this.inner) {
			if (!this.acquire()) throw new SandboxRunError("unavailable", this.busyMessage);
			this.inner = new LocalDirSandbox(this.id, this.root);
		}
		return this.inner;
	}

	private mutated(): void {
		// Mutations during a command are covered by the push fired when it exits.
		if (this.inflightRuns === 0) this.onMutated?.();
	}

	// All methods are async so an over-cap denial rejects like a normal
	// backend failure instead of throwing synchronously at the call site.
	readFile = async (path: string) => {
		await this.syncPath(path);
		return this.delegate().readFile(path);
	};
	writeFile = async (path: string, data: Uint8Array | string) => {
		const result = await this.delegate().writeFile(path, data);
		this.mutated();
		return result;
	};
	list = async (path: string) => this.delegate().list(path);
	listTree = async (path: string, maxDepth: number) => this.delegate().listTree(path, maxDepth);
	stat = async (path: string) => {
		await this.syncPath(path);
		return this.delegate().stat(path);
	};
	makeDir = async (path: string) => {
		const result = await this.delegate().makeDir(path);
		this.mutated();
		return result;
	};
	remove = async (path: string) => {
		const result = await this.delegate().remove(path);
		this.mutated();
		return result;
	};
	rename = async (from: string, to: string) => {
		const result = await this.delegate().rename(from, to);
		this.mutated();
		return result;
	};
	run = async (command: string, options?: Parameters<LocalDirSandbox["run"]>[1]) => {
		this.inflightRuns++;
		try {
			// Bash cannot be intercepted per-file: sync the whole workspace
			// before every command (incremental — only drifted bodies download).
			await this.beforeRun?.();
			return await this.delegate().run(command, options);
		} finally {
			this.inflightRuns--;
			// A command may itself write files, and a mutation during it was
			// deferred — one push after it exits covers both.
			if (this.inflightRuns === 0) this.onMutated?.();
		}
	};
	keepAlive = async (ms: number) => this.delegate().keepAlive(ms);
	pause = async () => this.delegate().pause();
	/** The root is the shared workspace directory — never delete it. */
	kill = async () => {};
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
	private active = 0;
	/** The binding pulls/pushes the replica itself when one is configured. */
	readonly syncsWorkspaceReplica: boolean;

	constructor(private readonly options: LocalExecManagerOptions = {}) {
		this.syncsWorkspaceReplica = Boolean(options.replica);
	}

	private tryAcquire(): boolean {
		const max = this.options.maxConcurrent ?? 0;
		if (max > 0 && this.active >= max) {
			incCounter("inno_local_exec_busy_total");
			return false;
		}
		this.active++;
		return true;
	}

	async bind(input: BindSandboxInput): Promise<SandboxRuntimeBinding> {
		const dir = input.hostWorkspaceDir;
		mkdirSync(dir, { recursive: true });
		const replica = this.options.replica;
		const tenant = input.tenantContext;
		const workspaceId = input.workspaceId;

		const pull = async (options?: { download?: (relPath: string) => boolean }) => {
			if (!replica || !tenant || !workspaceId) return;
			const started = performance.now();
			try {
				await replica.pull(tenant, workspaceId, dir, options);
			} catch (error) {
				incCounter("inno_local_exec_pull_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId, workspaceId }, "failed to pull workspace replica before turn");
			} finally {
				observeMs("inno_local_exec_pull_ms", performance.now() - started);
			}
		};
		// beforeTurn syncs only the manifest shape (dirs + drift detection, no
		// bodies): file tools materialize single files on read and bash syncs
		// fully per command — a session that never touches files never pulls.
		const pullIndex = async () => pull({ download: () => false });
		const materialize = replica && tenant && workspaceId && typeof replica.materializeFile === "function"
			? (relPath: string) => replica.materializeFile(tenant, workspaceId, dir, relPath)
				.catch((error) => {
					logger.warn({ err: error, sessionId: input.sessionId, workspaceId, relPath }, "lazy workspace materialize failed");
					return false;
				})
			: undefined;
		const push = async () => {
			if (!replica || !tenant || !workspaceId) return;
			const started = performance.now();
			try {
				await replica.push(tenant, workspaceId, dir);
			} catch (error) {
				incCounter("inno_local_exec_push_errors_total");
				logger.warn({ err: error, sessionId: input.sessionId, workspaceId }, "failed to push workspace replica on release");
			} finally {
				observeMs("inno_local_exec_push_ms", performance.now() - started);
			}
		};

		let slotHeld = false;
		const releaseSlot = () => {
			if (!slotHeld) return;
			slotHeld = false;
			this.active--;
		};
		const release = async () => {
			releaseSlot();
			await push();
		};

		// Coalesce mutation-triggered pushes: a burst of file writes (or a
		// script touching many files) collapses into at most two syncs.
		const syncEnabled = Boolean(replica && tenant && workspaceId);
		const pushGate = syncEnabled ? createReplicaPushGate(push) : undefined;
		const onMutated = pushGate ? () => void pushGate() : undefined;

		return {
			backend: new GatedLocalBackend(`local-${input.sessionId}`, dir, () => {
				if (slotHeld) return true;
				if (!this.tryAcquire()) return false;
				slotHeld = true;
				incCounter("inno_local_exec_activations_total");
				return true;
			}, "本地执行并发已满，请稍后重试", onMutated, materialize, () => pull()),
			remoteRoot: "/",
			requireApproval: this.options.requireApproval ?? false,
			commandTimeoutSeconds: this.options.commandTimeoutSeconds ?? 600,
			beforeTurn: pullIndex,
			pullToHost: push,
			release,
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
