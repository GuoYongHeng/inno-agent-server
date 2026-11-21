import { basename } from "node:path";
import { wikiPathJoin } from "./wiki-paths.js";
import { currentWikiDate } from "./wiki-date.js";
import { parse as parseYaml, Document as YamlDocument } from "yaml";
import { l2Store, type L2Target } from "./l2-backend.js";
import type {
	WikiPageFrontmatter,
	WikiPageType,
	WikiPageStatus,
	ConfidenceLevel,
	ManifestEntry,
	WikiPrerequisite,
} from "./types.js";
import { logger } from "../../logger.js";
import { listWikiPagePaths } from "./wiki-page-files.js";

// ============================================================================
// Frontmatter serialization — backed by the `yaml` library
// ============================================================================

/**
 * Serialize wiki frontmatter to a `---`-delimited YAML block. Keys are emitted
 * in the historical on-disk order and `tags` is kept as an inline flow sequence
 * so pages touched by an update produce minimal diffs.
 */
export function serializeFrontmatter(fm: WikiPageFrontmatter): string {
	const obj: Record<string, unknown> = {
		title: fm.title,
		created: fm.created || fm.updated,
		type: fm.type,
		tags: fm.tags,
		related: fm.related ?? [],
		sources: fm.sources,
		source_ids: fm.source_ids,
		updated: fm.updated,
		status: fm.status,
		confidence: fm.confidence,
	};
	if (fm.contested !== undefined) obj.contested = fm.contested;
	if (fm.contradictions && fm.contradictions.length > 0) obj.contradictions = fm.contradictions;
	if (fm.concept_id) obj.concept_id = fm.concept_id;
	if (fm.prerequisites && fm.prerequisites.length > 0) obj.prerequisites = fm.prerequisites;

	const doc = new YamlDocument(obj);
	const tagsNode = doc.get("tags", true) as { flow?: boolean } | undefined;
	if (tagsNode && typeof tagsNode === "object") tagsNode.flow = true;
	const relatedNode = doc.get("related", true) as { flow?: boolean } | undefined;
	if (relatedNode && typeof relatedNode === "object") relatedNode.flow = true;

	// The yaml lib pads flow collections (`[ a, b ]`); strip the inner padding
	// to match the legacy `[a, b]` format and minimize diffs.
	const yamlBody = doc.toString({ lineWidth: 0 })
		.replace(/^tags: \[ (.*) \]$/m, "tags: [$1]")
		.replace(/^related: \[ (.*) \]$/m, "related: [$1]");
	return `---\n${yamlBody}---`;
}

