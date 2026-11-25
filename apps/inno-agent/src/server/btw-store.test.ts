import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BTW_INTERRUPTED_ERROR,
	clearSessionBtw,
	readBtwState,
	resetBtwStoreForTests,
	writeBtwState,
} from "./btw-store.js";
import { FileStateKv } from "../tenants/state-store.js";

let dataDir: string;
let kv: FileStateKv;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "btw-store-"));
	kv = new FileStateKv(dataDir);
	resetBtwStoreForTests();
});

afterEach(() => {
	resetBtwStoreForTests();
	rmSync(dataDir, { recursive: true, force: true });
});

describe("btw sidecar store", () => {
	it("returns an empty session and default geometry when no sidecar exists", async () => {
		expect(await readBtwState(kv, "s1")).toEqual({
			session: { nextTabNumber: 1, activeTabId: null, tabs: [] },
			window: { x: 0, y: 0, width: 520, height: 420 },
			windowInitialized: false,
			minimized: false,
		});
	});

	it("persists sessions independently while sharing window state", async () => {
		const payload = {
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{ id: "tab-1", number: 1, draft: "草稿", scrollTop: 12, exchanges: [] }],
			},
			window: { x: 24, y: 30, width: 520, height: 420 },
			windowInitialized: true,
			minimized: true,
		};
		await writeBtwState(kv, "s1", payload);

		expect(await readBtwState(kv, "s1")).toEqual(payload);
		expect((await readBtwState(kv, "s2")).session).toEqual({ nextTabNumber: 1, activeTabId: null, tabs: [] });
	});

	it("restores pending exchanges as retryable errors after a store restart", async () => {
		await writeBtwState(kv, "s1", {
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{
					id: "tab-1",
					number: 1,
					draft: "",
					scrollTop: 0,
					exchanges: [{ id: "exchange-1", question: "问题", answer: "", status: "pending" }],
				}],
			},
			window: { x: 0, y: 0, width: 520, height: 420 },
			windowInitialized: false,
			minimized: false,
		});
		resetBtwStoreForTests();

		const restored = await readBtwState(kv, "s1");
		expect(restored.session.tabs[0].exchanges[0]).toMatchObject({
			status: "error",
			error: BTW_INTERRUPTED_ERROR,
		});
	});

	it("falls back to defaults for a malformed sidecar", async () => {
		await kv.set("btw:session:s1", "not-an-object");
		expect((await readBtwState(kv, "s1")).session.tabs).toEqual([]);
	});

	it("clears one session without removing another", async () => {
		const empty = await readBtwState(kv, "s1");
		await writeBtwState(kv, "s1", empty);
		await writeBtwState(kv, "s2", empty);
		await clearSessionBtw(kv, "s1");
		expect((await readBtwState(kv, "s1")).session.tabs).toEqual([]);
		expect((await readBtwState(kv, "s2")).session).toEqual(empty.session);
	});
});
