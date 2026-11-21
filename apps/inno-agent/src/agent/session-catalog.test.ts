import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionCatalog, type DurableSessionRecord } from "./session-catalog.js";

const req = { headers: {} } as IncomingMessage;

function record(id: string, updatedAt: string): DurableSessionRecord {
	return {
		id, workspaceId: "w", name: "s", createdAt: updatedAt, updatedAt,
		messageCount: 0, preview: "", provider: "p", modelId: "m",
		origin: "web", archived: false,
	};
}

function uuid(n: number): string {
	return `durable-${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

describe("FileSessionCatalog.listPage", () => {
	let dir: string;
	let catalog: FileSessionCatalog;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "inno-filecat-"));
		catalog = new FileSessionCatalog(() => join(dir, "sessions.json"));
		for (const [i, id] of [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)].entries()) {
			await catalog.insert(req, record(id, `2026-01-0${i + 1}T00:00:00.000Z`));
		}
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("walks the whole catalog in pages without skipping or duplicating", async () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await catalog.listPage(req, { limit: 2, ...(cursor ? { cursor } : {}) });
			seen.push(...page.records.map((r) => r.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(seen).toEqual([uuid(5), uuid(4), uuid(3), uuid(2), uuid(1)]);
	});

	it("returns no cursor when the page holds everything", async () => {
		const page = await catalog.listPage(req, { limit: 10 });
		expect(page.records).toHaveLength(5);
		expect(page.nextCursor).toBeNull();
	});

	it("orders same-timestamp rows by id descending across a page boundary", async () => {
		for (const id of [uuid(7), uuid(6)]) await catalog.insert(req, record(id, "2026-01-05T00:00:00.000Z"));
		const page1 = await catalog.listPage(req, { limit: 2 });
		expect(page1.records.map((r) => r.id)).toEqual([uuid(7), uuid(6)]);
		const page2 = await catalog.listPage(req, { limit: 2, cursor: page1.nextCursor! });
		expect(page2.records.map((r) => r.id)).toEqual([uuid(5), uuid(4)]);
	});
});
