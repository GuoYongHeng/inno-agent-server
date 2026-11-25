import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { TenantStore } from "../tenants/store.js";
import { DurablePermissionStore } from "./durable-permissions.js";
import { DurableQuestionStore } from "./durable-questions.js";
import { PgRecoveryStore } from "./recovery-store.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let a = "";
let b = "";
const sessionId = "durable-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scratch: string[] = [];

const params = {
	questions: [{
		question: "选择难度？",
		header: "难度",
		options: [{ label: "基础", description: "从基础开始" }, { label: "进阶", description: "加快进度" }],
	}],
};

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "recovery-integration-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	for (const id of ["user-a", "user-b"]) {
		await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, false, NOW(), NOW())`, [id, `${id}@example.com`]);
	}
	const tenants = new TenantStore(pool);
	a = (await tenants.ensurePersonalTenant("user-a")).tenantId;
	b = (await tenants.ensurePersonalTenant("user-b")).tenantId;
	for (const [tenant, id] of [[a, sessionId], [b, "durable-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]] as const) {
		await pool.query("INSERT INTO resource_ownership (tenant_id, resource_type, resource_id) VALUES ($1, 'session', $2)", [tenant, id]);
	}
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("PgRecoveryStore", () => {
	it("round-trips records, orders them by key and upserts in place", async () => {
		const store = new PgRecoveryStore(pool, a, "question");
		const k1 = hash("one");
		const k2 = hash("two");
		await store.put(sessionId, k2, { n: 2 });
		await store.put(sessionId, k1, { n: 1 });
		await store.put(sessionId, k1, { n: 11 });
		expect((await store.list<{ n: number }>(sessionId)).map((entry) => [entry.key, entry.value.n])).toEqual(
			[[k1, 11], [k2, 2]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
		);
		expect(await store.get(sessionId, k1)).toEqual({ n: 11 });
		await store.delete(sessionId, k1);
		expect(await store.get(sessionId, k1)).toBeUndefined();
		await store.deleteSession(sessionId);
		expect(await store.list(sessionId)).toEqual([]);
	});

	it("keeps tenants and kinds apart", async () => {
		const key = hash("shared-key");
		await new PgRecoveryStore(pool, a, "question").put(sessionId, key, { owner: "a" });
		expect(await new PgRecoveryStore(pool, b, "question").get(sessionId, key)).toBeUndefined();
		expect(await new PgRecoveryStore(pool, a, "permission").get(sessionId, key)).toBeUndefined();
		await new PgRecoveryStore(pool, a, "question").deleteSession(sessionId);
	});

	it("rejects keys that are not an operation hash", async () => {
		await expect(new PgRecoveryStore(pool, a, "question").put(sessionId, "../x", {})).rejects.toThrow(/Invalid recovery record key/);
	});

});

describe("question and permission stores on PostgreSQL", () => {
	it("lets a second store instance recover a pending question and accept its answer", async () => {
		const first = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		const controller = new AbortController();
		const events: Array<Record<string, unknown>> = [];
		await first.bindTurn({ turnId: "turn-one", emit: (event) => events.push(event) });
		const waiting = first.ask("stable-call", params, controller.signal);
		await vi.waitFor(() => expect(events[0]).toMatchObject({ type: "question", toolCallId: "stable-call" }));
		const questionId = (await first.pendingQuestion())!.questionId;
		controller.abort();
		await expect(waiting).rejects.toThrow();

		// A different worker opens the session: same rows, new process-local state.
		const second = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		const recovered: Array<Record<string, unknown>> = [];
		await second.bindTurn({ turnId: "turn-two", emit: (event) => recovered.push(event) });
		expect(recovered[0]).toMatchObject({ type: "question", questionId });
		const result = { answers: [{ questionIndex: 0, question: "选择难度？", kind: "option" as const, answer: "基础" }], cancelled: false };
		expect(await second.respond({ turnId: "turn-one", questionId, result })).toBe("scope_mismatch");
		expect(await second.respond({ turnId: "turn-two", questionId, result })).toBe("accepted");
		expect(await second.respond({ turnId: "turn-two", questionId, result })).toBe("already_resolved");
		// Replaying the tool call on a third worker returns the stored answer without a new card.
		const third = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		await expect(third.ask("stable-call", params, new AbortController().signal)).resolves.toEqual(result);
		expect(await third.pendingQuestion()).toBeUndefined();
	});

	it("serialises concurrent responses so exactly one is accepted", async () => {
		const store = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		await store.bindTurn({ turnId: "race-turn", emit: () => undefined });
		const waiting = store.ask("race-call", params, new AbortController().signal);
		await vi.waitFor(async () => expect(await store.pendingQuestion()).toBeDefined());
		const questionId = (await store.pendingQuestion())!.questionId;
		const result = { answers: [], cancelled: false };
		const statuses = await Promise.all(Array.from({ length: 6 }, () => store.respond({ turnId: "race-turn", questionId, result })));
		expect(statuses.filter((status) => status === "accepted")).toHaveLength(1);
		expect(statuses.filter((status) => status === "already_resolved")).toHaveLength(5);
		await expect(waiting).resolves.toEqual(result);
	});

	it("persists a denied approval across workers and prunes it after retention", async () => {
		const first = new DurablePermissionStore(sessionId, new PgRecoveryStore(pool, a, "permission"));
		await first.bindTurn({ turnId: "perm-turn", noUi: true });
		const verdict = await first.authorize("perm-call", { toolName: "write", path: "a.md", preview: "{}" }, new AbortController().signal);
		expect(verdict.kind).toBe("deny");
		const second = new DurablePermissionStore(sessionId, new PgRecoveryStore(pool, a, "permission"));
		expect((await second.authorize("perm-call", { toolName: "write", path: "a.md", preview: "{}" }, new AbortController().signal)).kind).toBe("deny");
		expect(await second.pruneCompletedForIdleSession(Date.now() - 60_000)).toBe(0);
		expect(await second.pruneCompletedForIdleSession(Date.now() + 1_000)).toBe(1);
	});

	it("survives jsonb reordering keys and a NUL in a command preview", async () => {
		const reordered = { questions: params.questions.map((q) => ({ options: q.options.map((o) => ({ description: o.description, label: o.label })), header: q.header, question: q.question })) };
		const first = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		await first.bindTurn({ turnId: "order-turn", emit: () => undefined });
		const abort = new AbortController();
		const waiting = first.ask("order-call", params, abort.signal);
		await vi.waitFor(async () => expect(await first.pendingQuestion()).toBeDefined());
		abort.abort();
		await expect(waiting).rejects.toThrow();
		const second = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		await second.bindTurn({ turnId: "order-turn-2", noUi: true });
		await expect(second.ask("order-call", reordered, new AbortController().signal)).resolves.toMatchObject({ error: "no_ui" });

		const permissions = new DurablePermissionStore(sessionId, new PgRecoveryStore(pool, a, "permission"));
		await permissions.bindTurn({ turnId: "nul-turn", noUi: true });
		const ask = { toolName: "bash", path: "echo a\0b", preview: "echo a\0b" };
		expect((await permissions.authorize("nul-call", ask, new AbortController().signal)).kind).toBe("deny");
		expect((await new DurablePermissionStore(sessionId, new PgRecoveryStore(pool, a, "permission")).authorize("nul-call", ask, new AbortController().signal)).kind).toBe("deny");
	});

	it("keeps one tenant's pending question invisible to another", async () => {
		const mine = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, a, "question"));
		await mine.bindTurn({ turnId: "iso-turn", emit: () => undefined });
		const waiting = mine.ask("iso-call", params, new AbortController().signal);
		await vi.waitFor(async () => expect(await mine.pendingQuestion()).toBeDefined());
		const theirs = new DurableQuestionStore(sessionId, new PgRecoveryStore(pool, b, "question"));
		expect(await theirs.pendingQuestion()).toBeUndefined();
		await mine.cancelTurn("iso-turn");
		await expect(waiting).resolves.toMatchObject({ cancelled: true });
	});
});
