import { describe, expect, it } from "vitest";
import type { InnoConfig } from "../config.js";
import { runInTenantContext } from "./current.js";
import {
	createEmptyTenantConfig,
	loadTenantConfig,
	persistTenantConfig,
	resolveCurrentTenantConfig,
} from "./config.js";
import type { TenantContext, TenantStore } from "./store.js";

function context(tenantId: string): TenantContext {
	return { tenantId, userId: `user-${tenantId}`, role: "owner" };
}

/** In-memory stand-in for the tenant_configs PostgreSQL row. */
function fakeStore() {
	const records = new Map<string, string>();
	const store = {
		loadTenantConfigRecord: async (tenantId: string) =>
			records.has(tenantId) ? { config: records.get(tenantId)!, updatedAt: "1" } : null,
		saveTenantConfigRecord: async (tenantId: string, configJson: string) => {
			records.set(tenantId, configJson);
			return "1";
		},
	} as unknown as TenantStore;
	return { store, records };
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

describe("tenant configuration", () => {
	it("does not inherit legacy providers or integration credentials", async () => {
		const { store } = fakeStore();
		const config = await loadTenantConfig(store, "tenant-a");
		expect(config.providers).toEqual({});
		expect(config.defaultProvider).toBe("");
		expect(config.defaultModel).toBe("");
		expect(config.tavily).toBeUndefined();
	});

	it("merges server-managed fields from global config with tenant selections", async () => {
		const { store } = fakeStore();
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
		await persistTenantConfig(store, "tenant-a", tenantA);

		await runInTenantContext(context("tenant-a"), store, async () => {
			const resolved = await resolveCurrentTenantConfig(local);
			expect(resolved.providers.legacy.apiKey).toBe("legacy-secret");
			expect(resolved.defaultProvider).toBe("shared");
			expect(resolved.defaultModel).toBe("model-a");
			expect(resolved.channels?.qq).toMatchObject({ enabled: true, allowedUserIds: ["u1"] });
		});
		await runInTenantContext(context("tenant-b"), store, async () => {
			const resolved = await resolveCurrentTenantConfig(local);
			expect(resolved.providers.legacy.apiKey).toBe("legacy-secret");
			expect(resolved.defaultProvider).toBe(local.defaultProvider);
		});
		expect(await resolveCurrentTenantConfig(local)).toBe(local);
	});
});
