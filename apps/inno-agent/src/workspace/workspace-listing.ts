import { WORKSPACE_IGNORES } from "../server/file-helpers.js";
import type { WorkspaceEntry, WorkspaceListOptions, WorkspaceListPage } from "./workspace-store.js";
import { WorkspaceStoreError } from "./workspace-store.js";

export const WORKSPACE_LIST_DEFAULT_LIMIT = 200;
export const WORKSPACE_LIST_MAX_LIMIT = 1000;

export function listLimit(options?: WorkspaceListOptions): number {
	const limit = options?.limit ?? WORKSPACE_LIST_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new WorkspaceStoreError("invalid_path", "invalid list limit");
	}
	return Math.min(limit, WORKSPACE_LIST_MAX_LIMIT);
}

/** Directories first, then names in zh-CN collation order (tree-route order). */
export function sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
	return entries.sort((a, b) =>
		Number(b.kind === "directory") - Number(a.kind === "directory")
		|| a.name.localeCompare(b.name, "zh-CN"));
}

export function isIgnoredName(name: string): boolean {
	return WORKSPACE_IGNORES.has(name);
}

function encodeOffset(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeOffset(cursor: string): number {
	const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
	if (!Number.isInteger(offset) || offset < 0) {
		throw new WorkspaceStoreError("invalid_path", "invalid list cursor");
	}
	return offset;
}

/** Offset pagination over an already-sorted page set. */
export function pageEntries(entries: WorkspaceEntry[], options?: WorkspaceListOptions): WorkspaceListPage {
	const limit = listLimit(options);
	const offset = options?.cursor ? decodeOffset(options.cursor) : 0;
	const page = entries.slice(offset, offset + limit);
	const next = offset + page.length;
	return {
		entries: page,
		...(next < entries.length ? { nextCursor: encodeOffset(next) } : {}),
	};
}
