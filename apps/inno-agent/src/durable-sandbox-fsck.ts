#!/usr/bin/env node
/**
 * Find (and with --repair destroy) sandboxes that no session references.
 *   node dist/durable-sandbox-fsck.js [--data-dir <dir>] [--grace-minutes 60] [--repair]
 * Needs the sandbox credentials the server uses (config.json `sandbox` or
 * E2B_API_KEY). Session records come from PostgreSQL when DATABASE_URL is set,
 * otherwise from the local and tenant `sessions.json` files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { listDurableRoots } from "./agent/durable-audit.js";
import { loadConfig, normalizeSandboxConfig } from "./config.js";
import { resolveRuntimePaths } from "./runtime.js";
import { E2BSandboxProvider } from "./sandbox/e2b-backend.js";
import { findOrphanSandboxes, removeOrphanSandboxes } from "./sandbox/sandbox-audit.js";

const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const paths = resolveRuntimePaths();
const dataDir = value("--data-dir") ?? paths.dataDir;
const graceMinutes = Number(value("--grace-minutes") ?? 60);

let sandboxSettings;
try { sandboxSettings = loadConfig(paths.configPath).sandbox; } catch { sandboxSettings = undefined; }
const sandbox = normalizeSandboxConfig(sandboxSettings);
if (!sandbox.apiKey) {
	console.error("No sandbox API key: set sandbox.apiKey in config.json or E2B_API_KEY");
	process.exit(2);
}

const referenced = new Set<string>();
const databaseUrl = process.env.DATABASE_URL?.trim();
if (databaseUrl) {
	const pool = new Pool({ connectionString: databaseUrl });
	for (const row of (await pool.query<{ sandbox_id: string }>("SELECT sandbox_id FROM durable_sessions WHERE sandbox_id IS NOT NULL")).rows) {
		referenced.add(row.sandbox_id);
	}
	await pool.end();
} else {
	for (const { root } of listDurableRoots(dataDir)) {
		const catalog = join(root, "sessions.json");
		if (!existsSync(catalog)) continue;
		for (const record of JSON.parse(readFileSync(catalog, "utf-8")) as Array<{ sandboxId?: string }>) {
			if (record.sandboxId) referenced.add(record.sandboxId);
		}
	}
}

const provider = new E2BSandboxProvider({ apiKey: sandbox.apiKey, ...(sandbox.domain ? { domain: sandbox.domain } : {}) });
const orphans = await findOrphanSandboxes(provider, referenced, { graceMs: graceMinutes * 60_000 });
const repair = args.includes("--repair");
const result = repair ? await removeOrphanSandboxes(provider, orphans) : undefined;
console.log(JSON.stringify({ referenced: referenced.size, orphans, repaired: repair, ...(result ?? {}) }, null, 2));
process.exit(orphans.length && !repair ? 1 : result?.failed.length ? 1 : 0);
