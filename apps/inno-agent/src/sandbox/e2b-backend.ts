import {
	CommandExitError,
	FileType,
	InvalidArgumentError,
	NotFoundError,
	Sandbox,
	SandboxNotFoundError,
	TimeoutError,
	type EntryInfo,
} from "e2b";
import {
	SandboxFsError,
	SandboxRunError,
	type SandboxBackend,
	type SandboxCreateOptions,
	type SandboxEntry,
	type SandboxFsErrorCode,
	type SandboxProvider,
	type SandboxRunOptions,
} from "./sandbox-backend.js";

export interface E2BProviderOptions {
	apiKey?: string;
	/** Self-hosted or regional E2B domain; omit for the E2B cloud. */
	domain?: string;
	template?: string;
	/** Sandbox lifetime unless extended. */
	timeoutMs?: number;
	/** Upper bound for any single command when the caller gives none. */
	defaultCommandTimeoutMs?: number;
	/** Block outbound network access from the sandbox. Default: allowed. */
	allowInternetAccess?: boolean;
	requestTimeoutMs?: number;
}

function fsCode(error: unknown): SandboxFsErrorCode {
	if (error instanceof NotFoundError) return "not_found";
	if (error instanceof InvalidArgumentError) return "invalid";
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("not a directory")) return "not_directory";
	if (message.includes("is a directory")) return "is_directory";
	if (message.includes("permission denied")) return "permission_denied";
	if (message.includes("no such file") || message.includes("not found")) return "not_found";
	return "unknown";
}

function toFsError(error: unknown, path: string): SandboxFsError {
	if (error instanceof SandboxFsError) return error;
	return new SandboxFsError(fsCode(error), error instanceof Error ? error.message : String(error), path);
}

function toEntry(info: EntryInfo): SandboxEntry {
	return {
		name: info.name,
		path: info.path,
		kind: info.type === FileType.DIR ? "directory" : info.type === FileType.SYMLINK ? "symlink" : "file",
		size: info.size,
		mtimeMs: info.modifiedTime?.getTime() ?? 0,
	};
}

/** One live E2B sandbox behind the {@link SandboxBackend} contract. */
export class E2BSandboxBackend implements SandboxBackend {
	constructor(
		private readonly sandbox: Sandbox,
		private readonly options: E2BProviderOptions,
	) {}

	get id(): string {
		return this.sandbox.sandboxId;
	}

	private requestOpts(signal?: AbortSignal) {
		return {
			...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
			...(signal ? { signal } : {}),
		};
	}

	async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		try {
			return await this.sandbox.files.read(path, { format: "bytes", ...this.requestOpts(signal) });
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async writeFile(path: string, data: Uint8Array | string, signal?: AbortSignal): Promise<void> {
		try {
			await this.sandbox.files.write(path, data, this.requestOpts(signal));
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async list(path: string): Promise<SandboxEntry[]> {
		try {
			const entries = await this.sandbox.files.list(path, { depth: 1, ...this.requestOpts() });
			return entries.map(toEntry).sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async listTree(path: string, maxDepth: number): Promise<SandboxEntry[]> {
		try {
			return (await this.sandbox.files.list(path, { depth: maxDepth, ...this.requestOpts() })).map(toEntry);
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async stat(path: string): Promise<SandboxEntry> {
		try {
			return toEntry(await this.sandbox.files.getInfo(path, this.requestOpts()));
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async makeDir(path: string): Promise<void> {
		try {
			await this.sandbox.files.makeDir(path, this.requestOpts());
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async remove(path: string): Promise<void> {
		try {
			await this.sandbox.files.remove(path, this.requestOpts());
		} catch (error) {
			throw toFsError(error, path);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		try {
			await this.sandbox.files.rename(from, to, this.requestOpts());
		} catch (error) {
			throw toFsError(error, from);
		}
	}

	async run(command: string, options: SandboxRunOptions = {}): Promise<{ exitCode: number }> {
		if (options.signal?.aborted) throw new SandboxRunError("aborted", "aborted");
		const limitMs = options.timeoutMs ?? this.options.defaultCommandTimeoutMs;
		let handle;
		try {
			handle = await this.sandbox.commands.run(command, {
				background: true,
				// The connection stays open for the command's whole life; the limit below is enforced here.
				timeoutMs: 0,
				...(options.cwd ? { cwd: options.cwd } : {}),
				...(options.envs ? { envs: options.envs } : {}),
				...(options.onStdout ? { onStdout: options.onStdout } : {}),
				...(options.onStderr ? { onStderr: options.onStderr } : {}),
			});
		} catch (error) {
			throw new SandboxRunError("unavailable", error instanceof Error ? error.message : String(error));
		}
		let stopped: "timeout" | "aborted" | undefined;
		const stop = (reason: "timeout" | "aborted") => {
			if (stopped) return;
			stopped = reason;
			void handle.kill().catch(() => undefined);
		};
		const timer = limitMs ? setTimeout(() => stop("timeout"), limitMs) : undefined;
		const onAbort = () => stop("aborted");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await handle.wait();
			if (stopped) throw new SandboxRunError(stopped, stopped === "timeout" ? "Command timed out" : "aborted");
			return { exitCode: result.exitCode };
		} catch (error) {
			if (stopped) throw new SandboxRunError(stopped, stopped === "timeout" ? "Command timed out" : "aborted");
			if (error instanceof CommandExitError) return { exitCode: error.exitCode };
			if (error instanceof SandboxRunError) throw error;
			throw new SandboxRunError(error instanceof TimeoutError ? "timeout" : "unavailable", error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async keepAlive(ms: number): Promise<void> {
		await this.sandbox.setTimeout(ms, this.requestOpts());
	}

	async pause(): Promise<void> {
		await this.sandbox.pause();
	}

	async kill(): Promise<void> {
		await this.sandbox.kill();
	}
}

/** Creates and reconnects E2B cloud sandboxes. */
export class E2BSandboxProvider implements SandboxProvider {
	constructor(private readonly options: E2BProviderOptions = {}) {}

	private connection() {
		return {
			...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
			...(this.options.domain ? { domain: this.options.domain } : {}),
			...(this.options.requestTimeoutMs ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
		};
	}

	async create(options: SandboxCreateOptions = {}): Promise<SandboxBackend> {
		const template = options.template ?? this.options.template;
		const opts = {
			...this.connection(),
			timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30 * 60_000,
			...(options.metadata ? { metadata: options.metadata } : {}),
			...(options.envs ? { envs: options.envs } : {}),
			...(this.options.allowInternetAccess === false ? { allowInternetAccess: false } : {}),
		};
		const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
		return new E2BSandboxBackend(sandbox, this.options);
	}

	async connect(sandboxId: string, options: { timeoutMs?: number } = {}): Promise<SandboxBackend | null> {
		try {
			// Connecting resumes a paused sandbox and extends its lifetime.
			const sandbox = await Sandbox.connect(sandboxId, {
				...this.connection(),
				timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30 * 60_000,
			});
			return new E2BSandboxBackend(sandbox, this.options);
		} catch (error) {
			if (error instanceof NotFoundError || error instanceof SandboxNotFoundError) return null;
			throw error;
		}
	}

	async destroy(sandboxId: string): Promise<void> {
		try {
			await Sandbox.kill(sandboxId, this.connection());
		} catch (error) {
			if (error instanceof NotFoundError || error instanceof SandboxNotFoundError) return;
			throw error;
		}
	}
}
