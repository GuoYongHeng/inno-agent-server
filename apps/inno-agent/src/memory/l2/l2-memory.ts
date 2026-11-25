/**
 * L2 wiki memory holder.
 *
 * Keeps the retrieval index in sync with the wiki pages in the L2 backend.
 * Retrieval (lexical + graph) is layered on in l2-search.ts and exposed via
 * {@link L2Memory.search}. The backend is resolved per data dir through
 * {@link l2BackendFor}: a local file store by default, or the tenant's
 * PostgreSQL backend when one is mounted in authenticated mode.
 *
 * Local mode degrades to substring search when node:sqlite is unavailable so
 * the agent keeps working on older runtimes.
 *
 * Use {@link getL2Memory} to obtain a per-dir singleton so the agent extension
 * and the HTTP server share ONE handle within a process.
 */

import { logger } from "../../logger.js";
import { l2BackendFor, closeL2Backend, type L2Backend } from "./l2-backend.js";
import { indexAllPages, indexPage, removePageFromIndex } from "./l2-indexer.js";
import { searchL2, type L2SearchResult } from "./l2-search.js";

export class L2Memory {
	private backfilled = false;
	private backfillPromise: Promise<void> | null = null;

	constructor(private readonly l2DataDir: string) {}

	private backend(): L2Backend {
		return l2BackendFor(this.l2DataDir);
	}

	/** The storage backend for this data dir (file store or tenant PG store). */
	async getStore(): Promise<L2Backend> {
		return this.backend();
	}

	get dataDir(): string {
		return this.l2DataDir;
	}

	/**
	 * One-time backfill of all existing wiki pages (cheap: skips unchanged
	 * files). Index sync always runs — even when L2 is disabled — so the
	 * layer can be re-enabled without a backfill gap (same philosophy as L3).
	 */
	async backfill(): Promise<void> {
		if (this.backfilled) return;
		if (this.backfillPromise) return this.backfillPromise;
		const run = this.runBackfill();
		this.backfillPromise = run;
		try {
			await run;
		} finally {
			if (this.backfillPromise === run) this.backfillPromise = null;
		}
	}

	private async runBackfill(): Promise<void> {
		const store = this.backend();
		if (!(await store.indexAvailable())) return;
		try {
			const { indexed, pruned } = await indexAllPages(store);
			this.backfilled = true;
			if (indexed > 0 || pruned > 0) logger.info(`[L2] backfill indexed ${indexed} page(s), pruned ${pruned}.`);
		} catch (err) {
			logger.warn({ err }, `[L2] backfill failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Reconcile every page after an incremental update failed in this process. */
	async reconcile(): Promise<boolean> {
		const store = this.backend();
		if (!(await store.indexAvailable())) return false;
		try {
			await indexAllPages(store);
			return true;
		} catch (err) {
			logger.warn({ err }, `[L2] reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** Incrementally (re)index a single wiki page by its wiki-relative path. */
	async indexPageByPath(wikiPath: string): Promise<void> {
		if (!wikiPath) return;
		const store = this.backend();
		if (!(await store.indexAvailable())) return;
		await indexPage(store, wikiPath);
	}

	/**
	 * Search indexed pages (lexical BM25 + graph expansion). Returns null when
	 * the index is unavailable, so callers can fall back to the legacy
	 * substring search.
	 */
	async search(query: string, limit = 5): Promise<L2SearchResult[] | null> {
		const store = this.backend();
		if (!(await store.indexAvailable())) return null;
		try {
			return await searchL2(store, query, { limit });
		} catch (err) {
			logger.warn({ err }, `[L2] search failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** Remove a page from the index (after the page file is deleted). */
	async removePage(wikiPath: string): Promise<void> {
		if (!wikiPath) return;
		const store = this.backend();
		try {
			await removePageFromIndex(store, wikiPath);
		} catch (err) {
			logger.warn({ err }, `[L2] remove ${wikiPath} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Close the backend and reset the registry entry so the holder can be
	 * reused. Mainly needed by tests: on Windows an open sqlite handle keeps
	 * index.db locked and temp-dir cleanup fails with EBUSY.
	 */
	close(): void {
		this.backfilled = false;
		this.backfillPromise = null;
		closeL2Backend(this.l2DataDir);
	}
}

const registry = new Map<string, L2Memory>();

/** Per-dir singleton so the agent extension and HTTP server share one handle. */
export function getL2Memory(l2DataDir: string): L2Memory {
	let mem = registry.get(l2DataDir);
	if (!mem) {
		mem = new L2Memory(l2DataDir);
		registry.set(l2DataDir, mem);
	}
	return mem;
}

/**
 * Close and drop the per-dir singleton. Tests must call this before deleting
 * their temp data dir, otherwise the open sqlite handle keeps index.db locked
 * on Windows and cleanup fails with EBUSY.
 */
export function closeL2Memory(l2DataDir: string): void {
	const mem = registry.get(l2DataDir);
	if (mem) {
		mem.close();
		registry.delete(l2DataDir);
		return;
	}
	closeL2Backend(l2DataDir);
}
