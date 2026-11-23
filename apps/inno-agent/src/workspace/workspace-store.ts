/**
 * Where a workspace's files live, behind one interface, so the HTTP routes and
 * (later) the tools never touch a worker's disk directly (roadmap H5).
 *
 * Two implementations:
 * - `LocalFsWorkspaceStore`: the existing file-backed behaviour (local mode).
 * - `ObjectWorkspaceStore`: PostgreSQL `workspace_files` manifest + `ObjectStore`
 *   bytes (authenticated mode). The manifest is the index (directory listing,
 *   sizes, empty directories); the object store holds the bytes.
 *
 * Paths are POSIX, relative to the workspace root, with no leading slash. The
 * empty string is the root. `normalizeWorkspacePath` is the only accepted way
 * in; both implementations reject anything it rejects.
 */

export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceEntry {
	/** POSIX path relative to the workspace root; "" is the root. */
	path: string;
	name: string;
	kind: WorkspaceEntryKind;
	/** 0 for directories. */
	size: number;
	mtimeMs: number;
}

export interface WorkspaceListPage {
	entries: WorkspaceEntry[];
	/** Opaque; pass back as `cursor` for the next page. Absent on the last page. */
	nextCursor?: string;
}

export interface WorkspaceListOptions {
	/** Default 200, max 1000. */
	limit?: number;
	cursor?: string;
}

export type WorkspaceStoreErrorCode =
	| "not_found"
	| "exists"
	| "not_directory"
	| "is_directory"
	| "invalid_path"
	| "too_large"
	| "limit_exceeded";

export class WorkspaceStoreError extends Error {
	constructor(readonly code: WorkspaceStoreErrorCode, message: string, readonly path?: string) {
		super(message);
		this.name = "WorkspaceStoreError";
	}
}

/** Largest single file the store accepts (matches the HTTP upload body limit). */
export const WORKSPACE_MAX_FILE_BYTES = 192 * 1024 * 1024;

/**
 * Normalise a user-supplied workspace path. Returns the canonical POSIX
 * relative path ("" for the root). Throws `WorkspaceStoreError("invalid_path")`
 * for: absolute paths (leading "/" or a Windows drive prefix), any ".." segment,
 * NUL bytes, backslashes, and empty segments other than leading "./" noise.
 * "./a//b/" normalises to "a/b".
 */
export function normalizeWorkspacePath(input: string): string {
	if (input.includes("\0") || input.includes("\\")) {
		throw new WorkspaceStoreError("invalid_path", "invalid workspace path", input);
	}
	if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
		throw new WorkspaceStoreError("invalid_path", "workspace path must be relative", input);
	}
	const parts: string[] = [];
	for (const part of input.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") throw new WorkspaceStoreError("invalid_path", "workspace path escapes the root", input);
		parts.push(part);
	}
	return parts.join("/");
}

export interface WorkspaceStore {
	/**
	 * Direct children of `dir` (a directory), directories first, then names in
	 * zh-CN collation order. Entries whose name is in `WORKSPACE_IGNORES`
	 * (server/file-helpers.ts) are omitted. Throws `not_found` when `dir` does not
	 * exist and `not_directory` when it is a file. A directory exists if it has an
	 * explicit entry OR any descendant.
	 */
	list(workspaceId: string, dir: string, options?: WorkspaceListOptions): Promise<WorkspaceListPage>;

	/** The entry at `path`, or null. The root ("") is always a directory entry. */
	stat(workspaceId: string, path: string): Promise<WorkspaceEntry | null>;

	/** Whole-file read. null when `path` is missing or a directory. Throws `too_large` above `WORKSPACE_MAX_FILE_BYTES`. */
	read(workspaceId: string, path: string): Promise<{ entry: WorkspaceEntry; body: Uint8Array } | null>;

	/**
	 * Create or replace a file; missing parent directories are created. Throws
	 * `is_directory` when `path` is an existing directory, `not_directory` when a
	 * parent is an existing file, `too_large` above `WORKSPACE_MAX_FILE_BYTES`.
	 * Never writes an ignored path component silently: ignored names are allowed
	 * (the store is not a filter on writes), they are only hidden from `list`/`walk`.
	 */
	write(workspaceId: string, path: string, body: Uint8Array): Promise<WorkspaceEntry>;

	/** Idempotent `mkdir -p`. Throws `not_directory` when a segment is an existing file. */
	mkdir(workspaceId: string, path: string): Promise<WorkspaceEntry>;

	/**
	 * Remove a file, or a directory with `recursive: true`. A non-empty directory
	 * without `recursive` throws `exists`. Missing paths throw `not_found`.
	 * The root cannot be removed (`invalid_path`).
	 */
	remove(workspaceId: string, path: string, options?: { recursive?: boolean }): Promise<void>;

	/**
	 * Rename/move a file or a whole directory subtree. Throws `not_found` for a
	 * missing source, `exists` when the destination exists, `invalid_path` when
	 * moving a directory into itself or moving the root.
	 */
	move(workspaceId: string, from: string, to: string): Promise<void>;

	/**
	 * Every entry under `dir`, recursively (files AND explicit/implied
	 * directories), ignored names omitted, in path order. For zip download and
	 * previews. Throws `limit_exceeded` past `maxEntries` (default 50_000).
	 */
	walk(workspaceId: string, dir: string, options?: { maxEntries?: number }): AsyncIterable<WorkspaceEntry>;

	/** Drop every entry of the workspace (workspace deletion). */
	deleteAll(workspaceId: string): Promise<void>;
}
