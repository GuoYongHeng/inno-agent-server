#!/usr/bin/env node
/**
 * Export the PostgreSQL session catalog back to per-tenant `sessions.json`
 * files — the rollback path for the H1 catalog migration. The pre-migration
 * `sessions.json.migrated` is only an import-time snapshot; sessions created
 * afterwards exist only in PostgreSQL, so a rollback needs this export first.
 *   node dist/durable-export-catalog.js --data-dir <dir> [--tenant <id>]
 * Requires DATABASE_URL pointing at the tenant database.
 */
import { Pool } from "pg";
import { dirname, join } from "node:path";
import { COLUMNS, toRecord, type SessionRow } from "./agent/pg-session-catalog.js";
import { resolveRuntimePaths } from "./runtime.js";
import { writeJson } from "./storage/file-store.js";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = value("--data-dir") ?? resolveRuntimePaths().dataDir;
const onlyTenant = value("--tenant");
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
	console.error("DATABASE_URL is required to export the session catalog");
	process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
try {
	const result = onlyTenant
		? await pool.query<SessionRow & { tenant_id: string }>(
			`SELECT tenant_id, ${COLUMNS} FROM durable_sessions WHERE tenant_id = $1 ORDER BY tenant_id, updated_at DESC`,
			[onlyTenant])
		: await pool.query<SessionRow & { tenant_id: string }>(
			`SELECT tenant_id, ${COLUMNS} FROM durable_sessions ORDER BY tenant_id, updated_at DESC`);
	const byTenant = new Map<string, SessionRow[]>();
	for (const row of result.rows) {
		const list = byTenant.get(row.tenant_id) ?? [];
		list.push(row);
		byTenant.set(row.tenant_id, list);
	}
	const exported: Array<{ tenantId: string; path: string; sessions: number }> = [];
	for (const [tenantId, rows] of byTenant) {
		const path = join(dataDir, "tenants", tenantId, "durable", "sessions.json");
		mkdirSync(dirname(path), { recursive: true });
		writeJson(path, rows.map(toRecord));
		exported.push({ tenantId, path, sessions: rows.length });
	}
	console.log(JSON.stringify({ dataDir, tenants: exported }, null, 2));
} finally {
	await pool.end();
}
