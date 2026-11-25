import { platformObjectKey, platformObjectPrefix } from "../object-store/object-store.js";

function b64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

/** Object key for one file inside a published skill version. */
export function skillFileObjectKey(skillId: string, version: string, relPath: string): string {
	return platformObjectKey("skills", skillId, version, b64(relPath));
}

/** Prefix holding every object of one published skill version. */
export function skillVersionObjectPrefix(skillId: string, version: string): string {
	return platformObjectPrefix("skills", skillId, version);
}

export function skillManifestObjectKey(skillId: string, version: string): string {
	return platformObjectKey("skills", skillId, version, "_manifest.json");
}

export interface SkillManifestFile {
	relPath: string;
	sha256: string;
	size: number;
}

export interface SkillManifest {
	skillId: string;
	version: string;
	files: SkillManifestFile[];
}
