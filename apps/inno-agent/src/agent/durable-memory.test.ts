import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../memory/l2/manifest-store.js";
import { createDurableMemoryRegistrations, createDurableMemoryTools } from "./durable-memory.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "inno-durable-memory-"));
	roots.push(value);
	return value;
}

function options(base: string, sessionId: string) {
	return {
		sessionId,
		l2DataDir: join(base, "l2"),
		workspaceDir: base,
		l2Enabled: true,
	};
}

function executeTool(
	tool: ReturnType<typeof createDurableMemoryTools>[number],
	callId: string,
	params: Record<string, unknown>,
) {
	return (tool.execute as (...args: any[]) => Promise<any>)(
		params,
		{ callId },
		{ abortSignal: undefined },
	);
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable memory tools", () => {
	it("exposes the L2 tools, all replay-safe, and the L3 recall tool only when L3 is wired", () => {
		const base = root();
		const tools = createDurableMemoryRegistrations(options(base, "durable-a"));
		expect(tools.map((tool) => tool.name).sort()).toEqual(["l2_archive", "l2_lint", "l2_query"]);
		expect(tools.every((tool) => tool.replay === "safe")).toBe(true);
		const withL3 = createDurableMemoryRegistrations({
			...options(base, "durable-a"),
			l3: { enabled: true, memory: { recall: async () => [] } },
		});
		expect(withL3.map((tool) => tool.name)).toContain("l3_recall");
	});

	it("archives the same content once however many times the call is replayed", async () => {
		const base = root();
		const params = { title: "闭包", content: "闭包会保留词法环境。", sourceType: "markdown" };
		const first = createDurableMemoryTools(options(base, "durable-a")).find((tool) => tool.name === "l2_archive")!;
		await executeTool(first, "call-1", params);
		// A replay after a crash re-runs the tool with the same call ID, possibly in a new process.
		const replay = createDurableMemoryTools(options(base, "durable-a")).find((tool) => tool.name === "l2_archive")!;
		await executeTool(replay, "call-1", params);
		expect((await readManifest(join(base, "l2")))).toHaveLength(1);
	});

	it("exposes tenant-scoped L3 recall with the durable session excluded", async () => {
		const base = root();
		const calls: Array<{ query: string; exclude?: string }> = [];
		const tools = createDurableMemoryTools({
			...options(base, "durable-current"),
			l3: {
				enabled: true,
				memory: {
					recall: async (query, exclude) => {
						calls.push({ query, exclude });
						return [{ sessionId: "legacy-owned", role: "user" as const, text: "之前的机器学习计划", ts: 1, score: 1 }];
					},
				},
			},
		});
		const tool = tools.find((item) => item.name === "l3_recall")!;
		const result = await executeTool(tool, "l3-call", { query: "机器学习" });
		expect(calls).toEqual([{ query: "机器学习", exclude: "durable-current" }]);
		expect(result.output[0].text).toContain("之前的机器学习计划");
		expect(result.details).toEqual({ results: 1 });
	});
});
