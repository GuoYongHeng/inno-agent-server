#!/usr/bin/env node
/**
 * Offline consistency check for durable session data.
 *   node dist/durable-fsck.js --data-dir <dir> [--repair]
 * Set DATABASE_URL to audit tenant roots against the PostgreSQL catalog.
 * Lists orphaned session directories (data whose catalog record is gone) and
 * per-root disk usage as JSON. `--repair` removes the orphans. Safe to run
 * while the server is up: create writes the catalog before any data and delete
 * removes the catalog record first, so a live session is never an orphan.
 */
import { auditDurableData } from "./agent/durable-audit.js";
import { Pool } from "pg";
import { resolveRuntimePaths } from "./runtime.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = value("--data-dir") ?? resolveRuntimePaths().dataDir;
// Tenant catalogs live in PostgreSQL when DATABASE_URL is set (authenticated mode).
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const results = await auditDurableData(dataDir, {
	repair: flag("--repair"),
	...(pool ? {
		knownIds: async (tenantId: string) => new Set((await pool.query<{ id: string }>(
			"SELECT id FROM durable_sessions WHERE tenant_id = $1", [tenantId])).rows.map((row) => row.id)),
	} : {}),
});
await pool?.end();
console.log(JSON.stringify({ dataDir, repaired: flag("--repair"), roots: results }, null, 2));
process.exit(results.some((r) => r.error || (r.orphans.length && !r.removed)) ? 1 : 0);
