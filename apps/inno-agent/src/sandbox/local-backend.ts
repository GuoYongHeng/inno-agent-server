import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
	SandboxFsError,
	SandboxRunError,
	type SandboxBackend,
	type ManagedSandboxInfo,
	type SandboxCreateOptions,
	type SandboxEntry,
	type SandboxProvider,
	type SandboxRunOptions,
} from "./sandbox-backend.js";

/**
 * Test double: a "sandbox" that is a directory on the host and a shell that runs
 * there. It provides NO isolation and exists only so the sandbox adapter,
 * lifecycle and sync code can be exercised without a cloud account. Absolute
 * sandbox paths map under the sandbox's own root directory.
 */
export class LocalDirSandbox implements SandboxBackend {
	killed = false;
	paused = false;
	keepAlives: number[] = [];
	createdAt = Date.now();
	metadata: Record<string, string> = {};
	constructor(readonly id: string, readonly root: string) {}

	private host(path: string): string {
		return join(this.root, posix.normalize(path));
	}

	private entry(path: string, followLinks = true): SandboxEntry {
		const host = this.host(path);
		try {
			const stats = followLinks ? statSync(host) : lstatSync(host);
			return {
				name: posix.basename(path),
				path: posix.normalize(path),
				kind: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "file",
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			};
		} catch (error) {
			throw fsError(error, path);
		}
	}

	async readFile(path: string): Promise<Uint8Array> {
		try {
			return new Uint8Array(readFileSync(this.host(path)));
		} catch (error) {
			throw fsError(error, path);
		}
	}

	async writeFile(path: string, data: Uint8Array | string): Promise<void> {
		try {
			mkdirSync(dirname(this.host(path)), { recursive: true });
			writeFileSync(this.host(path), data);
		} catch (error) {
			throw fsError(error, path);
		}
	}

	async list(path: string): Promise<SandboxEntry[]> {
		try {
			return readdirSync(this.host(path)).sort().map((name) => this.entry(posix.join(path, name), false));
		} catch (error) {
			throw fsError(error, path);
		}
	}

	async listTree(path: string, maxDepth: number): Promise<SandboxEntry[]> {
		const out: SandboxEntry[] = [];
		const walk = async (dir: string, depth: number) => {
			for (const entry of await this.list(dir)) {
				out.push(entry);
				if (entry.kind === "directory" && depth < maxDepth) await walk(entry.path, depth + 1);
			}
		};
		await walk(path, 1);
		return out;
	}

	async stat(path: string): Promise<SandboxEntry> {
		return this.entry(path);
	}

	async makeDir(path: string): Promise<void> {
		try {
			mkdirSync(this.host(path), { recursive: true });
		} catch (error) {
			throw fsError(error, path);
		}
	}

	async remove(path: string): Promise<void> {
		try {
			this.entry(path, false);
			rmSync(this.host(path), { recursive: true });
		} catch (error) {
			throw fsError(error, path);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		try {
			mkdirSync(dirname(this.host(to)), { recursive: true });
			renameSync(this.host(from), this.host(to));
		} catch (error) {
			throw fsError(error, from);
		}
	}

	run(command: string, options: SandboxRunOptions = {}): Promise<{ exitCode: number }> {
		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) return reject(new SandboxRunError("aborted", "aborted"));
			const cwd = this.host(options.cwd ?? "/");
			mkdirSync(cwd, { recursive: true });
			const child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, ...options.envs }, detached: true });
			let finished = false;
			const stop = (code: "timeout" | "aborted") => {
				if (finished) return;
				finished = true;
				try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
				reject(new SandboxRunError(code, code === "timeout" ? "Command timed out" : "aborted"));
			};
			const timer = options.timeoutMs ? setTimeout(() => stop("timeout"), options.timeoutMs) : undefined;
			const onAbort = () => stop("aborted");
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.setEncoding("utf8").on("data", (data: string) => options.onStdout?.(data));
			child.stderr.setEncoding("utf8").on("data", (data: string) => options.onStderr?.(data));
			child.once("error", (error) => {
				if (finished) return;
				finished = true;
				reject(new SandboxRunError("unavailable", error.message));
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				if (finished) return;
				finished = true;
				resolve({ exitCode: code ?? 1 });
			});
		});
	}

	async keepAlive(ms: number): Promise<void> {
		this.keepAlives.push(ms);
	}

	async pause(): Promise<void> {
		this.paused = true;
	}

	async kill(): Promise<void> {
		this.killed = true;
		rmSync(this.root, { recursive: true, force: true });
	}
}

function fsError(error: unknown, path: string): SandboxFsError {
	if (error instanceof SandboxFsError) return error;
	const code = (error as NodeJS.ErrnoException)?.code;
	const message = error instanceof Error ? error.message : String(error);
	switch (code) {
		case "ENOENT": return new SandboxFsError("not_found", message, path);
		case "EACCES":
		case "EPERM": return new SandboxFsError("permission_denied", message, path);
		case "ENOTDIR": return new SandboxFsError("not_directory", message, path);
		case "EISDIR": return new SandboxFsError("is_directory", message, path);
		case "EINVAL": return new SandboxFsError("invalid", message, path);
		default: return new SandboxFsError("unknown", message, path);
	}
}

/** Provider for {@link LocalDirSandbox}es; remembers them so `connect` behaves like a real service. */
export class LocalDirSandboxProvider implements SandboxProvider {
	readonly sandboxes = new Map<string, LocalDirSandbox>();
	readonly created: Array<SandboxCreateOptions | undefined> = [];
	private readonly base = mkdtempSync(join(tmpdir(), "inno-localdir-sandboxes-"));

	async create(options?: SandboxCreateOptions): Promise<LocalDirSandbox> {
		this.created.push(options);
		const id = `local-${randomUUID().slice(0, 8)}`;
		const root = join(this.base, id);
		mkdirSync(root, { recursive: true });
		const sandbox = new LocalDirSandbox(id, root);
		sandbox.metadata = options?.metadata ?? {};
		this.sandboxes.set(id, sandbox);
		return sandbox;
	}

	async connect(sandboxId: string): Promise<LocalDirSandbox | null> {
		const sandbox = this.sandboxes.get(sandboxId);
		if (!sandbox || sandbox.killed) return null;
		sandbox.paused = false;
		return sandbox;
	}

	async listManaged(): Promise<ManagedSandboxInfo[]> {
		return [...this.sandboxes.values()].filter((sandbox) => !sandbox.killed).map((sandbox) => ({
			id: sandbox.id,
			createdAt: sandbox.createdAt,
			metadata: sandbox.metadata,
			state: sandbox.paused ? "paused" as const : "running" as const,
		}));
	}

	async destroy(sandboxId: string): Promise<void> {
		await this.sandboxes.get(sandboxId)?.kill();
	}

	dispose(): void {
		rmSync(this.base, { recursive: true, force: true });
	}
}
