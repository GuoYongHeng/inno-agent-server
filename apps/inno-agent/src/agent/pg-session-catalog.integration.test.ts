import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { setRequestTenant } from "../tenants/http.js";
import { ResourceOwnershipError, TenantStore, type TenantContext } from "../tenants/store.js";
import { PgSessionCatalog } from "./pg-session-catalog.js";
import { SessionNotFoundError, type DurableSessionRecord } from "./session-catalog.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
let catalog: PgSessionCatalog;
let dir: string;
const a = { tenantId: "", userId: "user-a", role: "owner" } as TenantContext;
const b = { tenantId: "", userId: "user-b", role: "owner" } as TenantContext;
let reqA: IncomingMessage;
let reqB: IncomingMessage;

const legacyPath = (req: IncomingMessage) => join(dir, req === reqA ? "a" : "b", "sessions.json");

async function createUser(id: string) {
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, NOW(), NOW())`,
		[id, id, `${id}@example.com`]);
}

function uuid(n: number): string {
	return `durable-${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function record(id: string, over: Partial<DurableSessionRecord> = {}): DurableSessionRecord {
	const now = new Date().toISOString();
	return { id, workspaceId: "w", name: "新对话", createdAt: now, updatedAt: now, messageCount: 0, preview: "",
		provider: "p", modelId: "m", origin: "web", archived: false, ...over };
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "catalog-integration-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	await Promise.all(["user-a", "user-b"].map(createUser));
	a.tenantId = (await store.ensurePersonalTenant("user-a")).tenantId;
	b.tenantId = (await store.ensurePersonalTenant("user-b")).tenantId;
	reqA = { headers: {} } as IncomingMessage;
	reqB = { headers: {} } as IncomingMessage;
	setRequestTenant(reqA, a, store);
	setRequestTenant(reqB, b, store);
	dir = mkdtempSync(join(tmpdir(), "inno-pgcat-"));
	catalog = new PgSessionCatalog(pool, legacyPath);
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("PgSessionCatalog", () => {
	it("writes ownership and the catalog row together and round-trips every field", async () => {
		const full = record(uuid(1), { name: "Rust", topicGenerated: true, topicUpgraded: false, conversationId: "7", sandboxId: "sbx-1", archived: true, origin: "scheduler", messageCount: 3, preview: "hi" });
		await catalog.insert(reqA, full);
		expect(await catalog.get(reqA, full.id)).toEqual(full);
		expect(await store.ownsResource(a, "session", full.id)).toBe(true);
		expect((await catalog.list(reqA)).map((r) => r.id)).toContain(full.id);
	});

	it("hides and protects other tenants' sessions", async () => {
		const id = uuid(2);
		await catalog.insert(reqA, record(id));
		expect(await catalog.get(reqB, id)).toBeUndefined();
		expect((await catalog.list(reqB)).map((r) => r.id)).not.toContain(id);
		await expect(catalog.update(reqB, id, { name: "stolen" })).rejects.toBeInstanceOf(SessionNotFoundError);
		await catalog.remove(reqB, id);
		expect((await catalog.get(reqA, id))?.name).toBe("新对话");
	});

	it("rolls back the whole insert when the id is owned by another tenant", async () => {
		const id = uuid(3);
		await catalog.insert(reqA, record(id));
		await expect(catalog.insert(reqB, record(id))).rejects.toBeInstanceOf(ResourceOwnershipError);
		expect(await catalog.get(reqB, id)).toBeUndefined();
		expect((await pool.query("SELECT COUNT(*)::int AS n FROM durable_sessions WHERE id = $1", [id])).rows[0].n).toBe(1);
	});

	it("does not lose concurrent updates to different fields of one session", async () => {
		const id = uuid(4);
		await catalog.insert(reqA, record(id));
		await Promise.all([
			catalog.update(reqA, id, { name: "renamed" }),
			catalog.update(reqA, id, { messageCount: 9 }),
			catalog.update(reqA, id, { preview: "latest" }),
			catalog.update(reqA, id, { provider: "p2", modelId: "m2" }),
			catalog.update(reqA, id, { archived: true }),
			catalog.update(reqA, id, { sandboxId: "sbx-9" }),
		]);
		expect(await catalog.get(reqA, id)).toMatchObject({ name: "renamed", messageCount: 9, preview: "latest", provider: "p2", modelId: "m2", archived: true, sandboxId: "sbx-9" });
		expect((await pool.query("SELECT version FROM durable_sessions WHERE id = $1", [id])).rows[0].version).toBe(6);
	});

	it("keeps every session under concurrent creates", async () => {
		const ids = Array.from({ length: 60 }, (_, i) => uuid(1000 + i));
		await Promise.all(ids.map((id) => catalog.insert(reqA, record(id))));
		const listed = new Set((await catalog.list(reqA)).map((r) => r.id));
		expect(ids.every((id) => listed.has(id))).toBe(true);
	});

	it("lists newest first and removes ownership with the row", async () => {
		const older = uuid(5);
		const newer = uuid(6);
		await catalog.insert(reqB, record(older, { updatedAt: "2026-01-01T00:00:00.000Z" }));
		await catalog.insert(reqB, record(newer, { updatedAt: "2026-02-01T00:00:00.000Z" }));
		expect((await catalog.list(reqB)).map((r) => r.id)).toEqual([newer, older]);
		await catalog.remove(reqB, newer);
		expect(await catalog.get(reqB, newer)).toBeUndefined();
		expect(await store.ownsResource(b, "session", newer)).toBe(false);
	});

	it("imports a legacy sessions.json once, only for sessions the tenant owns, then renames it", async () => {
		const owned = uuid(7);
		const foreign = uuid(8);
		const unowned = uuid(9);
		await store.claimResource(a, "session", owned);
		await store.claimResource(b, "session", foreign);
		mkdirSync(join(dir, "a"), { recursive: true });
		writeFileSync(legacyPath(reqA), JSON.stringify([record(owned, { name: "legacy", messageCount: 4 }), record(foreign), record(unowned)]));
		const fresh = () => new PgSessionCatalog(pool, legacyPath);
		// Two workers importing the same file race; the result must be identical.
		const [x, y] = [fresh(), fresh()];
		await Promise.all([x.list(reqA), y.list(reqA)]);
		expect(await x.get(reqA, owned)).toMatchObject({ name: "legacy", messageCount: 4 });
		expect(await x.get(reqA, foreign)).toBeUndefined();
		expect(await x.get(reqA, unowned)).toBeUndefined();
		expect((await pool.query("SELECT tenant_id FROM durable_sessions WHERE id = $1", [foreign])).rowCount).toBe(0);
		expect(existsSync(legacyPath(reqA))).toBe(false);
		expect(existsSync(`${legacyPath(reqA)}.migrated`)).toBe(true);
		// A session deleted afterwards is not resurrected by a restart.
		await x.remove(reqA, owned);
		expect(await fresh().get(reqA, owned)).toBeUndefined();
	});

	it("leaves an unreadable legacy file in place instead of failing the request", async () => {
		mkdirSync(join(dir, "b"), { recursive: true });
		writeFileSync(legacyPath(reqB), "{broken");
		expect(Array.isArray(await new PgSessionCatalog(pool, legacyPath).list(reqB))).toBe(true);
		expect(existsSync(legacyPath(reqB))).toBe(true);
	});
});
