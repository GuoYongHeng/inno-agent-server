import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexSessionMessages } from "./indexer.js";
import { SqliteL3Backend } from "./l3-backend.js";
import { formatRecallForPrompt, recall } from "./recall.js";
import { openL3Store, segmentForFts, type L3Store } from "./sqlite-store.js";

/**
 * L3 tests. `segmentForFts` is a pure function and always runs. The store /
 * indexer / recall suites need node:sqlite with FTS5 enabled. Some Node builds
 * expose node:sqlite without compiling the FTS5 module; L3 intentionally
 * degrades to disabled in either case, so the integration suite must probe the
 * feature rather than infer it from the Node version.
 */
function nodeSqliteFts5Available(): boolean {
	let db: { exec(sql: string): void; close(): void } | undefined;
	try {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as {
			DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
		};
		db = new DatabaseSync(":memory:");
		db.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)");
		return true;
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

describe("segmentForFts (pure)", () => {
	it("splits CJK runs into overlapping bigrams", async () => {
		expect(segmentForFts("学习计划")).toBe("学习 习计 计划");
	});

	it("keeps ASCII runs whole and lowercased", async () => {
		expect(segmentForFts("Python AsyncIO")).toBe("python asyncio");
	});

	it("handles mixed CJK/ASCII and punctuation (single CJK chars stay unigrams)", async () => {
		expect(segmentForFts("用Node.js写爬虫")).toBe("用 node js 写爬 爬虫");
	});

	it("returns empty string for empty input", async () => {
		expect(segmentForFts("")).toBe("");
	});
});

describe.skipIf(!nodeSqliteFts5Available())("L3 store + recall (node:sqlite + FTS5)", () => {
	let l3Dir: string;
	let store: L3Store | null;

	beforeEach(async () => {
		l3Dir = mkdtempSync(join(tmpdir(), "inno-l3-db-"));
		store = await openL3Store(l3Dir);
		expect(store).not.toBeNull();
	});

	afterEach(() => {
		store?.close();
		rmSync(l3Dir, { recursive: true, force: true });
	});

	function upsert(sessionId: string, texts: string[], role: "user" | "assistant" = "user") {
		store!.upsertChunks(
			texts.map((text, i) => ({
				id: `${sessionId}:${i}`,
				sessionId,
				role,
				text,
				ts: Date.parse("2026-08-01T10:00:00Z") + i,
			})),
		);
	}

	it("upserts chunks and finds them via CJK bigram search", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		const hits = store!.searchLexical("机器学习");
		expect(hits).toHaveLength(1);
		expect(hits[0].sessionId).toBe("s1");
		expect(hits[0].bm25).toBeLessThan(0);
	});

	it("returns no hits for lexically absent queries", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(store!.searchLexical("烹饪食谱")).toHaveLength(0);
	});

	it("recall gates on coverage: unrelated queries inject nothing", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(await recall(new SqliteL3Backend(store!), "机器学习")).toHaveLength(1);
		expect(await recall(new SqliteL3Backend(store!), "烹饪食谱")).toHaveLength(0);
	});

	it("recall rejects too-short queries (single CJK char)", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(await recall(new SqliteL3Backend(store!), "机")).toHaveLength(0);
	});

	it("recall excludes the active session", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(await recall(new SqliteL3Backend(store!), "机器学习", { excludeSessionId: "s1" })).toHaveLength(0);
	});

	it("recall dedups near-identical snippets", async () => {
		const text = "我们在整理机器学习的学习笔记和公式推导";
		upsert("s1", [text]);
		upsert("s2", [text]);
		const results = await recall(new SqliteL3Backend(store!), "机器学习");
		expect(results).toHaveLength(1);
	});

	it("recall on a null store degrades to empty", async () => {
		expect(await recall(null, "机器学习")).toEqual([]);
	});

	it("deleteSession removes chunks, FTS rows, and index state", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		store!.setIndexState("s1", 100, 200, 1);
		expect(store!.chunkCount()).toBe(1);

		store!.deleteSession("s1");

		expect(store!.chunkCount()).toBe(0);
		expect(store!.searchLexical("机器学习")).toHaveLength(0);
		expect(store!.getIndexState("s1")).toBeNull();
	});

	it("index state round-trips", async () => {
		expect(store!.getIndexState("s1")).toBeNull();
		store!.setIndexState("s1", 123, 456, 7);
		expect(store!.getIndexState("s1")).toEqual({ lastOffset: 123, lastMtimeMs: 456, chunkCount: 7 });
	});

	it("indexes the projected history of durable sessions", async () => {
		const written = await indexSessionMessages(new SqliteL3Backend(store!), "durable-a", [
			{ role: "user", content: "今天学习了机器学习的基础概念", timestamp: 1 },
			{ role: "assistant", content: "好的，我们从梯度下降开始复习", timestamp: 2 },
		], 1);
		expect(written).toBe(2);
		expect(store!.chunkCount()).toBe(2);
		expect(store!.searchLexical("机器学习")).toHaveLength(1);
	});

	it("end-to-end: indexed history is recallable from a later session", async () => {
		await indexSessionMessages(new SqliteL3Backend(store!), "durable-old", [
			{ role: "user", content: "上周我们讨论了机器学习的学习笔记", timestamp: 1 },
		], 1);

		const results = await recall(new SqliteL3Backend(store!), "机器学习", { excludeSessionId: "durable-new" });
		expect(results).toHaveLength(1);
		const promptSection = formatRecallForPrompt(results);
		expect(promptSection).toContain("相关历史对话");
		expect(promptSection).toContain("机器学习");
	});

	it("recall rejects too-short queries (single CJK char)", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(await recall(new SqliteL3Backend(store!), "机")).toHaveLength(0);
	});

	it("recall excludes the active session", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(await recall(new SqliteL3Backend(store!), "机器学习", { excludeSessionId: "s1" })).toHaveLength(0);
	});

	it("recall dedups near-identical snippets", async () => {
		const text = "我们在整理机器学习的学习笔记和公式推导";
		upsert("s1", [text]);
		upsert("s2", [text]);
		const results = await recall(new SqliteL3Backend(store!), "机器学习");
		expect(results).toHaveLength(1);
	});

	it("recall on a null store degrades to empty", async () => {
		expect(await recall(null, "机器学习")).toEqual([]);
	});

	it("deleteSession removes chunks, FTS rows, and index state", async () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		store!.setIndexState("s1", 100, 200, 1);
		expect(store!.chunkCount()).toBe(1);

		store!.deleteSession("s1");

		expect(store!.chunkCount()).toBe(0);
		expect(store!.searchLexical("机器学习")).toHaveLength(0);
		expect(store!.getIndexState("s1")).toBeNull();
	});

	it("index state round-trips", async () => {
		expect(store!.getIndexState("s1")).toBeNull();
		store!.setIndexState("s1", 123, 456, 7);
		expect(store!.getIndexState("s1")).toEqual({ lastOffset: 123, lastMtimeMs: 456, chunkCount: 7 });
	});

	it("recalls history indexed from a durable session in a later session", async () => {
		await indexSessionMessages(new SqliteL3Backend(store!), "durable-old", [
			{ role: "user", content: "上周我们讨论了机器学习的学习笔记", timestamp: 1 },
		], 1);

		const results = await recall(new SqliteL3Backend(store!), "机器学习", { excludeSessionId: "durable-new" });
		expect(results).toHaveLength(1);
		const promptSection = formatRecallForPrompt(results);
		expect(promptSection).toContain("相关历史对话");
		expect(promptSection).toContain("机器学习");
	});

	it("indexes projected durable messages idempotently by committed revision", async () => {
		const messages = [
			{ role: "user" as const, content: "之前学习了机器学习的基本概念", timestamp: 1 },
			{ role: "assistant" as const, content: "我们从监督学习开始复习", timestamp: 2 },
		];
		expect(await indexSessionMessages(new SqliteL3Backend(store!), "durable-a", messages, 2)).toBe(2);
		expect(await indexSessionMessages(new SqliteL3Backend(store!), "durable-a", messages, 2)).toBe(0);
		expect(await recall(new SqliteL3Backend(store!), "机器学习", { excludeSessionId: "durable-current" })).toHaveLength(1);
		expect(await recall(new SqliteL3Backend(store!), "机器学习", { excludeSessionId: "durable-a" })).toHaveLength(0);

		const updated = [...messages, { role: "user" as const, content: "接着复习线性代数", timestamp: 3 }];
		expect(await indexSessionMessages(new SqliteL3Backend(store!), "durable-a", updated, 3)).toBe(3);
		expect(store!.getIndexState("durable-a")).toMatchObject({ lastOffset: 3, lastMtimeMs: 3, chunkCount: 3 });
	});

	it("formatRecallForPrompt returns empty string when there is nothing to inject", async () => {
		expect(formatRecallForPrompt([])).toBe("");
	});
});
