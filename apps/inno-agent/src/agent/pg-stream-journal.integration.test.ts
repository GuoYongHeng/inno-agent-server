import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { StreamRegistry } from "../chat/stream-registry.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { TenantStore } from "../tenants/store.js";
import { PgStreamJournal } from "./pg-stream-journal.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let a = "";
let b = "";
const sessionA = "durable-123e4567-e89b-42d3-a456-426614174000";
const sessionB = "durable-223e4567-e89b-42d3-a456-426614174000";

function newTurn(sessionId = sessionA, requestId = "request-1") {
	const registry = new StreamRegistry();
	const state = registry.createTurn({
		sessionId,
		clientRequestId: requestId,
		workspaceId: "workspace-1",
		workspaceRoot: "/tmp/workspace",
		inputSnapshot: { prompt: "raw prompt", submittedAt: new Date().toISOString(), images: [] },
		baselineMessageCount: 0,
		baselineSessionRevision: "durable:0",
	});
	return { registry, state };
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "journal-integration-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	for (const id of ["user-a", "user-b"]) {
		await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, false, NOW(), NOW())`, [id, `${id}@example.com`]);
	}
	const tenants = new TenantStore(pool);
	a = (await tenants.ensurePersonalTenant("user-a")).tenantId;
	b = (await tenants.ensurePersonalTenant("user-b")).tenantId;
	for (const [tenant, id] of [[a, sessionA], [b, sessionB]] as const) {
		await pool.query("INSERT INTO resource_ownership (tenant_id, resource_type, resource_id) VALUES ($1, 'session', $2)", [tenant, id]);
	}
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
});

describe("PgStreamJournal", () => {
	it("lets another worker restore exact event IDs, submission intent and cancellation", async () => {
		const { registry, state } = newTurn();
		const journal = new PgStreamJournal(pool, a);
		const input = [{ type: "text" as const, text: "raw prompt" }, { type: "text" as const, text: "hidden recall \u0000 nul" }];
		await journal.create(state, input);
		journal.append(registry.publishStreamEvent(state, { type: "stream_state", status: "queued" }));
		journal.append(registry.publishStreamEvent(state, { type: "stream_state", status: "running" }));
		journal.append(registry.publishStreamEvent(state, { type: "text_delta", delta: "partial", contentIndex: 0 }));
		await journal.markAdmitted(state.sessionId, state.turnId, 42 as SubmissionId);
		await journal.markCancelled(state.sessionId, state.turnId);

		const restored = (await new PgStreamJournal(pool, a).load(state.sessionId, state.turnId))!;
		expect(restored.input[1]).toMatchObject({ type: "text", text: "hidden recall � nul" });
		expect(restored.submissionId).toBe(42);
		expect(restored.cancelRequested).toBe(true);
		expect(restored.terminal).toBe(false);
		const recovered = new StreamRegistry().restoreTurn(restored.snapshot, restored.history, restored.cancelRequested);
		expect(recovered.turnId).toBe(state.turnId);
		expect(recovered.status).toBe("running");
		expect(restored.history.map((envelope) => envelope.eventId)).toEqual([1, 2, 3]);
	});

	it("keeps event order when many appends are in flight", async () => {
		const { registry, state } = newTurn(sessionA, "request-order");
		const journal = new PgStreamJournal(pool, a);
		await journal.create(state, []);
		journal.append(registry.publishStreamEvent(state, { type: "stream_state", status: "running" }));
		for (let i = 0; i < 1_199; i += 1) journal.append(registry.publishStreamEvent(state, { type: "text_delta", delta: `d${i}`, contentIndex: 0 }));
		const restored = (await journal.load(state.sessionId, state.turnId))!;
		expect(restored.history).toHaveLength(1_200);
		expect(restored.history.map((envelope) => envelope.eventId)).toEqual(Array.from({ length: 1_200 }, (_, i) => i + 1));
	});

	it("refuses to overwrite an existing turn or a session the tenant does not own", async () => {
		const { state } = newTurn(sessionA, "request-dup");
		const journal = new PgStreamJournal(pool, a);
		await journal.create(state, []);
		await expect(journal.create(state, [])).rejects.toThrow(/already exists/);
		const foreign = newTurn(sessionA, "request-foreign").state;
		await expect(new PgStreamJournal(pool, b).create(foreign, [])).rejects.toThrow(/not owned/);
	});

	it("keeps a finished turn replayable for the retention window, then drops it", async () => {
		const { registry, state } = newTurn(sessionA, "request-finished");
		const journal = new PgStreamJournal(pool, a, 150);
		await journal.create(state, []);
		journal.append(registry.publishStreamEvent(state, { type: "stream_state", status: "running" }));
		const done = registry.finishTurn(state, "completed", { type: "done" } as never, { persisted: true });
		journal.append(done!);
		expect((await journal.load(state.sessionId, state.turnId))?.terminal).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await journal.load(state.sessionId, state.turnId)).toBeUndefined();
		expect((await pool.query("SELECT COUNT(*)::int AS n FROM stream_events WHERE turn_id = $1", [state.turnId])).rows[0].n).toBe(0);
	});

	it("returns the newest turn as latest and isolates tenants", async () => {
		const first = newTurn(sessionB, "request-b1");
		const second = newTurn(sessionB, "request-b2");
		const journal = new PgStreamJournal(pool, b);
		await journal.create(first.state, []);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await journal.create(second.state, []);
		expect((await journal.latest(sessionB))?.snapshot.turnId).toBe(second.state.turnId);
		expect(await new PgStreamJournal(pool, a).latest(sessionB)).toBeUndefined();
		await journal.deleteSession(sessionB);
		expect(await journal.latest(sessionB)).toBeUndefined();
	});
});