export function parseFrontmatter(content: string): { frontmatter: WikiPageFrontmatter | null; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { frontmatter: null, body: content };

	const body = match[2];
	let raw: Record<string, unknown>;
	try {
		const parsed = parseYaml(match[1]) as unknown;
		raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch (err) {
		logger.warn({ err }, "failed to parse wiki frontmatter YAML");
		raw = {};
	}

	const asString = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
	const asStringArray = (v: unknown): string[] =>
		Array.isArray(v) ? v.map((x) => asString(x)).filter(Boolean) : [];
	const contestedRaw = raw.contested;
	const contested =
		contestedRaw === true || contestedRaw === "true"
			? true
			: contestedRaw === false || contestedRaw === "false"
				? false
				: undefined;
	const prerequisites: WikiPrerequisite[] = Array.isArray(raw.prerequisites)
		? raw.prerequisites.flatMap((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return [];
			const item = value as Record<string, unknown>;
			const conceptId = asString(item.concept_id).trim();
			if (!conceptId) return [];
			const relation = item.relation === "supporting" ? "supporting" as const : "required" as const;
			const source: WikiPrerequisite["source"] = item.source === "curated"
				|| item.source === "teacher"
				|| item.source === "model_inferred"
				? item.source
				: "imported" as const;
			const numberOrUndefined = (candidate: unknown): number | undefined =>
				typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
			return [{
				concept_id: conceptId,
				relation,
				required_level: numberOrUndefined(item.required_level),
				importance: numberOrUndefined(item.importance),
				source,
				source_confidence: numberOrUndefined(item.source_confidence),
				rationale: asString(item.rationale) || undefined,
				scope: asString(item.scope) || undefined,
			}];
		})
		: [];
	const frontmatter: WikiPageFrontmatter = {
		title: asString(raw.title),
		created: asString(raw.created) || asString(raw.updated),
		type: (raw.type as WikiPageType) ?? "source-summary",
		tags: asStringArray(raw.tags),
		sources: asStringArray(raw.sources),
		source_ids: asStringArray(raw.source_ids),
		updated: asString(raw.updated),
		status: (raw.status as WikiPageStatus) ?? "draft",
		confidence: (raw.confidence as ConfidenceLevel) ?? "medium",
		contested,
		contradictions: asStringArray(raw.contradictions),
	};
	const related = asStringArray(raw.related);
	frontmatter.related = related;
	const conceptId = asString(raw.concept_id).trim();
	if (conceptId) frontmatter.concept_id = conceptId;
	if (prerequisites.length > 0) frontmatter.prerequisites = prerequisites;

	return {
		frontmatter,
		body,
	};
}

function defaultSchemaContent(): string {
	return `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| entity | wiki/entities/ | Named things (people, tools, organizations, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena, frameworks |
| source | wiki/sources/ | Papers, articles, talks, books, blog posts |
| query | wiki/queries/ | Open questions under active investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |
| overview | wiki/ | High-level project summary (one per project) |

## Naming Conventions

- Files: \`kebab-case.md\`
- Entities: match official name where possible (e.g., \`openai.md\`, \`gpt-4.md\`)
- Concepts: descriptive noun phrases (e.g., \`chain-of-thought.md\`)
- Sources: \`author-year-slug.md\` (e.g., \`wei-2022-cot.md\`)
- Queries: question as slug (e.g., \`does-scale-improve-reasoning.md\`)

## Frontmatter

Source pages also include:
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\`

All pages must include YAML frontmatter:

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

Concept pages may additionally declare a stable concept id and directional teaching dependencies:

\`\`\`yaml
concept_id: physics.inclined_plane_acceleration
prerequisites:
  - concept_id: physics.force_decomposition
    relation: required
    required_level: 0.65
    importance: 0.9
    source: teacher
    source_confidence: 0.9
    rationale: The learner must resolve forces along the incline.
    scope: high-school-physics-standard-problem
\`\`\`

An ordinary \`[[wikilink]]\` means only that two pages are related. It must not be treated as a prerequisite unless the directional relationship is declared above.

## Index Format

\`wiki/index.md\` lists all pages grouped by type. Each entry:
\`\`\`
- [[page-slug]] — one-line description
\`\`\`

## Log Format

\`wiki/log.md\` records activity in reverse chronological order:
\`\`\`
## YYYY-MM-DD

- Action taken / finding noted
\`\`\`

## Cross-referencing Rules

- Use \`[[page-slug]]\` syntax to link between wiki pages
- Every entity and concept should appear in \`wiki/index.md\`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via \`related:\`

## Contradiction Handling

When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists
`;
}

function defaultPurposeContent(): string {
	return `# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this project -->

1.
2.
3.

## Scope

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as the project progresses) -->

> TBD
`;
}

function initialIndexContent(): string {
	// Project setup creates no index. Ingestion materializes this
	// seed when the first successful ingest adds Recently Updated entries.
	return "# Wiki Index\n";
}

function initialLogContent(): string {
	const today = currentWikiDate();
	return [
		"# L2 Wiki Log",
		"",
		"> Chronological record of L2 wiki maintenance actions. Append-only.",
		"> Format: `## [YYYY-MM-DD] action | subject`.",
		"",
		`## [${today}] create | L2 Wiki initialized`,
		"- System default initialization completed automatically.",
		"",
	].join("\n");
}

export async function ensureSchema(target: L2Target): Promise<void> {
	const store = l2Store(target);
	if (!(await store.exists("wiki/SCHEMA.md"))) {
		await store.writeText("wiki/SCHEMA.md", defaultSchemaContent());
	}
}

async function ensurePurpose(target: L2Target): Promise<void> {
	const store = l2Store(target);
	if (!(await store.exists("wiki/PURPOSE.md"))) await store.writeText("wiki/PURPOSE.md", defaultPurposeContent());
}

export async function ensureNavigationFiles(target: L2Target): Promise<void> {
	const store = l2Store(target);
	await ensureSchema(store);
	await ensurePurpose(store);
	if (!(await store.exists("wiki/index.md"))) await store.writeText("wiki/index.md", initialIndexContent());
	// Do not seed model-visible log content before the first ingest.
	// Keep the storage file present, but let rich generation write the first entry.
	if (!(await store.exists("wiki/log.md"))) await store.writeText("wiki/log.md", "");
}

export async function readMaintenanceContext(target: L2Target): Promise<{ schema: string; purpose: string; index: string; overview: string; recentLog: string }> {
	const store = l2Store(target);
	await ensureNavigationFiles(store);
	const schema = await store.readText("wiki/SCHEMA.md");
	const purpose = await store.readText("wiki/PURPOSE.md");
	const storedIndex = await store.readText("wiki/index.md");
	// Keep an index file for Inno's storage/UI APIs, while giving the first
	// ingest the same empty index context used before the first index write.
	const index = storedIndex === initialIndexContent() ? "" : storedIndex;
	const overview = (await store.exists("wiki/analysis/overview.md"))
		? await store.readText("wiki/analysis/overview.md")
		: "";
	const log = await store.readText("wiki/log.md");
	const recentLog = log.split("\n").slice(-80).join("\n");
	return { schema, purpose, index, overview, recentLog };
}

// ============================================================================
// Source summary page
// ============================================================================

function sourcePageFilename(title: string, id: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return `${slug}-${id.slice(-6)}.md`;
}

function stableSourceSlugHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** Derive a stable source-page slug from the source identity. */
export function sourceSummarySlugFromIdentity(sourceIdentity: string): string {
	const parts = sourceIdentity.replace(/\.[^/.]+$/, "").split("/").map((part) => part.trim()).filter(Boolean);
	if (parts.length <= 1) return parts[0] || "source";
	const slug = parts.map((part) => {
		const structural = part.normalize("NFKC").trim().replace(/\s+/g, "-")
			.replace(/[^\p{L}\p{N}-]/gu, "").replace(/^-|-$/g, "").toLowerCase();
		const readable = structural.replace(/-+/g, "-") || "source";
		return `${Math.max(1, Array.from(structural || "source").length)}-${readable}`;
	}).join("--");
	const hash = stableSourceSlugHash(sourceIdentity);
	const full = `${slug}--${hash}`;
	if (full.length <= 120) return full;
	const prefix = slug.slice(0, 120 - hash.length - 2).replace(/-+$/, "");
	return `${prefix || "source"}--${hash}`;
}

export function getSourcePagePath(entry: Pick<ManifestEntry, "title" | "id">, sourceIdentity?: string): string {
	const filename = sourceIdentity
		? `${sourceSummarySlugFromIdentity(sourceIdentity)}.md`
		: sourcePageFilename(entry.title, entry.id);
	return wikiPathJoin("wiki", "sources", filename);
}

/**
 * Create a wiki source summary page.
 * @param summaryBody - LLM-generated summary markdown (or full content as fallback)
 * @param extractedPath - relative path to the full extracted file, for reference
 * Returns the relative path from l2DataDir.
 */
export async function createSourcePage(
	target: L2Target,
	entry: ManifestEntry,
	summaryBody: string,
	extractedPath?: string,
	sourceIdentity?: string,
): Promise<string> {
	const filename = basename(getSourcePagePath(entry, sourceIdentity));
	const fm: WikiPageFrontmatter = {
		title: entry.title,
		created: new Date().toISOString().slice(0, 10),
		type: "source-summary",
		tags: mergeUniqueTags(["source-summary"], entry.tags),
		sources: [sourceIdentity ?? entry.source.identity ?? entry.rawPath],
		source_ids: [entry.id],
		updated: new Date().toISOString().slice(0, 10),
		status: "draft",
		confidence: "medium",
	};
	const ref = extractedPath ? `\n## 来源\n\n完整提取文本: \`${extractedPath}\`\n` : "";
	const body = `\n# ${entry.title}\n\n${summaryBody}\n${ref}`;
	const wikiPath = wikiPathJoin("wiki", "sources", filename);
	await l2Store(target).writeText(wikiPath, serializeFrontmatter(fm) + body);
	return wikiPath;
}

// ============================================================================
// Index maintenance
// ============================================================================

async function readWikiPageIndexItem(
	store: ReturnType<typeof l2Store>,
	fallbackTitle: string,
	wikiPath: string,
): Promise<{ type: WikiPageType; title: string; path: string }> {
	const content = await store.readText(wikiPath);
	const { frontmatter } = parseFrontmatter(content);
	if (frontmatter) {
		return { type: frontmatter.type, title: frontmatter.title || fallbackTitle, path: wikiPath };
	}
	if (wikiPath.includes("wiki/entities/")) return { type: "entity", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/concepts/")) return { type: "concept", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/queries/")) return { type: "query", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/comparisons/")) return { type: "comparison", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/synthesis/")) return { type: "synthesis", title: fallbackTitle, path: wikiPath };
	if (wikiPath.includes("wiki/analysis/")) return { type: "analysis", title: fallbackTitle, path: wikiPath };
	return { type: "source-summary", title: fallbackTitle, path: wikiPath };
}

