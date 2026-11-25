import { l2Store, type L2Target } from "./l2-backend.js";

const ROOT_NON_PAGE_FILES = new Set([
	"wiki/index.md",
	"wiki/log.md",
	"wiki/overview.md",
	"wiki/SCHEMA.md",
	"wiki/PURPOSE.md",
]);

/**
 * Enumerate wiki content recursively instead of assuming a fixed set of
 * built-in folders. Schema-defined page types may live in arbitrary safe
 * subdirectories beneath `wiki/`.
 */
export async function listWikiPagePaths(target: L2Target): Promise<string[]> {
	const paths = await l2Store(target).listPaths("wiki");
	return paths
		.filter((path) => path.endsWith(".md") && !ROOT_NON_PAGE_FILES.has(path))
		.sort((a, b) => a.localeCompare(b, "zh-CN"));
}
