import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ObjectStore } from "../object-store/object-store.js";
import { sha256Hex } from "../object-store/object-store.js";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../agent/skills.js";
import type { SkillCatalogRecord } from "./catalog-store.js";
import {
	skillFileObjectKey,
	skillManifestObjectKey,
	type SkillManifest,
} from "./skill-object-key.js";

/** System-managed mirror of enabled platform skills inside a session workspace. */
export const GLOBAL_SKILLS_WORKSPACE_DIR = ".global-skills";

function writeBytes(path: string, body: Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

/**
 * Pull one published skill into `<workspace>/.global-skills/<skillId>/`.
 * Skips files whose local sha256 already matches the manifest.
 */
export async function materializeSkill(
	objects: ObjectStore,
	skill: SkillCatalogRecord,
	workspaceDir: string,
): Promise<string> {
	const destRoot = join(workspaceDir, GLOBAL_SKILLS_WORKSPACE_DIR, skill.skillId);
	const manifestKey = skillManifestObjectKey(skill.skillId, skill.version);
	const manifestBytes = await objects.get(manifestKey);
	if (!manifestBytes) {
		throw new Error(`Skill manifest missing for ${skill.skillId}@${skill.version}`);
	}
	const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SkillManifest;
	mkdirSync(destRoot, { recursive: true });
	writeBytes(join(destRoot, "_manifest.json"), manifestBytes);

	for (const file of manifest.files) {
		const localPath = join(destRoot, file.relPath);
		if (existsSync(localPath)) {
			try {
				const localSha = sha256Hex(new Uint8Array(readFileSync(localPath)));
				if (localSha === file.sha256) continue;
			} catch {
				// rewrite below
			}
		}
		const key = skillFileObjectKey(skill.skillId, skill.version, file.relPath);
		const body = await objects.get(key);
		if (!body) throw new Error(`Skill object missing: ${key}`);
		writeBytes(localPath, body);
	}
	return destRoot;
}

/**
 * Materialize every enabled catalog skill and return the prompt section, or
 * `undefined` when none are visible.
 */
export async function buildCatalogSkillsSection(options: {
	objects: ObjectStore;
	skills: SkillCatalogRecord[];
	workspaceDir: string;
}): Promise<string | undefined> {
	if (options.skills.length === 0) return undefined;
	const roots: string[] = [];
	for (const skill of options.skills) {
		if (skill.disableModelInvocation) continue;
		roots.push(await materializeSkill(options.objects, skill, options.workspaceDir));
	}
	if (roots.length === 0) return undefined;

	const parent = join(options.workspaceDir, GLOBAL_SKILLS_WORKSPACE_DIR);
	const { skills } = loadSkillsFromDir(parent);
	const block = formatSkillsForPrompt(skills);
	return block.trim() ? `# 可用技能\n${block}` : undefined;
}
