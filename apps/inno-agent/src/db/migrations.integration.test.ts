import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startTemporaryPostgres, type TemporaryPostgres } from "./test-postgres.js";
import { runMigrations, type Migration } from "./migrations.js";
import { migrateTenantDatabase, TENANT_MIGRATIONS } from "../tenants/schema.js";

// Unique per run: extra databases live on the same server and must not collide with an earlier run.
const raceDb = `inno_race_${randomUUID().replaceAll("-", "")}`;
const tenantDb = `inno_tenant_${randomUUID().replaceAll("-", "")}`;
let database: TemporaryPostgres;
let pool: Pool;

beforeAll(async () => {
	database = await startTemporaryPostgres();
	pool = new Pool({ connectionString: database.databaseUrl });
});

afterAll(async () => {
	for (const name of [raceDb, tenantDb]) await pool?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
	await pool?.end();
	await database?.close();
});

const steps = (...versions: number[]): Migration[] => versions.map((version) => ({
	version,
	name: `step_${version}`,
	sql: `CREATE TABLE IF NOT EXISTS mig_${version} (id int); INSERT INTO mig_${version} VALUES (${version});`,
}));

describe("runMigrations", () => {
	it("applies pending steps once and records them", async () => {
		const first = await runMigrations(pool, steps(1, 2));
		expect(first.map((m) => m.version)).toEqual([1, 2]);
		expect(await runMigrations(pool, steps(1, 2))).toEqual([]);
		const rows = await pool.query("SELECT count(*)::int AS n FROM mig_1");
		expect(rows.rows[0].n).toBe(1);
		const third = await runMigrations(pool, steps(1, 2, 3));
		expect(third.map((m) => m.version)).toEqual([3]);
	});

	it("rolls a failing step back completely and leaves it pending", async () => {
		const failing: Migration = { version: 4, name: "broken", sql: "CREATE TABLE mig_partial (id int); SELECT * FROM does_not_exist;" };
		await expect(runMigrations(pool, [...steps(1, 2, 3), failing])).rejects.toThrow(/Migration 4 \(broken\) failed/);
		expect((await pool.query("SELECT to_regclass('mig_partial') AS t")).rows[0].t).toBeNull();
		expect((await pool.query("SELECT 1 FROM schema_migrations WHERE version = 4")).rowCount).toBe(0);
	});

	it("refuses a database newer than this build", async () => {
		await expect(runMigrations(pool, steps(1, 2))).rejects.toThrow(/does not know \(3\)/);
	});

	it("serialises concurrent runs so each step is applied exactly once", async () => {
		const other = new Pool({ connectionString: database.databaseUrl });
		try {
			await other.query("CREATE SCHEMA IF NOT EXISTS race");
			const raceSteps: Migration[] = [{ version: 1, name: "race", sql: "SELECT pg_sleep(0.3); CREATE TABLE race.once (id int)" }];
			// A separate database so the shared schema_migrations above does not interfere.
			const admin = new Pool({ connectionString: database.databaseUrl });
			await admin.query(`CREATE DATABASE ${raceDb}`);
			await admin.end();
			const url = new URL(database.databaseUrl);
			url.pathname = `/${raceDb}`;
			const a = new Pool({ connectionString: url.toString() });
			const b = new Pool({ connectionString: url.toString() });
			try {
				const results = await Promise.all([runMigrations(a, [{ ...raceSteps[0]!, sql: "SELECT pg_sleep(0.3); CREATE TABLE once (id int)" }]), runMigrations(b, [{ ...raceSteps[0]!, sql: "SELECT pg_sleep(0.3); CREATE TABLE once (id int)" }])]);
				expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
			} finally {
				await a.end();
				await b.end();
			}
		} finally {
			await other.end();
		}
	});
});

describe("tenant schema on ParadeDB", () => {
	it("creates the search extensions the memory layers need and adopts an existing baseline", async () => {
		const admin = new Pool({ connectionString: database.databaseUrl });
		await admin.query(`CREATE DATABASE ${tenantDb}`);
		await admin.end();
		const url = new URL(database.databaseUrl);
		url.pathname = `/${tenantDb}`;
		const tenantPool = new Pool({ connectionString: url.toString() });
		try {
			await tenantPool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
			await migrateTenantDatabase(tenantPool);
			await migrateTenantDatabase(tenantPool);
			const extensions = await tenantPool.query("SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm','pg_search')");
			expect(extensions.rows.map((row) => row.extname).sort()).toEqual(["pg_search", "pg_trgm", "vector"]);
			const versions = await tenantPool.query("SELECT version FROM schema_migrations ORDER BY version");
			expect(versions.rows.map((row) => row.version)).toEqual(TENANT_MIGRATIONS.map((migration) => migration.version));
		} finally {
			await tenantPool.end();
		}
	});
});
