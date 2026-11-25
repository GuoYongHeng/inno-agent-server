import type { ContentCategory } from "./types.js";

type CatalogCacheEntry = {
	items: unknown[];
};

/**
 * In-memory stale-while-revalidate snapshots for the remote content hub. They
 * live only for the process (nothing is written to disk); a restart simply
 * refetches the catalog.
 */
export class CatalogSnapshotCache {
	private cacheHubKey = "";
	private entries: Partial<Record<ContentCategory, CatalogCacheEntry>> = {};

	constructor(private readonly getHubKey: () => string) {}

	getItems<T>(category: ContentCategory): T[] | null {
		this.ensureCurrent();
		const entry = this.entries[category];
		return entry ? entry.items as T[] : null;
	}

	save(category: ContentCategory, items: unknown[], key: string): void {
		if (this.getHubKey() !== key) return;
		this.ensureCurrent(key);
		this.entries[category] = { items };
	}

	invalidate(): void {
		this.cacheHubKey = "";
		this.entries = {};
	}

	/** Entries belong to one hub configuration; a different hub starts empty. */
	private ensureCurrent(key = this.getHubKey()): void {
		if (this.cacheHubKey === key) return;
		this.cacheHubKey = key;
		this.entries = {};
	}
}
