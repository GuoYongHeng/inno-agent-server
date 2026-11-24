import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InnoConfig } from "../config.js";
import { runInTenantContext } from "./current.js";
import {
	createEmptyTenantConfig,
	loadTenantConfig,
	resolveCurrentTenantConfig,
	saveTenantConfig,
} from "./config.js";
import type { TenantContext, TenantStore } from "./store.js";

const tempDirs: string[] = [];
const tenantStore = {} as TenantStore;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-tenant-config-"));
	tempDirs.push(dir);
	return dir;
}

function context(tenantId: string): TenantContext {
	return { tenantId, userId: `user-${tenantId}`, role: "owner" };
}

function localConfig(): InnoConfig {
	return {
		...createEmptyTenantConfig(),
		defaultProvider: "legacy",
		defaultModel: "legacy-model",
		providers: {
			legacy: {
				baseUrl: "http://legacy.invalid",
				apiKey: "legacy-secret",
				models: [{ id: "legacy-model", name: "Legacy", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
			},
		},
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tenant configuration", () => {
	it("does not inherit legacy providers or integration credentials", () => {
		const dataDir = tempDir();
		const config = loadTenantConfig(dataDir, "tenant-a");
		expect(config.providers).toEqual({});
		expect(config.defaultProvider).toBe("");
		expect(config.defaultModel).toBe("");
		expect(config.tavily).toBeUndefined();
	});

	it("merges server-managed fields from global config with tenant selections", () => {
		const dataDir = tempDir();
		const local = localConfig();
		const tenantA = createEmptyTenantConfig();
		// Stale tenant-side provider entries are ignored — the shared catalog
		// always comes from the deployment config.
		tenantA.providers.shared = {
			baseUrl: "http://tenant-a.invalid",
			apiKey: "tenant-a-secret",
			models: [{ id: "model-a", name: "A", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
		};
		tenantA.defaultProvider = "shared";
		tenantA.defaultModel = "model-a";
		tenantA.channels = { qq: { enabled: true, allowedUserIds: ["u1"] } as never };
		saveTenantConfig(dataDir, "tenant-a", tenantA);

		runInTenantContext(context("tenant-a"), tenantStore, () => {
			const resolved = resolveCurrentTenantConfig(dataDir, local);
			expect(resolved.providers.legacy.apiKey).toBe("legacy-secret");
			expect(resolved.defaultProvider).toBe("shared");
			expect(resolved.defaultModel).toBe("model-a");
			expect(resolved.channels?.qq).toMatchObject({ enabled: true, allowedUserIds: ["u1"] });
		});
		runInTenantContext(context("tenant-b"), tenantStore, () => {
			const resolved = resolveCurrentTenantConfig(dataDir, local);
			expect(resolved.providers.legacy.apiKey).toBe("legacy-secret");
			expect(resolved.defaultProvider).toBe(local.defaultProvider);
		});
		expect(resolveCurrentTenantConfig(dataDir, local)).toBe(local);
	});
});
