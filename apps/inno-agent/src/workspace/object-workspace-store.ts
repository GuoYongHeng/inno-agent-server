import { logger } from "../logger.js";
import type { ObjectStore } from "../object-store/object-store.js";
import type { TenantContext, TenantStore, WorkspaceFileRow } from "../tenants/store.js";
import { workspaceObjectKey, workspaceObjectPrefix } from "./workspace-object-key.js";
import { isIgnoredName, pageEntries } from "./workspace-listing.js";
import {
	normalizeWorkspacePath,
	WORKSPACE_MAX_FILE_BYTES,
	WorkspaceStoreError,
	type WorkspaceEntry,
	type WorkspaceListOptions,
	type WorkspaceListPage,
	type WorkspaceStore,
} from "./workspace-store.js";

/** Manifest rows fetched under one prefix for a single operation. */
const ROW_SCAN_CAP = 100_000;

function fail(code: ConstructorParameters<typeof WorkspaceStoreError>[0], message: string, path?: string): never {
	throw new WorkspaceStoreError(code, message, path);
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function parentChain(path: string): string[] {
	const segments = path.split("/");
	const chain: string[] = [];
	for (let index = 0; index < segments.length - 1; index++) {
		chain.push(segments.slice(0, index + 1).join("/"));
	}
	return chain;
}

/**
 * Workspace files as a PostgreSQL `workspace_files` manifest plus `ObjectStore`
 * bytes (authenticated mode). The manifest is the index — listings, directory
 * existence (explicit row or any descendant row) and sizes come from it; the
 * object store holds only file bytes. Ordering rules keep the two consistent
 * across a crash: objects are written before manifest rows point at them, and
 * manifest rows are removed before their objects are deleted (orphan bytes are
 * harmless; a row pointing at missing bytes is not).
 */
export class ObjectWorkspaceStore implements WorkspaceStore {
	private readonly maxFileBytes: number;

	constructor(
		private readonly options: {
			objects: ObjectStore;
			store: TenantStore;
			context: TenantContext;
			maxFileBytes?: number;
		},
	) {
		this.maxFileBytes = options.maxFileBytes ?? WORKSPACE_MAX_FILE_BYTES;
	}

	private key(workspaceId: string, relPath: string): string {
		return workspaceObjectKey(this.options.context.tenantId, workspaceId, relPath);
	}

	private async row(workspaceId: string, relPath: string): Promise<WorkspaceFileRow | null> {
		return this.options.store.getWorkspaceFile(this.options.context, workspaceId, relPath);
	}

	private async rowsUnder(workspaceId: string, dir: string, cap = ROW_SCAN_CAP): Promise<WorkspaceFileRow[]> {
		const prefix = dir === "" ? "" : `${dir}/`;
		const rows = await this.options.store.listWorkspaceFilesUnder(this.options.context, workspaceId, prefix, cap + 1);
		if (rows.length > cap) fail("limit_exceeded", `too many manifest rows under ${prefix || "/"}`);
		return rows;
	}

	private async summarize(workspaceId: string, dir: string): Promise<{ count: number; maxMtimeMs: number }> {
		return this.options.store.summarizeWorkspacePrefix(
			this.options.context, workspaceId, dir === "" ? "" : `${dir}/`,
		);
	}

	private async dirExists(workspaceId: string, dir: string): Promise<boolean> {
		const row = await this.row(workspaceId, dir);
		if (row?.kind === "directory") return true;
		if (row?.kind === "file") return false;
		return (await this.summarize(workspaceId, dir)).count > 0;
	}

	private entryOf(row: WorkspaceFileRow): WorkspaceEntry {
		return {
			path: row.relPath,
			name: basename(row.relPath),
			kind: row.kind,
			size: row.kind === "file" ? row.size : 0,
			mtimeMs: row.mtimeMs,
		};
	}

	/**
	 * Ancestor paths that resolve to a FILE row reject directory-ish writes;
	 * missing ancestors gain an explicit directory row so the manifest keeps
	 * the replica push's shape (empty dirs survive a pull round-trip).
	 */
	private async ensureAncestors(workspaceId: string, path: string): Promise<void> {
		for (const ancestor of parentChain(path)) {
			const row = await this.row(workspaceId, ancestor);
			if (row?.kind === "file") fail("not_directory", `not a directory: ${ancestor}`, ancestor);
			if (!row) {
				await this.options.store.putWorkspaceFile(this.options.context, workspaceId,
					{ relPath: ancestor, kind: "directory", size: 0, mtimeMs: Date.now() });
			}
		}
	}

	async list(workspaceId: string, dir: string, options?: WorkspaceListOptions): Promise<WorkspaceListPage> {
		const target = normalizeWorkspacePath(dir);
		if (target !== "") {
			const row = await this.row(workspaceId, target);
			if (row?.kind === "file") fail("not_directory", `not a directory: ${target}`, target);
			if (!row && !(await this.dirExists(workspaceId, target))) {
				fail("not_found", `directory not found: ${target}`, target);
			}
		}
		const prefix = target === "" ? "" : `${target}/`;
		const rows = await this.rowsUnder(workspaceId, target);
		const children = new Map<string, WorkspaceEntry>();
		const impliedNames = new Set<string>();
		for (const row of rows) {
			const rest = row.relPath.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) {
				children.set(rest, this.entryOf(row));
				impliedNames.delete(rest);
			} else {
				// Deeper rows imply a directory child that may have no explicit row.
				const impliedPath = prefix + rest.slice(0, slash);
				const name = rest.slice(0, slash);
				const implied = children.get(name);
				if (!implied) {
					impliedNames.add(name);
					children.set(name, {
						path: impliedPath, name, kind: "directory", size: 0,
						mtimeMs: row.mtimeMs,
					});
				} else if (impliedNames.has(name)) {
					implied.mtimeMs = Math.max(implied.mtimeMs, row.mtimeMs);
				}
			}
		}
		const entries = [...children.values()].filter((entry) => !isIgnoredName(entry.name));
		return pageEntries(entries.sort((a, b) =>
			Number(b.kind === "directory") - Number(a.kind === "directory")
			|| a.name.localeCompare(b.name, "zh-CN")), options);
	}

	async stat(workspaceId: string, path: string): Promise<WorkspaceEntry | null> {
		const target = normalizeWorkspacePath(path);
		if (target === "") return { path: "", name: "", kind: "directory", size: 0, mtimeMs: 0 };
		const row = await this.row(workspaceId, target);
		if (row) return this.entryOf(row);
		const summary = await this.summarize(workspaceId, target);
		if (summary.count === 0) return null;
		return {
			path: target,
			name: basename(target),
			kind: "directory",
			size: 0,
			mtimeMs: summary.maxMtimeMs,
		};
	}

	async read(workspaceId: string, path: string): Promise<{ entry: WorkspaceEntry; body: Uint8Array } | null> {
		const target = normalizeWorkspacePath(path);
		if (target === "") return null;
		const row = await this.row(workspaceId, target);
		if (!row || row.kind === "directory") return null;
		if (row.size > this.maxFileBytes) fail("too_large", `file too large: ${target}`, target);
		const body = await this.options.objects.get(this.key(workspaceId, target));
		if (!body) throw new Error(`workspace manifest row without object: ${target}`);
		return { entry: this.entryOf(row), body };
	}

	async write(workspaceId: string, path: string, body: Uint8Array): Promise<WorkspaceEntry> {
		const target = normalizeWorkspacePath(path);
		if (target === "") fail("is_directory", "cannot write the workspace root", target);
		if (body.byteLength > this.maxFileBytes) fail("too_large", `file too large: ${target}`, target);
		const existing = await this.row(workspaceId, target);
		if (existing?.kind === "directory") fail("is_directory", `is a directory: ${target}`, target);
		if (!existing && (await this.summarize(workspaceId, target)).count > 0) {
			fail("is_directory", `is a directory: ${target}`, target);
		}
		await this.ensureAncestors(workspaceId, target);
		// Bytes first: the manifest row is written only once the object exists,
		// so a crash can never leave a row pointing at missing bytes.
		await this.options.objects.put(this.key(workspaceId, target), body);
		const row: WorkspaceFileRow = { relPath: target, kind: "file", size: body.byteLength, mtimeMs: Date.now() };
		await this.options.store.putWorkspaceFile(this.options.context, workspaceId, row);
		return this.entryOf(row);
	}

	/**
	 * Register a manifest row for bytes already present in the object store
	 * (T1.5 presigned direct upload): the same structural checks as `write`,
	 * but the caller supplies the verified size instead of the body.
	 */
	async adopt(workspaceId: string, path: string, size: number): Promise<WorkspaceEntry> {
		const target = normalizeWorkspacePath(path);
		if (target === "") fail("is_directory", "cannot write the workspace root", target);
		if (size > this.maxFileBytes) fail("too_large", `file too large: ${target}`, target);
		const existing = await this.row(workspaceId, target);
		if (existing?.kind === "directory") fail("is_directory", `is a directory: ${target}`, target);
		if (!existing && (await this.summarize(workspaceId, target)).count > 0) {
			fail("is_directory", `is a directory: ${target}`, target);
		}
		await this.ensureAncestors(workspaceId, target);
		const row: WorkspaceFileRow = { relPath: target, kind: "file", size, mtimeMs: Date.now() };
		await this.options.store.putWorkspaceFile(this.options.context, workspaceId, row);
		return this.entryOf(row);
	}

	async mkdir(workspaceId: string, path: string): Promise<WorkspaceEntry> {
		const target = normalizeWorkspacePath(path);
		if (target === "") return { path: "", name: "", kind: "directory", size: 0, mtimeMs: 0 };
		const existing = await this.row(workspaceId, target);
		if (existing?.kind === "file") fail("not_directory", `not a directory: ${target}`, target);
		await this.ensureAncestors(workspaceId, target);
		const row: WorkspaceFileRow = { relPath: target, kind: "directory", size: 0, mtimeMs: Date.now() };
		await this.options.store.putWorkspaceFile(this.options.context, workspaceId, row);
		return this.entryOf(row);
	}

	async remove(workspaceId: string, path: string, options?: { recursive?: boolean }): Promise<void> {
		const target = normalizeWorkspacePath(path);
		if (target === "") fail("invalid_path", "cannot remove the workspace root", target);
		const row = await this.row(workspaceId, target);
		const descendants = row?.kind === "file" ? [] : await this.rowsUnder(workspaceId, target);
		if (!row && descendants.length === 0) fail("not_found", `not found: ${target}`, target);
		const isDir = !row || row.kind === "directory";
		if (isDir && descendants.length > 0 && options?.recursive !== true) {
			fail("exists", `directory not empty: ${target}`, target);
		}
		// Manifest first, objects after: a row must never point at missing bytes;
		// orphan objects left by a crash here are harmless.
		const removed = await this.options.store.deleteWorkspaceFiles(
			this.options.context, workspaceId, target, isDir && descendants.length > 0,
		);
		for (const entry of removed) {
			if (entry.kind !== "file") continue;
			await this.options.objects.delete(this.key(workspaceId, entry.relPath))
				.catch((error) => logger.warn({ err: error, rel: entry.relPath }, "workspace object delete failed (orphan left)"));
		}
	}

	async move(workspaceId: string, from: string, to: string): Promise<void> {
		const source = normalizeWorkspacePath(from);
		const destination = normalizeWorkspacePath(to);
		if (source === "" || destination === "" || source === destination || destination.startsWith(`${source}/`)) {
			fail("invalid_path", `invalid move: ${source} -> ${destination}`, destination);
		}
		const srcRow = await this.row(workspaceId, source);
		const srcRows = srcRow?.kind === "file" ? [] : await this.rowsUnder(workspaceId, source);
		if (!srcRow && srcRows.length === 0) fail("not_found", `not found: ${source}`, source);
		const dstRow = await this.row(workspaceId, destination);
		if (dstRow || (await this.summarize(workspaceId, destination)).count > 0) {
			fail("exists", `destination exists: ${destination}`, destination);
		}
		await this.ensureAncestors(workspaceId, destination);

		const moved = [...(srcRow ? [srcRow] : []), ...srcRows];
		const files = moved.filter((row) => row.kind === "file");
		const writtenKeys: string[] = [];
		try {
			// Destination objects first: at no point may the manifest point at
			// bytes that do not exist; leftovers on failure are orphans only.
			for (const row of files) {
				const body = await this.options.objects.get(this.key(workspaceId, row.relPath));
				if (!body) throw new Error(`workspace manifest row without object: ${row.relPath}`);
				const key = this.key(workspaceId, destination + row.relPath.slice(source.length));
				await this.options.objects.put(key, body);
				writtenKeys.push(key);
			}
			await this.options.store.moveWorkspaceFiles(this.options.context, workspaceId, source, destination);
		} catch (error) {
			for (const key of writtenKeys) {
				await this.options.objects.delete(key).catch(() => undefined);
			}
			throw error;
		}
		for (const row of files) {
			await this.options.objects.delete(this.key(workspaceId, row.relPath))
				.catch((error) => logger.warn({ err: error, rel: row.relPath }, "workspace object delete failed after move (orphan left)"));
		}
	}

	async *walk(workspaceId: string, dir: string, options?: { maxEntries?: number }): AsyncIterable<WorkspaceEntry> {
		const target = normalizeWorkspacePath(dir);
		const maxEntries = options?.maxEntries ?? 50_000;
		if (target !== "") {
			const row = await this.row(workspaceId, target);
			if (row?.kind === "file") fail("not_directory", `not a directory: ${target}`, target);
		}
		const rows = await this.rowsUnder(workspaceId, target, maxEntries);
		const prefix = target === "" ? "" : `${target}/`;
		if (target !== "" && rows.length === 0 && !(await this.row(workspaceId, target))) {
			fail("not_found", `directory not found: ${target}`, target);
		}
		const entries = new Map<string, WorkspaceEntry>();
		for (const row of rows) {
			if (row.relPath.split("/").some((segment) => isIgnoredName(segment))) continue;
			entries.set(row.relPath, this.entryOf(row));
			// Materialise implied ancestor directories between dir and the row.
			const segments = row.relPath.slice(prefix.length).split("/");
			for (let index = 1; index < segments.length; index++) {
				const impliedPath = prefix + segments.slice(0, index).join("/");
				const implied = entries.get(impliedPath);
				if (!implied) {
					entries.set(impliedPath, {
						path: impliedPath, name: segments[index - 1]!, kind: "directory",
						size: 0, mtimeMs: row.mtimeMs,
					});
				} else if (implied.kind === "directory") {
					implied.mtimeMs = Math.max(implied.mtimeMs, row.mtimeMs);
				}
			}
		}
		const sorted = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
		if (sorted.length > maxEntries) fail("limit_exceeded", `walk exceeds ${maxEntries} entries under ${target || "/"}`);
		for (const entry of sorted) yield entry;
	}

	async deleteAll(workspaceId: string): Promise<void> {
		await this.options.store.deleteAllWorkspaceFiles(this.options.context, workspaceId);
		await this.options.objects.deletePrefix(workspaceObjectPrefix(this.options.context.tenantId, workspaceId))
			.catch((error) => logger.warn({ err: error, workspaceId }, "workspace object cleanup failed (orphans left)"));
	}
}
