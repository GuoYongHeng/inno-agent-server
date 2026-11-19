import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Per-session directories kept beside the catalog, keyed by session ID. */
const SESSION_DIRS = ["storage", "questions", "permissions"] as const;

export interface OrphanedSessionData {
	/** Session ID found on disk but missing from `sessions.json`. */
	sessionId: string;
	/** Absolute directories belonging to that session. */
	paths: string[];
}

function catalogIds(root: string): Set<string> {
	const path = join(root, "sessions.json");
	if (!existsSync(path)) return new Set();
	try {
		const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(value)) return new Set();
		return new Set(value.flatMap((item) => (
			item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
				? [(item as { id: string }).id] : []
		)));
	} catch {
		// An unreadable catalog must never be treated as "no sessions": that would
		// classify every session directory as an orphan.
		throw new Error(`Cannot read session catalog at ${path}; refusing to classify orphans`);
	}
}

/**
 * Find per-session data whose catalog record is gone. Delete removes the catalog
 * record first and the data afterwards, so a crash in between leaves exactly
 * this. Read-only; use {@link removeOrphanedSessionData} to repair.
 */
export function findOrphanedSessionData(root: string): OrphanedSessionData[] {
	const known = catalogIds(root);
	const byId = new Map<string, string[]>();
	for (const dir of SESSION_DIRS) {
		const base = join(root, dir);
		if (!existsSync(base)) continue;
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory() || known.has(entry.name)) continue;
			byId.set(entry.name, [...(byId.get(entry.name) ?? []), join(base, entry.name)]);
		}
	}
	return [...byId].map(([sessionId, paths]) => ({ sessionId, paths }))
		.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** Remove the orphans {@link findOrphanedSessionData} reports; returns the IDs removed. */
export function removeOrphanedSessionData(root: string): string[] {
	const orphans = findOrphanedSessionData(root);
	for (const orphan of orphans) {
		for (const path of orphan.paths) rmSync(path, { recursive: true, force: true });
	}
	return orphans.map((orphan) => orphan.sessionId);
}
