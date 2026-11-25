import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ObjectStore } from "../object-store/object-store.js";
import { sha256Hex } from "../object-store/object-store.js";
import type { SkillCatalogStore } from "./catalog-store.js";
import {
	skillFileObjectKey,
	skillManifestObjectKey,
	skillVersionObjectPrefix,
	type SkillManifest,
} from "./skill-object-key.js";

const IGNORE_DIR_NAMES = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache"]);

function parseFrontmatter(content: string): Record<string, unknown> {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return {};
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return {};
	const parsed = parseYaml(normalized.slice(4, end));
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function walkFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (IGNORE_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	walk(root);
	return out.sort((a, b) => a.localeCompare(b));
}

function toPosixRel(root: string, full: string): string {
	return relative(root, full).split(sep).join("/");
}

export interface PublishSkillOptions {
	objects: ObjectStore;
	catalog: SkillCatalogStore;
	/** Absolute path to a skill directory containing SKILL.md. */
	skillDir: string;
	source?: string;
	publishedBy?: string;
}

export interface PublishSkillResult {
	skillId: string;
	version: string;
	objectPrefix: string;
	fileCount: number;
	unchanged: boolean;
}

/**
 * Validate a local skill directory, upload its files under
 * `platform/skills/<id>/<version>/`, and upsert `skill_catalog`.
 * Identical bytes produce the same version and skip re-upload when already present.
 */
export async function publishSkillFromDir(options: PublishSkillOptions): Promise<PublishSkillResult> {
	const skillDir = options.skillDir;
	const skillMdPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillMdPath) || !statSync(skillMdPath).isFile()) {
		throw new Error(`Skill directory must contain SKILL.md: ${skillDir}`);
	}
	const skillMd = readFileSync(skillMdPath, "utf-8");
	const frontmatter = parseFrontmatter(skillMd);
	const dirName = basename(skillDir);
	const skillId = typeof frontmatter.name === "string" && frontmatter.name.trim()
		? frontmatter.name.trim()
		: dirName;
	if (!/^[a-z0-9-]+$/.test(skillId)) {
		throw new Error(`Invalid skill id ${JSON.stringify(skillId)} (lowercase a-z, 0-9, hyphens only)`);
	}
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!description) throw new Error(`Skill ${skillId} is missing a description in SKILL.md`);
	const disableModelInvocation = frontmatter["disable-model-invocation"] === true;

	const files = walkFiles(skillDir);
	if (files.length === 0) throw new Error(`Skill directory is empty: ${skillDir}`);

	const entries: Array<{ relPath: string; body: Uint8Array; sha256: string }> = [];
	const versionHash = createHash("sha256");
	for (const full of files) {
		const relPath = toPosixRel(skillDir, full);
		const body = new Uint8Array(readFileSync(full));
		const digest = sha256Hex(body);
		entries.push({ relPath, body, sha256: digest });
		versionHash.update(relPath);
		versionHash.update("\0");
		versionHash.update(digest);
		versionHash.update("\n");
	}
	const version = versionHash.digest("hex").slice(0, 16);
	const objectPrefix = skillVersionObjectPrefix(skillId, version);
	const existing = await options.catalog.get(skillId);
	if (existing?.version === version && existing.objectPrefix === objectPrefix) {
		const manifestKey = skillManifestObjectKey(skillId, version);
		if (await options.objects.head(manifestKey)) {
			return {
				skillId,
				version,
				objectPrefix,
				fileCount: entries.length,
				unchanged: true,
			};
		}
	}

	const manifest: SkillManifest = {
		skillId,
		version,
		files: entries.map((entry) => ({
			relPath: entry.relPath,
			sha256: entry.sha256,
			size: entry.body.byteLength,
		})),
	};

	for (const entry of entries) {
		const key = skillFileObjectKey(skillId, version, entry.relPath);
		await options.objects.put(key, entry.body);
	}
	await options.objects.put(
		skillManifestObjectKey(skillId, version),
		new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
		{ contentType: "application/json" },
	);

	await options.catalog.upsertCatalog({
		skillId,
		name: skillId,
		description,
		version,
		objectPrefix,
		disableModelInvocation,
		publishedBy: options.publishedBy ?? null,
		source: options.source ?? "publish",
	});

	return {
		skillId,
		version,
		objectPrefix,
		fileCount: entries.length,
		unchanged: false,
	};
}

/** Publish every immediate child directory of `skillsRoot` that contains SKILL.md. */
export async function publishSkillsFromRoot(options: {
	objects: ObjectStore;
	catalog: SkillCatalogStore;
	skillsRoot: string;
	source?: string;
	publishedBy?: string;
}): Promise<PublishSkillResult[]> {
	if (!existsSync(options.skillsRoot)) return [];
	const results: PublishSkillResult[] = [];
	for (const entry of readdirSync(options.skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const skillDir = join(options.skillsRoot, entry.name);
		if (!existsSync(join(skillDir, "SKILL.md"))) continue;
		results.push(await publishSkillFromDir({
			objects: options.objects,
			catalog: options.catalog,
			skillDir,
			source: options.source,
			publishedBy: options.publishedBy,
		}));
	}
	return results;
}
