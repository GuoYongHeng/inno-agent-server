import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { normalizeWorkspacePath, WorkspaceStoreError, type WorkspaceEntry, type WorkspaceStore } from "./workspace-store.js";
import type { WorkspaceFileAccess } from "./workspace-files.js";

/**
 * `WorkspaceFileAccess` over any `WorkspaceStore` (manifest + objects, or the
 * local-fs store). `toRelative` accepts relative paths and absolute paths
 * under `modelRoot` (the path the model sees, e.g. the workspace dir or a
 * sandbox mount), and rejects everything `normalizeWorkspacePath` rejects.
 * Local-path consumers get bytes materialized into a mode-0700 temp dir that
 * is always removed afterwards, also when `fn` throws.
 */
export class StoreWorkspaceFileAccess implements WorkspaceFileAccess {
	readonly modelRoot: string;

	constructor(
		private readonly options: {
			store: WorkspaceStore;
			workspaceId: string;
			modelRoot: string;
		},
	) {
		this.modelRoot = options.modelRoot;
	}

	private get store(): WorkspaceStore {
		return this.options.store;
	}

	private get workspaceId(): string {
		return this.options.workspaceId;
	}

	toRelative(userPath: string): string | null {
		const raw = userPath.trim();
		if (!raw) return null;
		let candidate = raw;
		if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
			// Absolute paths are only accepted below the model root.
			const root = resolve(this.modelRoot);
			const target = resolve(raw);
			const rootWithSep = root.endsWith(sep) ? root : root + sep;
			if (target !== root && !target.startsWith(rootWithSep)) return null;
			candidate = target === root ? "" : target.slice(rootWithSep.length);
		}
		try {
			return normalizeWorkspacePath(candidate.split(sep).join("/"));
		} catch (error) {
			if (error instanceof WorkspaceStoreError) return null;
			throw error;
		}
	}

	async stat(relPath: string): Promise<WorkspaceEntry | null> {
		try {
			return await this.store.stat(this.workspaceId, relPath);
		} catch (error) {
			if (error instanceof WorkspaceStoreError) return null;
			throw error;
		}
	}

	async read(relPath: string): Promise<Uint8Array | null> {
		try {
			const result = await this.store.read(this.workspaceId, relPath);
			return result ? result.body : null;
		} catch (error) {
			if (error instanceof WorkspaceStoreError) return null;
			throw error;
		}
	}

	private stagingDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "inno-wfa-"));
		chmodSync(dir, 0o700);
		return dir;
	}

	async withLocalFile<T>(relPath: string, fn: (localPath: string) => Promise<T>): Promise<T | null> {
		const body = await this.read(relPath);
		if (!body) return null;
		const dir = this.stagingDir();
		try {
			// Keep the original base name — parsers dispatch on the extension.
			const filePath = join(dir, basename(relPath));
			writeFileSync(filePath, body);
			return await fn(filePath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	async withLocalDir<T>(relPath: string, fn: (localDir: string) => Promise<T>): Promise<T | null> {
		const entry = await this.stat(relPath);
		if (!entry || entry.kind !== "directory") return null;
		const staging = this.stagingDir();
		try {
			const root = join(staging, "root");
			mkdirSync(root, { recursive: true });
			const prefix = relPath === "" ? "" : `${relPath}/`;
			for await (const item of this.store.walk(this.workspaceId, relPath)) {
				const rel = item.path.slice(prefix.length);
				const target = join(root, ...rel.split("/"));
				if (item.kind === "directory") {
					mkdirSync(target, { recursive: true });
					continue;
				}
				const body = await this.read(item.path);
				if (!body) continue;
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, body);
			}
			return await fn(root);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
}
