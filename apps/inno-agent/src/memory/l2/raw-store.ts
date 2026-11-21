import { extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { l2Store, type L2Target } from "./l2-backend.js";
import type { RawSourceType } from "./types.js";

/** Map source type to subdirectory under raw/. */
const TYPE_DIR_MAP: Record<RawSourceType, string> = {
	text: "uploads",
	markdown: "uploads",
	conversation: "conversations",
	pdf: "uploads",
	word: "uploads",
	image: "uploads",
};

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

function generateFilename(title: string, sourceType: RawSourceType): string {
	const date = new Date().toISOString().slice(0, 10);
	const ext = sourceType === "markdown" ? "md" : "txt";
	return `${date}-${slugify(title)}-${randomUUID().slice(0, 6)}.${ext}`;
}

function rawFrontmatter(content: string, sourceType: RawSourceType, sourceUrl?: string): string {
	const today = new Date().toISOString().slice(0, 10);
	const sha256 = createHash("sha256").update(content).digest("hex");
	return [
		"---",
		...(sourceUrl ? [`source_url: ${JSON.stringify(sourceUrl)}`] : []),
		`source_type: ${sourceType}`,
		`ingested: ${today}`,
		`sha256: ${sha256}`,
		"---",
		"",
	].join("\n");
}

/**
 * Save raw text content to raw/<subdir>/<filename>.
 * Returns the relative path from the L2 root.
 */
export async function saveRaw(
	target: L2Target,
	title: string,
	content: string,
	sourceType: RawSourceType,
	sourceUrl?: string,
): Promise<string> {
	const filename = generateFilename(title, sourceType);
	const rel = `raw/${TYPE_DIR_MAP[sourceType]}/${filename}`;
	await l2Store(target).writeText(rel, rawFrontmatter(content, sourceType, sourceUrl) + content);
	return rel;
}

/**
 * Save an original binary file (PDF/Word/Image) into raw storage.
 * Local mode copies the file; tenant storage puts it in the object store.
 * Returns the relative path from the L2 root.
 */
export async function saveRawFile(
	target: L2Target,
	title: string,
	originalFilePath: string,
	sourceType: RawSourceType,
): Promise<string> {
	const date = new Date().toISOString().slice(0, 10);
	const ext = extname(originalFilePath);
	const filename = `${date}-${slugify(title)}-${randomUUID().slice(0, 6)}${ext}`;
	const rel = `raw/${TYPE_DIR_MAP[sourceType]}/${filename}`;
	await l2Store(target).putBinary(rel, readFileSync(originalFilePath));
	return rel;
}
