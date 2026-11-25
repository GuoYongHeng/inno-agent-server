import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { checkWorkspaceMutationPath } from "../agent/workspace-path-guard.js";
import { normalizeWorkspacePath, WorkspaceStoreError, type WorkspaceEntry } from "./workspace-store.js";
import type { WorkspaceFileAccess } from "./workspace-files.js";

/**
 * `WorkspaceFileAccess` over a real workspace directory: today's behaviour.
 * `toRelative` is exactly `checkWorkspaceMutationPath`'s allow/deny rule (the
 * guard itself stays in place for its existing mutation callers), including
 * absolute paths under the root, `..` escapes and symlink escapes via realpath.
 * `withLocalFile`/`withLocalDir` hand out the real (lexical) path — no copy.
 */
export class LocalWorkspaceFileAccess implements WorkspaceFileAccess {
	readonly modelRoot: string;

	constructor(options: { root: string }) {
		this.modelRoot = options.root;
	}

	private get root(): string {
		return this.modelRoot;
	}

	toRelative(userPath: string): string | null {
		const check = checkWorkspaceMutationPath(this.root, userPath);
		if (!check.allowed || !check.resolvedPath) return null;
		const rel = relative(resolve(this.root), check.resolvedPath).split(sep).join("/");
		// The workspace rel-path domain is stricter than the mutation guard
		// (which accepts POSIX-legal names like "a\b" or NUL-containing names);
		// anything outside the domain cannot be addressed by callers anyway.
		try {
			return normalizeWorkspacePath(rel);
		} catch (error) {
			if (error instanceof WorkspaceStoreError) return null;
			throw error;
		}
	}

	/** Same lexical resolution the tools historically used via the guard. */
	private resolveExisting(relPath: string): string | null {
		const check = checkWorkspaceMutationPath(this.root, relPath);
		return check.allowed && check.resolvedPath ? check.resolvedPath : null;
	}

	async stat(relPath: string): Promise<WorkspaceEntry | null> {
		const full = relPath === "" ? this.root : this.resolveExisting(relPath);
		if (!full) return null;
		try {
			const stats = statSync(full);
			return {
				path: relPath,
				name: relPath.slice(relPath.lastIndexOf("/") + 1),
				kind: stats.isDirectory() ? "directory" : "file",
				size: stats.isDirectory() ? 0 : stats.size,
				mtimeMs: stats.mtimeMs,
			};
		} catch {
			return null;
		}
	}

	async read(relPath: string): Promise<Uint8Array | null> {
		const full = this.resolveExisting(relPath);
		if (!full) return null;
		try {
			const stats = statSync(full);
			if (!stats.isFile()) return null;
			return new Uint8Array(readFileSync(full));
		} catch {
			return null;
		}
	}

	async withLocalFile<T>(relPath: string, fn: (localPath: string) => Promise<T>): Promise<T | null> {
		const full = this.resolveExisting(relPath);
		if (!full) return null;
		try {
			if (!statSync(full).isFile()) return null;
		} catch {
			return null;
		}
		return fn(full);
	}

	async withLocalDir<T>(relPath: string, fn: (localDir: string) => Promise<T>): Promise<T | null> {
		const full = relPath === "" ? this.root : this.resolveExisting(relPath);
		if (!full) return null;
		try {
			if (!statSync(full).isDirectory()) return null;
		} catch {
			return null;
		}
		return fn(full);
	}
}