/**
 * Rebuild wiki/index.md from all manifest entries, grouped by page frontmatter type.
 */
export async function rebuildIndex(target: L2Target, entries: ManifestEntry[]): Promise<void> {
	const store = l2Store(target);
	await ensureSchema(store);
	const allPages = await listWikiPagesForIndex(store, entries);
	const byPath = new Map(allPages.map((item) => [item.path, item]));
	const orderedPaths: string[] = [];
	const seen = new Set<string>();
	for (const entry of [...entries].reverse()) {
		for (const wikiPath of entry.wikiPages) {
			if (seen.has(wikiPath) || !byPath.has(wikiPath)) continue;
			seen.add(wikiPath);
			orderedPaths.push(wikiPath);
		}
	}
	for (const item of allPages) {
		if (seen.has(item.path)) continue;
		seen.add(item.path);
		orderedPaths.push(item.path);
	}
	const lines = [
		"# Wiki Index", "", "## Entities", "", "## Concepts", "", "## Sources", "",
		"## Queries", "", "## Comparisons", "", "## Synthesis", "", "## Recently Updated",
	];
	for (const wikiPath of orderedPaths.slice(0, 200)) {
		const item = byPath.get(wikiPath)!;
		const target = wikiPath.replace(/^wiki\//, "").replace(/\.md$/i, "");
		lines.push(`- [[${target}]] — ${item.title}`);
	}
	lines.push("");
	await store.writeText("wiki/index.md", lines.join("\n"));
}

function normalizeIndexTarget(target: string): string {
	return target.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^wiki\//i, "").replace(/\.md$/i, "").toLowerCase();
}

export function updateBoundedRecentIndexSection(index: string, additions: string[]): string {
	const section = "## Recently Updated";
	const lines = index.trimEnd().split("\n");
	const start = lines.findIndex((line) => line.trim() === section);
	const prefix = start >= 0 ? lines.slice(0, start) : lines;
	const sectionEnd = start >= 0
		? lines.findIndex((line, position) => position > start && /^##\s+/.test(line))
		: -1;
	const existing = start >= 0
		? lines.slice(start + 1, sectionEnd >= 0 ? sectionEnd : undefined).filter((line) => /^-\s+/.test(line))
		: [];
	const suffix = sectionEnd >= 0 ? lines.slice(sectionEnd) : [];
	const recent = Array.from(new Set([...additions, ...existing])).slice(0, 200);
	return [...prefix, "", section, ...recent, ...(suffix.length ? ["", ...suffix] : []), ""].join("\n");
}

/** Update the deterministic wiki index after an ingest. */
export async function updateIndexAfterIngest(target: L2Target, writtenPaths: string[]): Promise<boolean> {
	const candidates = Array.from(new Set(writtenPaths.map((path) => path.replaceAll("\\", "/"))))
		.filter((path) => path.startsWith("wiki/") && path.endsWith(".md")
			&& !["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(path));
	if (candidates.length === 0) return false;

	const store = l2Store(target);
	const index = (await store.exists("wiki/index.md")) ? await store.readText("wiki/index.md") : "# Wiki Index\n";
	const knownTargets = new Set(
		Array.from(index.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
			.map((match) => normalizeIndexTarget(match[1])),
	);
	const additions: string[] = [];
	for (const path of candidates) {
		const target = path.replace(/^wiki\//, "").replace(/\.md$/i, "");
		if (knownTargets.has(normalizeIndexTarget(target))) continue;
		const content = await store.readText(path);
		const parsed = parseFrontmatter(content);
		const title = parsed.frontmatter?.title?.trim() || basename(path).replace(/\.md$/i, "");
		additions.push(`- [[${target}]] — ${title}`);
	}
	if (additions.length === 0) return false;

	await store.writeText("wiki/index.md", updateBoundedRecentIndexSection(index, additions));
	return true;
}

// ============================================================================
// Log maintenance
// ============================================================================

/**
 * Append an entry to wiki/log.md.
 */
export async function appendLog(target: L2Target, action: string, title: string, details?: string): Promise<void> {
	const store = l2Store(target);
	if (!(await store.readText("wiki/log.md")).trim()) {
		await store.writeText("wiki/log.md", initialLogContent());
	}
	const today = currentWikiDate();
	let entry = `\n## [${today}] ${action} | ${title}\n`;
	if (details) entry += `${details.trim()}\n`;
	await store.appendText("wiki/log.md", entry);
}

/** Append the structural ingest entry used when rich generation omits wiki/log.md. */
export async function appendDeterministicIngestLog(target: L2Target, sourceIdentity: string): Promise<void> {
	const store = l2Store(target);
	const existing = await store.readText("wiki/log.md");
	const entry = `## [${currentWikiDate()}] ingest | ${sourceIdentity}`;
	const next = existing.trim()
		? `${existing.trimEnd()}\n\n${entry}\n`
		: `# Wiki Log\n\n${entry}\n`;
	await store.writeText("wiki/log.md", next);
}

// ============================================================================
// Directory initialization
// ============================================================================

/**
 * Ensure the L2 layout exists: directories for file storage (no-op for PG)
 * and the seed navigation files.
 */
export async function ensureL2Directories(target: L2Target): Promise<void> {
	const store = l2Store(target);
	await store.ensureDirs();
	await ensureNavigationFiles(store);
}

function mergeUniqueTags(...tagGroups: string[][]): string[] {
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const group of tagGroups) {
		for (const tag of group) {
			const trimmed = tag.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			tags.push(trimmed);
		}
	}
	return tags;
}

async function listWikiPagesForIndex(
	store: ReturnType<typeof l2Store>,
	entries: ManifestEntry[],
): Promise<{ type: WikiPageType; title: string; path: string }[]> {
	const items: { type: WikiPageType; title: string; path: string }[] = [];
	const fallbackTitleByPath = new Map<string, string>();
	for (const entry of entries) {
		for (const wikiPath of entry.wikiPages) {
			fallbackTitleByPath.set(wikiPath, entry.title);
		}
	}
	for (const wikiPath of await listWikiPagePaths(store)) {
		const file = basename(wikiPath);
		items.push(await readWikiPageIndexItem(store, fallbackTitleByPath.get(wikiPath) ?? file.replace(/\.md$/, ""), wikiPath));
	}
	return items;
}
