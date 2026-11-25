import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { normalizeConfig, type InnoConfig } from "./config.js";

/**
 * Platform configuration split.
 *
 * `config.json` is now immutable deployment input only: listen settings,
 * sandbox, object storage, logging and the baked-in presets directory.
 * Everything an operator used to edit between restarts — the provider
 * catalog, channel credentials, search keys, feature toggles, per-platform
 * defaults for tenant-overridable sections, and the legacy skill-disable
 * list — lives in the `platform_config` row so every worker shares one
 * copy and replicas cannot drift.
 *
 * Boot semantics: mutable keys explicitly present in config.json are
 * upserted into the stored document (the file acts like a ConfigMap —
 * declarative desired state applied on every start). Keys absent from the
 * file keep their stored value, so a trimmed-down config.json cannot
 * accidentally wipe the database copy. The merged document is then
 * normalized exactly like the old file-only config.
 */

/** config.json keys that remain file-backed deployment infrastructure. */
export const PLATFORM_IMMUTABLE_KEYS = [
	"server",
	"sandbox",
	"objectStorage",
	"logging",
	"presets",
] as const;

/** InnoConfig keys stored in the platform_config document. */
export const PLATFORM_MUTABLE_KEYS = [
	"defaultProvider",
	"defaultModel",
	"providers",
	"feishu",
	"channels",
	"bridge",
	"github",
	"contentHub",
	"memory",
	"smartInput",
	"ui",
	"scheduler",
	"tavily",
	// Legacy `openai` shorthand is still honoured as seed input.
	"openai",
] as const;

/**
 * Sidecar carried inside the platform_config document but not part of
 * InnoConfig: the legacy global skill-disable list previously kept in
 * `<configDir>/skills.json`.
 */
export interface SkillRegistryDoc {
	disabled: string[];
}

/** The JSON document stored in platform_config.config (TEXT). */
export type PlatformConfigDoc = Record<string, unknown> & {
	skillRegistry?: SkillRegistryDoc;
};

/**
 * Read the raw config.json without normalizing. A missing file yields `{}`
 * (immutable-only deployments may not need the file at all); a parse error
 * still aborts startup, matching loadConfig's semantics.
 */
export function readRawConfigFile(configPath: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			`Failed to load Inno config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config root must be a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (err) {
		throw new Error(
			`Failed to load Inno config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Deployment-infrastructure keys taken from config.json. */
export function pickImmutableConfig(raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of PLATFORM_IMMUTABLE_KEYS) {
		if (raw[key] !== undefined) out[key] = raw[key];
	}
	return out;
}

/**
 * Mutable keys explicitly present in config.json — the per-boot seed. Only
 * keys actually written in the file count, so normalized defaults cannot
 * masquerade as operator intent.
 */
export function pickMutableConfig(raw: Record<string, unknown>): PlatformConfigDoc {
	const out: PlatformConfigDoc = {};
	for (const key of PLATFORM_MUTABLE_KEYS) {
		if (raw[key] !== undefined) out[key] = raw[key];
	}
	return out;
}

/** Mutable keys that appear in the file but are shadowed by nothing — pure diagnostics. */
export function mutableKeysPresent(raw: Record<string, unknown>): string[] {
	return PLATFORM_MUTABLE_KEYS.filter((key) => raw[key] !== undefined);
}

export async function loadPlatformConfigDoc(pool: Pool): Promise<PlatformConfigDoc | null> {
	const result = await pool.query<{ config: string }>(
		"SELECT config FROM platform_config WHERE id = 1",
	);
	const row = result.rows[0];
	if (!row) return null;
	return JSON.parse(row.config) as PlatformConfigDoc;
}

export async function savePlatformConfigDoc(pool: Pool, doc: PlatformConfigDoc): Promise<void> {
	await pool.query(
		`INSERT INTO platform_config (id, config) VALUES (1, $1)
		 ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
		[JSON.stringify(doc)],
	);
}

function stripSidecar(doc: PlatformConfigDoc): Record<string, unknown> {
	const { skillRegistry: _skillRegistry, ...config } = doc;
	return config;
}

/**
 * Resolve the effective platform config at bootstrap: seed the DB document
 * with mutable keys explicitly present in config.json, persist the merged
 * document when it changed, and return the normalized InnoConfig built from
 * file-backed immutable fields plus the stored mutable document.
 */
export async function resolvePlatformConfig(
	pool: Pool,
	fileRaw: Record<string, unknown>,
): Promise<{ config: InnoConfig; doc: PlatformConfigDoc; seeded: boolean }> {
	const stored = (await loadPlatformConfigDoc(pool)) ?? {};
	const fileMutable = pickMutableConfig(fileRaw);
	const doc: PlatformConfigDoc = { ...stored, ...fileMutable };
	const seeded = JSON.stringify(doc) !== JSON.stringify(stored);
	if (seeded) await savePlatformConfigDoc(pool, doc);
	const config = normalizeConfig({
		...pickImmutableConfig(fileRaw),
		...stripSidecar(doc),
	} as Parameters<typeof normalizeConfig>[0]);
	return { config, doc, seeded };
}

/** Global skill-disable list stored inside the platform config document. */
export function platformSkillDisabled(doc: PlatformConfigDoc | null | undefined): Set<string> {
	const disabled = doc?.skillRegistry?.disabled;
	return new Set(
		Array.isArray(disabled) ? disabled.filter((item): item is string => typeof item === "string") : [],
	);
}

/** Return a new document with `name` added to / removed from the disabled list. */
export function withSkillDisabled(
	doc: PlatformConfigDoc,
	name: string,
	enabled: boolean,
): PlatformConfigDoc {
	const disabled = platformSkillDisabled(doc);
	if (enabled) disabled.delete(name);
	else disabled.add(name);
	return {
		...doc,
		skillRegistry: { disabled: [...disabled].sort() },
	};
}
