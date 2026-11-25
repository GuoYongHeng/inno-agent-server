import { platformObjectKey, platformObjectPrefix, tenantObjectKey, tenantObjectPrefix } from "../object-store/object-store.js";

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

/** Tenant-owned variants: bodies live under the tenant's object prefix, not platform/. */
export function tenantSkillFileObjectKey(tenantId: string, skillId: string, version: string, relPath: string): string {
	return tenantObjectKey(tenantId, "skills", skillId, version, b64(relPath));
}

export function tenantSkillVersionObjectPrefix(tenantId: string, skillId: string, version: string): string {
	return tenantObjectPrefix(tenantId, "skills", skillId, version);
}

/**
 * Record-driven keys. A row's `object_prefix` already encodes whether the
 * bodies are platform-shared or tenant-owned, so readers never need to know
 * which scope published the version.
 */
export function skillManifestKey(record: { objectPrefix: string }): string {
	return `${record.objectPrefix}_manifest.json`;
}

export function skillFileKey(record: { objectPrefix: string }, relPath: string): string {
	return `${record.objectPrefix}${b64(relPath)}`;
}

/** Parent prefix covering every version of a skill (for deletion). */
export function skillObjectsPrefix(record: { objectPrefix: string }): string {
	return record.objectPrefix.replace(/[^/]+\/$/, "");
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
