import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { normalizeConfig, type InnoConfig } from "./config.js";

/**
 * Platform configuration split.
 *
 * `config.json` carries deployment/fixed fields only: listen settings,
 * sandbox, object storage, the baked-in presets directory, and the fixed
 * platform default provider/model.
 *
 * Server-managed config — the provider catalog, channel endpoints and
 * credentials, search keys, the content hub pointer — lives ONLY in the
 * PostgreSQL `platform_config` row (`src/platform-config-cli.ts` upserts
 * it). config.json must not declare these keys; a file that does fails
 * boot so an operator can never accidentally ship credentials the DB copy
 * then contradicts.
 *
 * Per-user knobs (memory/smartInput/ui/scheduler) have no platform file or
 * DB key at all: their defaults are hardcoded in `normalizeConfig` and the
 * tenant `tenant_configs` row overrides them per account.
 */

/** config.json keys: deployment infrastructure plus fixed platform defaults. */
export const PLATFORM_IMMUTABLE_KEYS = [
	"server",
	"sandbox",
	"objectStorage",
	"presets",
	"defaultProvider",
	"defaultModel",
] as const;

/** InnoConfig keys stored in the platform_config document. */
export const PLATFORM_MUTABLE_KEYS = [
	"providers",
	"feishu",
	"channels",
	"bridge",
	"github",
	"contentHub",
	"tavily",
	// Legacy `openai` shorthand is still honoured as seed input.
	"openai",
] as const;

/** The JSON document stored in platform_config.config (TEXT). */
export type PlatformConfigDoc = Record<string, unknown>;

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
 * Server-managed keys explicitly present in a JSON document — used by the
 * platform-config CLI to compose the row it upserts. Only keys actually
 * present count, so normalized defaults cannot masquerade as operator
 * intent.
 */
export function pickMutableConfig(raw: Record<string, unknown>): PlatformConfigDoc {
	const out: PlatformConfigDoc = {};
	for (const key of PLATFORM_MUTABLE_KEYS) {
		if (raw[key] !== undefined) out[key] = raw[key];
	}
	return out;
}

/** Server-managed keys illegally present in config.json — boot rejects these. */
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

/**
 * Resolve the effective platform config at bootstrap: file-backed
 * deployment fields plus the server-managed document from the
 * `platform_config` row. The file must not declare server-managed keys —
 * if it does, boot fails with instructions to move them into the row via
 * `npm run platform:config`. The DB row is the single source of truth for
 * the managed section; nothing is seeded from the file.
 */
export async function resolvePlatformConfig(
	pool: Pool,
	fileRaw: Record<string, unknown>,
): Promise<{ config: InnoConfig; doc: PlatformConfigDoc }> {
	const forbidden = mutableKeysPresent(fileRaw);
	if (forbidden.length > 0) {
		throw new Error(
			`config.json must not declare server-managed keys: ${forbidden.join(", ")}. ` +
				`Move them into the platform_config row with \`npm run platform:config -- <file>\`.`,
		);
	}
	const doc = (await loadPlatformConfigDoc(pool)) ?? {};
	const config = normalizeConfig({
		...fileRaw,
		...doc,
	} as Parameters<typeof normalizeConfig>[0]);
	return { config, doc };
}
