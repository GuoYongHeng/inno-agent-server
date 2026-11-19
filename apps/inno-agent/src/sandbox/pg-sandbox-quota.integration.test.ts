import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { TenantStore } from "../tenants/store.js";
import { PgSandboxQuotaStore } from "./pg-sandbox-quota.js";
import { SANDBOX_LEASE_STALE_MS, type SandboxLimits } from "./sandbox-quota.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: PgSandboxQuotaStore;
let a = "";
let b = "";

const limits = (over: Partial<SandboxLimits> = {}): SandboxLimits => ({ maxConcurrent: 3, maxSandboxes: 20, maxActiveMinutesPerDay: 60, ...over });

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "quota-integration-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	for (const id of ["user-a", "user-b"]) {
		await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, false, NOW(), NOW())`, [id, `${id}@example.com`]);
	}
	const tenants = new TenantStore(pool);
	a = (await tenants.ensurePersonalTenant("user-a")).tenantId;
	b = (await tenants.ensurePersonalTenant("user-b")).tenantId;
	store = new PgSandboxQuotaStore(pool);
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
});

describe("PgSandboxQuotaStore", () => {
	it("lets exactly the allowed number of concurrent opens through, even when they race", async () => {
		const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.acquire(a, `race-${i}`, limits({ maxConcurrent: 3 }))));
		expect(results.filter((r) => r.ok)).toHaveLength(3);
		expect(results.filter((r) => !r.ok && r.reason === "concurrent")).toHaveLength(9);
		expect((await pool.query("SELECT COUNT(*)::int AS n FROM sandbox_leases WHERE tenant_id = $1", [a])).rows[0].n).toBe(3);
		// Another tenant is unaffected.
		expect((await store.acquire(b, "other-tenant", limits({ maxConcurrent: 3 }))).ok).toBe(true);
	});

	it("re-acquiring a session's own lease is idempotent and releasing frees the slot", async () => {
		const winner = (await pool.query("SELECT session_id FROM sandbox_leases WHERE tenant_id = $1 LIMIT 1", [a])).rows[0].session_id as string;
		expect((await store.acquire(a, winner, limits({ maxConcurrent: 3 }))).ok).toBe(true);
		expect((await store.acquire(a, "newcomer", limits({ maxConcurrent: 3 }))).ok).toBe(false);
		await store.release(a, winner);
		expect((await store.acquire(a, "newcomer", limits({ maxConcurrent: 3 }))).ok).toBe(true);
	});

	it("adds a released lease's running time to today's usage and enforces the daily budget", async () => {
		await pool.query("DELETE FROM sandbox_leases WHERE tenant_id = $1", [b]);
		await pool.query("DELETE FROM sandbox_usage WHERE tenant_id = $1", [b]);
		await store.acquire(b, "metered", limits());
		await pool.query("UPDATE sandbox_leases SET started_at = now() - interval '40 minutes' WHERE session_id = 'metered'");
		const during = await store.usedMinutesToday(b);
		expect(during >= 40 && during <= 41).toBe(true);
		expect((await store.heartbeat(b, "metered", limits({ maxActiveMinutesPerDay: 60 }))).ok).toBe(true);
		await pool.query("UPDATE sandbox_leases SET started_at = now() - interval '61 minutes' WHERE session_id = 'metered'");
		expect(await store.heartbeat(b, "metered", limits({ maxActiveMinutesPerDay: 60 }))).toMatchObject({ ok: false, reason: "time" });
		await store.release(b, "metered");
		const after = await store.usedMinutesToday(b);
		expect(after >= 61 && after <= 62).toBe(true);
		expect(await store.acquire(b, "again", limits({ maxActiveMinutesPerDay: 60 }))).toMatchObject({ ok: false, reason: "time" });
		expect((await store.acquire(b, "again", limits({ maxActiveMinutesPerDay: 0 }))).ok).toBe(true);
	});

	it("reaps a dead worker's lease, billing it up to its last heartbeat", async () => {
		await pool.query("DELETE FROM sandbox_leases WHERE tenant_id = $1", [a]);
		await pool.query("DELETE FROM sandbox_usage WHERE tenant_id = $1", [a]);
		await store.acquire(a, "ghost", limits({ maxConcurrent: 1 }));
		const stale = `${Math.ceil(SANDBOX_LEASE_STALE_MS / 60_000) + 5} minutes`;
		await pool.query(
			"UPDATE sandbox_leases SET started_at = now() - interval '90 minutes', heartbeat_at = now() - $1::interval WHERE session_id = 'ghost'", [stale]);
		expect((await store.acquire(a, "live", limits({ maxConcurrent: 1, maxActiveMinutesPerDay: 0 }))).ok).toBe(true);
		const usage = (await pool.query("SELECT active_ms FROM sandbox_usage WHERE tenant_id = $1", [a])).rows[0];
		// 90 minutes started, last heartbeat 15 minutes ago: billed 75 minutes.
		expect(Math.round(Number(usage.active_ms) / 60_000)).toBe(75);
		expect((await pool.query("SELECT 1 FROM sandbox_leases WHERE session_id = 'ghost'")).rowCount).toBe(0);
	});
});
