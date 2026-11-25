import { l2Store, type L2Target } from "./l2-backend.js";
import type { ManifestEntry } from "./types.js";

/**
 * Manifest access over the L2 backend. Local mode reads `manifest.jsonl`;
 * tenant PG storage keeps one row per entry — both expose the same
 * read-modify-write semantics the JSONL file had.
 */

export function readManifest(target: L2Target): Promise<ManifestEntry[]> {
	return l2Store(target).readManifest();
}

/** Insert a manifest entry or atomically replace the existing record with the same id. */
export function upsertManifest(target: L2Target, entry: ManifestEntry): Promise<void> {
	return l2Store(target).upsertManifestEntry(entry);
}

/**
 * Remove a wiki page path from every manifest entry's `wikiPages` list.
 * Keeps entries even if their `wikiPages` becomes empty (the source record
 * is still valid). Returns true if any entry was modified.
 */
export async function removeWikiPathFromManifest(target: L2Target, wikiPath: string): Promise<boolean> {
	const store = l2Store(target);
	const entries = await store.readManifest();
	let changed = false;
	for (const entry of entries) {
		if (entry.wikiPages.includes(wikiPath)) {
			entry.wikiPages = entry.wikiPages.filter((p) => p !== wikiPath);
			changed = true;
		}
	}
	if (changed) await store.writeManifest(entries);
	return changed;
}

export async function findManifestById(target: L2Target, id: string): Promise<ManifestEntry | undefined> {
	return (await readManifest(target)).find((e) => e.id === id);
}

export async function findManifestByTitle(target: L2Target, title: string): Promise<ManifestEntry[]> {
	const lower = title.toLowerCase();
	return (await readManifest(target)).filter((e) => e.title.toLowerCase().includes(lower));
}

export async function findManifestByHash(target: L2Target, contentHash: string): Promise<ManifestEntry | undefined> {
	return (await readManifest(target)).find((e) => e.contentHash === contentHash);
}

export async function findManifestBySourceIdentity(target: L2Target, identity: string): Promise<ManifestEntry | undefined> {
	const normalized = identity.trim();
	if (!normalized) return undefined;
	return (await readManifest(target)).find((entry) => entry.source.identity?.trim() === normalized);
}
