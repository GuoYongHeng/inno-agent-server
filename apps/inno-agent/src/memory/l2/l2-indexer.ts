/**
 * L2 page indexer.
 *
 * Reads wiki pages under `wiki/`, parses their frontmatter, and upserts them
 * into the L2 retrieval index. Indexing is incremental by content hash: a
 * page is re-indexed only when its bytes change. `indexAllPages` also prunes
 * index rows whose file no longer exists, so it doubles as an idempotent
 * backfill. Works on any {@link L2Backend} — files or PostgreSQL.
 */

import { createHash } from "node:crypto";
import { l2Store, type L2Backend, type L2Target } from "./l2-backend.js";
import { parseFrontmatter } from "./wiki-maintainer.js";
import type { L2PageDoc } from "./l2-index-store.js";
import { listWikiPagePaths } from "./wiki-page-files.js";

function contentHashOf(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function inferTypeFromPath(wikiPath: string): string {
	if (wikiPath.includes("entities/")) return "entity";
	if (wikiPath.includes("concepts/")) return "concept";
	if (wikiPath.includes("queries/")) return "query";
	if (wikiPath.includes("comparisons/")) return "comparison";
	if (wikiPath.includes("synthesis/")) return "synthesis";
	if (wikiPath.includes("analysis/")) return "analysis";
	return "source-summary";
}

/**
 * Index one wiki page by its wiki-relative path. Returns true if the store was
 * written (false when the file is missing/empty or unchanged since last index).
 */
export async function indexPage(store: L2Backend, wikiPath: string): Promise<boolean> {
	const content = await store.readText(wikiPath);
	if (!content.trim()) return false;

	const hash = contentHashOf(content);
	const prev = await store.getIndexState(wikiPath);
	if (prev && prev.contentHash === hash) return false; // unchanged

	const { frontmatter, body } = parseFrontmatter(content);
	const mtimeMs = (await store.stat(wikiPath))?.mtimeMs ?? 0;

	const doc: L2PageDoc = {
		path: wikiPath,
		title: frontmatter?.title || wikiPath.split("/").pop()?.replace(/\.md$/, "") || wikiPath,
		type: frontmatter?.type || inferTypeFromPath(wikiPath),
		tags: frontmatter?.tags ?? [],
		sourceIds: frontmatter?.source_ids ?? [],
		body,
		contentHash: hash,
		mtimeMs,
	};
	await store.upsertIndexPage(doc);
	await store.setIndexState(wikiPath, hash, mtimeMs);
	return true;
}

/**
 * Index every wiki page, pruning index rows for files that no longer exist.
 * Idempotent — unchanged pages are skipped, so re-runs are cheap.
 */
export async function indexAllPages(target: L2Target): Promise<{ indexed: number; pruned: number }> {
	const store = l2Store(target);
	const present = new Set<string>();
	let indexed = 0;
	for (const wikiPath of await listWikiPagePaths(store)) {
		present.add(wikiPath);
		if (await indexPage(store, wikiPath)) indexed++;
	}
	let pruned = 0;
	for (const p of await store.listIndexedPaths()) {
		if (!present.has(p)) {
			await store.deleteIndexPage(p);
			pruned++;
		}
	}
	return { indexed, pruned };
}

export async function removePageFromIndex(store: L2Backend, wikiPath: string): Promise<void> {
	await store.deleteIndexPage(wikiPath);
}
