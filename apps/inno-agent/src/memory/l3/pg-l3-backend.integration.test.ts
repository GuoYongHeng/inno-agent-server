import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../../auth/config.js";
import { migrateAuthDatabase } from "../../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../../db/test-postgres.js";
import { enterTenantContext } from "../../tenants/current.js";
import { TenantStore, type TenantContext } from "../../tenants/store.js";
import { indexSessionMessages } from "./indexer.js";
import { PgL3Backend } from "./pg-l3-backend.js";
import { ScopedL3Memory } from "./l3-tools.js";
import { formatRecallForPrompt, recall } from "./recall.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
let tenantA: TenantContext;
let tenantB: TenantContext;
let dataDir: string;

const message = (content: string, timestamp = 1, role: "user" | "assistant" = "user") => ({ role, content, timestamp });

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "l3-pg-integration-secret-at-least-32-characters",
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	for (const id of ["l3-user-a", "l3-user-b"]) {
		await pool.query(
			`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, false, NOW(), NOW())`,
			[id, `${id}@example.com`],
		);
	}
	tenantA = await store.ensurePersonalTenant("l3-user-a");
	tenantB = await store.ensurePersonalTenant("l3-user-b");
	dataDir = mkdtempSync(join(tmpdir(), "inno-l3-pg-"));
});

afterAll(async () => {
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	await pool?.end();
	await postgres?.close();
});

describe("PgL3Backend", () => {
	it("indexes a session once per revision and replaces its chunks atomically on a new one", async () => {
		const backend = new PgL3Backend(pool, tenantA.tenantId);
		expect(await indexSessionMessages(backend, "durable-a", [
			message("今天学习了机器学习的基础概念"),
			message("好的，我们从梯度下降开始复习", 2, "assistant"),
		], 1)).toBe(2);
		expect(await indexSessionMessages(backend, "durable-a", [
			message("今天学习了机器学习的基础概念"),
			message("好的，我们从梯度下降开始复习", 2, "assistant"),
		], 1)).toBe(0);
		expect(await backend.getIndexState("durable-a")).toEqual({ lastOffset: 2, lastMtimeMs: 1, chunkCount: 2 });

		expect(await indexSessionMessages(backend, "durable-a", [message("只剩下卷积神经网络的笔记内容")], 2)).toBe(1);
		expect(await backend.searchLexical("梯度下降", 8)).toEqual([]);
		const hits = await backend.searchLexical("卷积神经网络", 8);
		expect(hits.map((hit) => hit.id)).toEqual(["durable-a:0"]);
		expect(hits[0]!.bm25).toBeLessThan(0);
	});

	it("ranks the better match first and returns nothing for absent terms", async () => {
		const backend = new PgL3Backend(pool, tenantA.tenantId);
		await indexSessionMessages(backend, "durable-rank", [
			message("机器学习入门课程的第一章内容", 1),
			message("机器学习的学习笔记与公式推导，机器学习课程总结", 2),
			message("完全无关的烹饪食谱内容", 3),
		], 1);
		const hits = await backend.searchLexical("机器学习", 8);
		expect(hits.map((hit) => hit.sessionId)).toEqual(["durable-rank", "durable-rank"]);
		expect(hits.every((hit) => !hit.text.includes("烹饪"))).toBe(true);
		expect(await backend.searchLexical("区块链", 8)).toEqual([]);
		expect(await backend.searchLexical("", 8)).toEqual([]);
	});

	it("matches ASCII words case-insensitively and survives a NUL in the text", async () => {
		const backend = new PgL3Backend(pool, tenantA.tenantId);
		await indexSessionMessages(backend, "durable-ascii", [message("Python AsyncIO 的报错 \u0000 排查记录")], 1);
		const hits = await backend.searchLexical("python asyncio", 8);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.text).toContain("排查记录");
		expect(hits[0]!.text).not.toContain("\u0000");
	});

	it("never returns another tenant's chunks, even for the same chunk ids", async () => {
		const a = new PgL3Backend(pool, tenantA.tenantId);
		const b = new PgL3Backend(pool, tenantB.tenantId);
		await indexSessionMessages(a, "durable-shared-id", [message("租户甲的私有记忆 tenant-a-secret")], 1);
		await indexSessionMessages(b, "durable-shared-id", [message("租户乙的私有记忆 tenant-b-secret")], 1);
		expect((await a.searchLexical("私有记忆", 8)).map((hit) => hit.text).join("|")).not.toContain("tenant-b-secret");
		expect((await b.searchLexical("私有记忆", 8)).map((hit) => hit.text).join("|")).not.toContain("tenant-a-secret");
		await b.deleteSession("durable-shared-id");
		expect(await b.searchLexical("私有记忆", 8)).toEqual([]);
		expect(await b.getIndexState("durable-shared-id")).toBeNull();
		expect(await a.searchLexical("私有记忆", 8)).toHaveLength(1);
	});

	it("applies the same coverage gate, exclusion and prompt formatting as the SQLite backend", async () => {
		const backend = new PgL3Backend(pool, tenantA.tenantId);
		await indexSessionMessages(backend, "durable-old", [message("上周我们讨论了深度优先搜索的学习笔记")], 1);
		expect(await recall(backend, "区块链技术")).toHaveLength(0);
		expect(await recall(backend, "深")).toHaveLength(0);
		expect(await recall(backend, "深度优先搜索", { excludeSessionId: "durable-old" })).toHaveLength(0);
		const results = await recall(backend, "深度优先搜索", { excludeSessionId: "durable-new" });
		expect(results).toHaveLength(1);
		expect(formatRecallForPrompt(results)).toContain("相关历史对话");
	});
});

describe("ScopedL3Memory on PostgreSQL", () => {
	it("keeps each tenant's index separate, hides released sessions and cleans up deleted ones", async () => {
		await store.claimResource(tenantA, "session", "scoped-a");
		await store.claimResource(tenantB, "session", "scoped-b");
		const memory = new ScopedL3Memory(dataDir, pool);
		enterTenantContext(tenantA, store);
		await memory.indexMessages("scoped-a", [message("微积分 tenant-a-calculus 笔记")], 1);
		enterTenantContext(tenantB, store);
		await memory.indexMessages("scoped-b", [message("烹饪 tenant-b-cooking 食谱")], 1);
		// A session the tenant does not own is never indexed.
		await memory.indexMessages("scoped-a", [message("微积分 intruder-text 笔记")], 2);

		enterTenantContext(tenantA, store);
		const resultsA = await memory.recall("微积分笔记");
		expect(resultsA.map((result) => result.sessionId)).toEqual(["scoped-a"]);
		expect(resultsA[0]!.text).toContain("tenant-a-calculus");
		enterTenantContext(tenantB, store);
		expect(await memory.recall("微积分笔记")).toEqual([]);

		await store.releaseResource(tenantA, "session", "scoped-a");
		enterTenantContext(tenantA, store);
		expect(await memory.recall("微积分笔记")).toEqual([]);

		await memory.deleteSession("scoped-a");
		expect(await new PgL3Backend(pool, tenantA.tenantId).getIndexState("scoped-a")).toBeNull();
		expect((await pool.query("SELECT COUNT(*)::int AS n FROM l3_chunks WHERE session_id = 'scoped-a'")).rows[0].n).toBe(0);
	});
});
