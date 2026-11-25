#!/usr/bin/env node
/**
 * Orphan sweep for workspace object bytes.
 *   node dist/workspace-fsck.js [--repair] [--grace-ms <ms>] [--tenant <id>]
 * Needs DATABASE_URL (the `workspace_files` manifest) and a durable object
 * store configured through INNO_OBJECT_STORAGE_* (`fs` or `s3`). Lists every
 * object under `tenants/<t>/workspaces/<ws>/` and compares it with the
 * manifest: objects without a manifest row are orphans (abandoned presigned
 * uploads, crash windows between put and manifest write, failed deletes);
 * manifest rows without their object are reported as missing. `--repair`
 * deletes orphans older than the grace window (default 1h) — younger objects
 * may belong to an in-flight upload or replica push ahead of its row.
 */
import { Pool } from "pg";
import { createObjectStore, normalizeObjectStorageConfig } from "./object-store/index.js";
import { TenantStore } from "./tenants/store.js";
import { auditAllWorkspaceObjects } from "./workspace/workspace-object-audit.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
	console.error("DATABASE_URL is required (the workspace manifest lives in PostgreSQL)");
	process.exit(2);
}
const config = normalizeObjectStorageConfig(undefined);

const graceMs = Number(value("--grace-ms") ?? 3_600_000);
const pool = new Pool({ connectionString: databaseUrl });
const audits = await auditAllWorkspaceObjects({
	objects: createObjectStore(config),
	store: new TenantStore(pool),
	graceMs,
	repair: flag("--repair"),
	...(value("--tenant") ? { tenantId: value("--tenant")! } : {}),
});
await pool.end();
const orphans = audits.reduce((n, a) => n + a.orphans.length, 0);
const missing = audits.reduce((n, a) => n + a.missing.length, 0);
const repaired = audits.reduce((n, a) => n + a.repaired.length, 0);
console.log(JSON.stringify({ repaired: flag("--repair"), graceMs, orphans, missing, repairedObjects: repaired, workspaces: audits }, null, 2));
process.exit(audits.some((a) => a.error) || missing > 0 || (orphans > 0 && !flag("--repair")) ? 1 : 0);
