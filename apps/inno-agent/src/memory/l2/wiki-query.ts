import { l2Store, type L2Target } from "./l2-backend.js";
import { readManifest } from "./manifest-store.js";
import type { ManifestEntry } from "./types.js";
import type { L2Memory } from "./l2-memory.js";
import type { L2SearchResult } from "./l2-search.js";

export interface WikiQueryHit {
	path: string;
	title: string;
	score: number | null;
	via: string[];
	sourceIds: string[];
}

export interface WikiQueryDetailedResult {
	text: string;
	mode: "indexed" | "substring";
	hits: WikiQueryHit[];
}

/**
 * Read the wiki index.
 */
export async function readIndex(target: L2Target): Promise<string> {
	const store = l2Store(target);
	if (!(await store.exists("wiki/index.md"))) return "L2 Wiki 尚未初始化，暂无索引。";
	return store.readText("wiki/index.md");
}

/**
 * Read a specific wiki page by relative path.
 */
export async function readWikiPage(target: L2Target, relativePath: string): Promise<string | null> {
	const store = l2Store(target);
	if (!(await store.exists(relativePath))) return null;
	return store.readText(relativePath);
}

/**
 * Search manifest entries by keyword.
 * Searches title, tags, AND wiki page body content for full recall.
 */
export async function searchEntries(target: L2Target, query: string): Promise<ManifestEntry[]> {
	const entries = await readManifest(target);
	const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matched: ManifestEntry[] = [];
	for (const entry of entries) {
		// Search title + tags first (fast path)
		const metaText = [entry.title, ...entry.tags].join(" ").toLowerCase();
		if (keywords.some((kw) => metaText.includes(kw))) {
			matched.push(entry);
			continue;
		}
		// Fall back to searching wiki page body content
		for (const wikiPath of entry.wikiPages) {
			const content = await readWikiPage(target, wikiPath);
			if (content && keywords.some((kw) => content.toLowerCase().includes(kw))) {
				matched.push(entry);
				break;
			}
		}
	}
	return matched;
}

/**
 * Query wiki: return index + matched page contents.
 */
export async function queryWiki(target: L2Target, query: string): Promise<string> {
	const index = await readIndex(target);
	const trimmed = (query ?? "").trim();

	// Empty query → just return the index overview.
	if (!trimmed) {
		return `## Wiki 索引\n\n${index}\n\n---\n\n提示：传入 query 参数（如「Python async」）可定位并返回相关页面内容。`;
	}

	const matches = await searchEntries(target, trimmed);

	if (matches.length === 0) {
		return `## Wiki 索引\n\n${index}\n\n---\n\n未找到与「${trimmed}」相关的内容。`;
	}

	const sections: string[] = [
		`## Wiki 索引\n\n${index}`,
		"---",
		`## 查询结果: "${trimmed}" (${matches.length} 条匹配)`,
		"",
	];

	for (const entry of matches.slice(0, 5)) {
		for (const wikiPath of entry.wikiPages) {
			const content = await readWikiPage(target, wikiPath);
			if (content) {
				sections.push(`### [[${entry.title}]]\n`);
				sections.push(content);
				sections.push("---\n");
			}
		}
	}

	return sections.join("\n");
}

/**
 * Query wiki via indexed retrieval (BM25 + graph), falling back to
 * the substring {@link queryWiki} when the index store is unavailable.
 */
export async function queryWikiHybridDetailed(l2Memory: L2Memory, query: string): Promise<WikiQueryDetailedResult> {
	const store = l2Store(l2Memory.dataDir);
	const index = await readIndex(store);
	const trimmed = (query ?? "").trim();

	if (!trimmed) {
		return {
			text: `## Wiki 索引\n\n${index}\n\n---\n\n提示：传入 query 参数（如「Python async」）可定位并返回相关页面内容。`,
			mode: "indexed",
			hits: [],
		};
	}

	const results = await l2Memory.search(trimmed, 5);
	if (results === null) {
		const matches = await searchEntries(store, trimmed);
		return {
			text: await queryWiki(store, query),
			mode: "substring",
			hits: matches.slice(0, 5).flatMap((entry) => entry.wikiPages.map((path) => ({
				path,
				title: entry.title,
				score: null,
				via: ["substring"],
				sourceIds: [entry.id],
			}))),
		};
	}
	if (results.length === 0) {
		return {
			text: `## Wiki 索引\n\n${index}\n\n---\n\n未找到与「${trimmed}」相关的内容。`,
			mode: "indexed",
			hits: [],
		};
	}

	const sections: string[] = [
		`## Wiki 索引\n\n${index}`,
		"---",
		`## 查询结果: "${trimmed}" (${results.length} 条匹配)`,
		"",
	];
	for (const r of results) {
		const content = await readWikiPage(store, r.path);
		if (content) {
			sections.push(`### [[${r.title}]]  \`${r.path}\`  (${r.via.join("+")})\n`);
			sections.push(content);
			sections.push("---\n");
		}
	}
	return {
		text: sections.join("\n"),
		mode: "indexed",
		hits: results.map((result: L2SearchResult) => ({
			path: result.path,
			title: result.title,
			score: result.score,
			via: result.via,
			sourceIds: result.sourceIds,
		})),
	};
}

export async function queryWikiHybrid(l2Memory: L2Memory, query: string): Promise<string> {
	return (await queryWikiHybridDetailed(l2Memory, query)).text;
}
