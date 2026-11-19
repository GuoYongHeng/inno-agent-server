import type { Context } from "@earendil-works/chord/context";
import {
	ExecutionError,
	FileError,
	LineScanner,
	StreamDecoder,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { posix } from "node:path";
import { SandboxFsError, SandboxRunError, type SandboxBackend, type SandboxEntry } from "./sandbox-backend.js";

/** Whole files are transferred to read them; refuse anything larger than this. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = (error: FileError): Result<never, FileError> => ({ ok: false, error });

function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	if (error instanceof SandboxFsError) return new FileError(error.code as FileErrorCode, error.message, error.path ?? path, error);
	if ((error as { name?: string })?.name === "AbortError") return new FileError("aborted", "aborted", path);
	const cause = error instanceof Error ? error : new Error(String(error));
	return new FileError("unknown", cause.message, path, cause);
}

function aborted(context: Context, path: string): Result<never, FileError> | undefined {
	return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function infoOf(entry: SandboxEntry): FileInfo {
	return { name: entry.name, path: entry.path, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs };
}

class MemoryTextLineReader implements TextLineReader {
	private buffered: string;
	private closed = false;
	constructor(bytes: Uint8Array, private readonly path: string) {
		const decoder = new StreamDecoder();
		this.buffered = decoder.decode(bytes) + decoder.decode();
	}
	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const stop = aborted(context, this.path);
		if (stop) return stop;
		if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));
		if (this.buffered.length === 0) return ok(undefined);
		const newline = this.buffered.indexOf("\n");
		if (newline === -1) {
			const text = this.buffered;
			this.buffered = "";
			return ok({ text, terminated: false });
		}
		const text = this.buffered.slice(0, newline);
		this.buffered = this.buffered.slice(newline + 1);
		return ok({ text, terminated: true });
	}
	async close(): Promise<void> {
		this.closed = true;
		this.buffered = "";
	}
}

class MemoryBinaryReader implements BinaryReader {
	private closed = false;
	constructor(private readonly bytes: Uint8Array, private readonly entry: SandboxEntry) {}
	private guard(context: Context): Result<never, FileError> | undefined {
		return aborted(context, this.entry.path)
			?? (this.closed ? err(new FileError("invalid", "Binary reader is closed", this.entry.path)) : undefined);
	}
	async info(context: Context) {
		return this.guard(context) ?? ok(infoOf({ ...this.entry, size: this.bytes.length }));
	}
	async read(offset: number, length: number, context: Context) {
		const stop = this.guard(context);
		if (stop) return stop;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.entry.path));
		}
		return ok(this.bytes.slice(offset, offset + length));
	}
	async scanLines(options: { startLine: number; endLine?: number }, context: Context) {
		const stop = this.guard(context);
		if (stop) return stop;
		let scanner: LineScanner;
		try {
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.entry.path));
		}
		scanner.push(this.bytes);
		return ok(scanner.finish());
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class SandboxDirReader implements DirReader {
	private index = 0;
	private closed = false;
	constructor(private readonly backend: SandboxBackend, private readonly names: SandboxEntry[], private readonly path: string) {}
	async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const stop = aborted(context, this.path);
		if (stop) return stop;
		if (this.closed) return err(new FileError("invalid", "Directory reader is closed", this.path));
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
		}
		const entries: FileInfo[] = [];
		const limit = maxEntries;
		while (entries.length < limit && this.index < this.names.length) {
			const candidate = this.names[this.index++]!;
			try {
				// Re-read each entry so one removed since the listing is skipped, not reported.
				entries.push(infoOf(await this.backend.stat(candidate.path)));
			} catch (error) {
				if (error instanceof SandboxFsError && error.code === "not_found") continue;
				return err(toFileError(error, candidate.path));
			}
		}
		return ok({ entries, done: this.index >= this.names.length });
	}
	async close(): Promise<void> {
		this.closed = true;
		this.index = this.names.length;
	}
}

/**
 * pi-durable `ExecutionEnv` over a remote sandbox. Files move as whole buffers
 * (bounded by MAX_FILE_BYTES) and commands run through the backend's shell, so
 * the agent's `read`/`write`/`edit`/`bash` tools act inside the sandbox and
 * never touch the host. Symlinks, watching and temp files are not offered.
 */
export class SandboxExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	private readonly running = new Set<AbortController>();

	constructor(private readonly backend: SandboxBackend, cwd: string) {
		this.id = `sandbox:${backend.id}`;
		this.cwd = cwd;
	}

	private resolve(path: string): string {
		return posix.resolve(this.cwd, path);
	}

	async absolutePath(path: string, context: Context) {
		return aborted(context, path) ?? ok(this.resolve(path));
	}

	async joinPath(parts: string[], context: Context) {
		return aborted(context, parts.join("/")) ?? ok(posix.join(...parts));
	}

	private async load(path: string, context: Context): Promise<Result<{ bytes: Uint8Array; entry: SandboxEntry }, FileError>> {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			const entry = await this.backend.stat(resolved);
			if (entry.kind === "directory") return err(new FileError("is_directory", `EISDIR: illegal operation on a directory, read '${resolved}'`, resolved));
			if (entry.size > MAX_FILE_BYTES) return err(new FileError("invalid", `File is larger than ${MAX_FILE_BYTES} bytes`, resolved));
			return ok({ bytes: await this.backend.readFile(resolved, context.abortSignal), entry });
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextFile(path: string, context: Context) {
		const loaded = await this.load(path, context);
		if (!loaded.ok) return loaded;
		return ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(loaded.value.bytes));
	}

	async openTextLineReader(path: string, context: Context) {
		const loaded = await this.load(path, context);
		return loaded.ok ? ok<TextLineReader>(new MemoryTextLineReader(loaded.value.bytes, this.resolve(path))) : loaded;
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([] as string[]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (!line.value) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async readBinaryFile(path: string, context: Context) {
		const loaded = await this.load(path, context);
		return loaded.ok ? ok(loaded.value.bytes) : loaded;
	}

	async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context) {
		const loaded = await this.load(path, context);
		return loaded.ok ? ok<BinaryReader>(new MemoryBinaryReader(loaded.value.bytes, loaded.value.entry)) : loaded;
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			await this.backend.writeFile(resolved, content, context.abortSignal);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context) {
		const existing = await this.readBinaryFile(path, context);
		if (!existing.ok && existing.error.code !== "not_found") return existing;
		const addition = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const base = existing.ok ? existing.value : new Uint8Array();
		const merged = new Uint8Array(base.length + addition.length);
		merged.set(base);
		merged.set(addition, base.length);
		return this.writeFile(path, merged, context);
	}

	async truncateFile(path: string, size: number, context: Context) {
		if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "Size must be a non-negative safe integer", path));
		const existing = await this.readBinaryFile(path, context);
		if (!existing.ok) return existing;
		const next = new Uint8Array(size);
		next.set(existing.value.subarray(0, size));
		return this.writeFile(path, next, context);
	}

	async flushFile(path: string, context: Context) {
		const exists = await this.exists(path, context);
		if (!exists.ok) return exists;
		return exists.value ? ok(undefined) : err(new FileError("not_found", `ENOENT: no such file '${this.resolve(path)}'`, this.resolve(path)));
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context) {
		const from = this.resolve(sourcePath);
		const stop = aborted(context, from);
		if (stop) return stop;
		try {
			await this.backend.rename(from, this.resolve(destinationPath));
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, from));
		}
	}

	async fileInfo(path: string, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			return ok(infoOf(await this.backend.stat(resolved)));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			return ok((await this.backend.list(resolved)).map(infoOf));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openDirReader(path: string, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			return ok<DirReader>(new SandboxDirReader(this.backend, await this.backend.list(resolved), resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
		return err(new FileError("not_supported", "Watching is not supported in the sandbox environment"));
	}

	async canonicalPath(path: string, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			await this.backend.stat(resolved);
			return ok(resolved);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			await this.backend.stat(resolved);
			return ok(true);
		} catch (error) {
			if (error instanceof SandboxFsError && error.code === "not_found") return ok(false);
			return err(toFileError(error, resolved));
		}
	}

	async createDir(path: string, _options: { recursive?: boolean } | undefined, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			await this.backend.makeDir(resolved);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		const resolved = this.resolve(path);
		const stop = aborted(context, resolved);
		if (stop) return stop;
		try {
			const entry = await this.backend.stat(resolved);
			if (entry.kind === "directory" && !options?.recursive) {
				if ((await this.backend.list(resolved)).length > 0) {
					return err(new FileError("invalid", `ENOTEMPTY: directory not empty, rmdir '${resolved}'`, resolved));
				}
			}
			await this.backend.remove(resolved);
			return ok(undefined);
		} catch (error) {
			if (options?.force && error instanceof SandboxFsError && error.code === "not_found") return ok(undefined);
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context) {
		const dir = posix.join("/tmp", `${prefix ?? "tmp-"}${Math.random().toString(36).slice(2, 10)}`);
		const made = await this.createDir(dir, { recursive: true }, context);
		return made.ok ? ok(dir) : made;
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
		const path = posix.join("/tmp", `${options?.prefix ?? "tmp-"}${Math.random().toString(36).slice(2, 10)}${options?.suffix ?? ""}`);
		const written = await this.writeFile(path, "", context);
		return written.ok ? ok(path) : written;
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (context.abortSignal?.aborted) return { ok: false, error: new ExecutionError("aborted", "aborted") };
		const script = typeof command === "string"
			? command
			: command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
		if (typeof command !== "string") {
			const program = command[0];
			if (program === undefined) return { ok: false, error: new ExecutionError("spawn_error", "Empty argv: no program to run") };
			// An argv form never goes through shell parsing, so a missing program is a spawn error, not exit 127.
			const probe = await this.backend.run(`command -v '${program.replaceAll("'", "'\\''")}' >/dev/null 2>&1`, {
				cwd: this.cwd, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
			}).catch(() => ({ exitCode: 1 }));
			if (probe.exitCode !== 0) return { ok: false, error: new ExecutionError("spawn_error", `Program not found: ${program}`) };
		}
		if (!script.trim()) return { ok: false, error: new ExecutionError("spawn_error", "Empty command") };
		const abort = new AbortController();
		this.running.add(abort);
		const onCallerAbort = () => abort.abort();
		context.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
		let callbackError: ExecutionError | undefined;
		const forward = (stream: "stdout" | "stderr") => (data: string) => {
			if (callbackError) return;
			try {
				options?.onOutput?.(data, context, { stream });
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				abort.abort();
			}
		};
		try {
			const result = await this.backend.run(script, {
				cwd: options?.cwd ? this.resolve(options.cwd) : this.cwd,
				...(options?.env ? { envs: options.env } : {}),
				...(options?.timeout !== undefined ? { timeoutMs: options.timeout * 1000 } : {}),
				signal: abort.signal,
				onStdout: forward("stdout"),
				onStderr: forward("stderr"),
			});
			if (callbackError) return { ok: false, error: callbackError };
			return { ok: true, value: { exitCode: result.exitCode } };
		} catch (error) {
			if (callbackError) return { ok: false, error: callbackError };
			if (error instanceof SandboxRunError) {
				return { ok: false, error: new ExecutionError(error.code === "unavailable" ? "spawn_error" : error.code, error.message, error) };
			}
			const cause = error instanceof Error ? error : new Error(String(error));
			return { ok: false, error: new ExecutionError("unknown", cause.message, cause) };
		} finally {
			context.abortSignal?.removeEventListener("abort", onCallerAbort);
			this.running.delete(abort);
		}
	}

	async cleanup(_context: Context): Promise<void> {
		for (const abort of this.running) abort.abort();
		this.running.clear();
	}
}
