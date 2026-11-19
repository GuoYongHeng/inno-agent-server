/**
 * Minimal remote-sandbox contract, shaped after the E2B SDK (files, commands,
 * pause/connect/kill). Everything above it (the ExecutionEnv adapter, the bash
 * tool, lifecycle and workspace sync) depends only on this interface, so the E2B
 * cloud, a self-hosted e2b-compatible service, or a test double are
 * interchangeable.
 */

export type SandboxFsErrorCode = "not_found" | "permission_denied" | "not_directory" | "is_directory" | "invalid" | "unknown";

export class SandboxFsError extends Error {
	constructor(readonly code: SandboxFsErrorCode, message: string, readonly path?: string) {
		super(message);
		this.name = "SandboxFsError";
	}
}

/** The command did not finish: it hit its time limit or the caller aborted. */
export class SandboxRunError extends Error {
	constructor(readonly code: "timeout" | "aborted" | "unavailable", message: string) {
		super(message);
		this.name = "SandboxRunError";
	}
}

export interface SandboxEntry {
	name: string;
	/** Absolute path inside the sandbox. */
	path: string;
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
}

export interface SandboxRunOptions {
	cwd?: string;
	envs?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
}

export interface SandboxBackend {
	readonly id: string;
	readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
	/** Creates missing parent directories. */
	writeFile(path: string, data: Uint8Array | string, signal?: AbortSignal): Promise<void>;
	list(path: string): Promise<SandboxEntry[]>;
	/** Every entry below `path` (files and directories), at most `maxDepth` levels deep, in one pass where the service allows. */
	listTree(path: string, maxDepth: number): Promise<SandboxEntry[]>;
	stat(path: string): Promise<SandboxEntry>;
	makeDir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Runs a shell command. A non-zero exit is a result, not an error. */
	run(command: string, options?: SandboxRunOptions): Promise<{ exitCode: number }>;
	/** Extend the sandbox's lifetime from now. */
	keepAlive(ms: number): Promise<void>;
	/** Persist state and stop billing for compute; `SandboxProvider.connect` resumes it. */
	pause(): Promise<void>;
	kill(): Promise<void>;
}

export interface SandboxCreateOptions {
	template?: string;
	timeoutMs?: number;
	metadata?: Record<string, string>;
	envs?: Record<string, string>;
}

export interface ManagedSandboxInfo {
	id: string;
	createdAt: number;
	metadata: Record<string, string>;
	state: "running" | "paused";
}

export interface SandboxProvider {
	/** Every sandbox this application created (running or paused), found by its metadata. */
	listManaged(): Promise<ManagedSandboxInfo[]>;
	create(options?: SandboxCreateOptions): Promise<SandboxBackend>;
	/** Reconnect to (and resume, if paused) an earlier sandbox; null when it no longer exists. */
	connect(sandboxId: string, options?: { timeoutMs?: number }): Promise<SandboxBackend | null>;
	/** Destroy a sandbox without connecting to it; absent sandboxes are not an error. */
	destroy(sandboxId: string): Promise<void>;
}
