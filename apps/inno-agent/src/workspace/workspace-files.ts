import type { WorkspaceEntry } from "./workspace-store.js";

/**
 * How built-in tools read a session's workspace files (roadmap H5). Tools must
 * go through this seam instead of `node:fs` + `workspaceDir`, so the backing
 * can change (a worker directory today, an object-store manifest or a per-task
 * temp directory later) without touching any tool.
 *
 * Paths handed to a tool come from the model or the user, so every entry point
 * takes the RAW path and resolves it here. The implementation owns the single
 * definition of "inside the workspace" (relative paths, absolute paths under
 * `modelRoot`, no ".." escape, no symlink escape where the backing has symlinks).
 */
export interface WorkspaceFileAccess {
	/**
	 * Map a model/user supplied path to a canonical workspace-relative POSIX path
	 * ("" is the workspace root), or null when it is invalid or outside the
	 * workspace. Accepts relative paths and absolute paths below `modelRoot`.
	 * Never throws for bad input.
	 */
	toRelative(userPath: string): string | null;

	/** Entry for a workspace-relative path, or null when missing. */
	stat(relPath: string): Promise<WorkspaceEntry | null>;

	/** Whole-file bytes, or null when the path is missing or not a file. */
	read(relPath: string): Promise<Uint8Array | null>;

	/**
	 * Run `fn` with a real local path for a FILE, for libraries that only accept
	 * a path (document parsers, channel uploads). A backing that already has a
	 * local file passes its real path (no copy); otherwise the bytes are written
	 * to a fresh temp directory under the ORIGINAL base name and the temp
	 * directory is ALWAYS removed afterwards, also when `fn` throws. Returns
	 * `null` without calling `fn` when the file does not exist.
	 */
	withLocalFile<T>(relPath: string, fn: (localPath: string) => Promise<T>): Promise<T | null>;

	/**
	 * Same for a DIRECTORY subtree (e.g. `.skills`): `fn` gets a real local
	 * directory containing the subtree. Returns `null` without calling `fn` when
	 * the directory does not exist.
	 */
	withLocalDir<T>(relPath: string, fn: (localDir: string) => Promise<T>): Promise<T | null>;
}
