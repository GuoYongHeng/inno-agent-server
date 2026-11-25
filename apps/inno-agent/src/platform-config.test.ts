import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, QueryResult } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	pickImmutableConfig,
	pickMutableConfig,
	readRawConfigFile,
	resolvePlatformConfig,
	type PlatformConfigDoc,
} from "./platform-config.js";

/** In-memory Pool stub: one platform_config row, records every upsert. */
function fakePool(initial?: PlatformConfigDoc) {
	const state = { doc: initial, saves: 0 };
	const pool = {
		async query(sql: string, params?: unknown[]): Promise<QueryResult> {
			if (sql.includes("SELECT config FROM platform_config")) {
				return { rows: state.doc ? [{ config: JSON.stringify(state.doc) }] : [] } as unknown as QueryResult;
			}
			if (sql.includes("INSERT INTO platform_config")) {
				state.doc = JSON.parse(String(params![0])) as PlatformConfigDoc;
				state.saves += 1;
				return { rows: [] } as unknown as QueryResult;
			}
			throw new Error(`unexpected sql: ${sql}`);
		},
	} as unknown as Pool;
	return { pool, state };
}

const PROVIDERS = {
	alpha: {
		baseUrl: "https://example.invalid",
		apiKey: "k",
		models: [{ id: "m1", name: "m1", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
	},
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-platform-cfg-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readRawConfigFile", () => {
	it("returns {} when the file is absent", () => {
		expect(readRawConfigFile(join(dir, "config.json"))).toEqual({});
	});
	it("throws on malformed JSON", () => {
		const path = join(dir, "config.json");
		writeFileSync(path, "{ nope");
		expect(() => readRawConfigFile(path)).toThrow(/Failed to load Inno config/);
	});
});

describe("key split", () => {
	it("separates immutable and mutable keys", () => {
		const raw = {
			server: { port: 3000 },
			objectStorage: { provider: "s3" },
			presets: { dir: "/app/presets" },
			providers: PROVIDERS,
			tavily: { apiKey: "x" },
			smartInput: { enabled: false },
		};
		expect(pickImmutableConfig(raw)).toEqual({
			server: { port: 3000 },
			objectStorage: { provider: "s3" },
			presets: { dir: "/app/presets" },
		});
		expect(Object.keys(pickMutableConfig(raw)).sort()).toEqual(["providers", "tavily"]);
	});
});

describe("resolvePlatformConfig", () => {
	it("merges the stored managed doc over file deployment fields", async () => {
		const { pool, state } = fakePool({ providers: PROVIDERS, tavily: { apiKey: "db-key" } });
		const { config, doc } = await resolvePlatformConfig(pool, {
			defaultProvider: "alpha",
			defaultModel: "m1",
			objectStorage: { provider: "s3" },
		});
		expect(state.saves).toBe(0); // never writes — the row is the source of truth
		expect(doc.providers).toEqual(PROVIDERS);
		expect(config.defaultProvider).toBe("alpha");
		expect(config.tavily).toEqual({ apiKey: "db-key" });
		expect(config.objectStorage).toEqual({ provider: "s3" });
	});

	it("rejects a file that declares server-managed keys", async () => {
		const { pool } = fakePool({ providers: PROVIDERS });
		await expect(
			resolvePlatformConfig(pool, { providers: PROVIDERS, tavily: { apiKey: "x" } }),
		).rejects.toThrow(/server-managed keys: providers, tavily/);
	});

	it("throws when neither file defaults nor the DB doc provide a provider", async () => {
		const { pool } = fakePool();
		await expect(resolvePlatformConfig(pool, {})).rejects.toThrow(/at least one provider/);
	});

	it("platform defaults for memory/ui/scheduler come from hardcoded normalize defaults", async () => {
		const { pool } = fakePool({ providers: PROVIDERS });
		const { config } = await resolvePlatformConfig(pool, {});
		expect(config.memory?.l2Enabled).toBe(true);
		expect(config.scheduler?.timezone).toBe("Asia/Shanghai");
		expect(config.ui?.theme).toBe("light");
	});
});
