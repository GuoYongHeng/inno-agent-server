import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	loadConfig,
	normalizeConfig,
	saveConfig,
	type InnoConfig,
} from "../config.js";
import { getCurrentTenant } from "./current.js";
import type { TenantStore } from "./store.js";

const TENANT_CONFIG_OPTIONS = { allowEmptyProviders: true } as const;

export function tenantConfigDir(dataDir: string, tenantId: string): string {
	return join(dataDir, "tenants", tenantId, "config");
}

export function tenantConfigPath(dataDir: string, tenantId: string): string {
	return join(tenantConfigDir(dataDir, tenantId), "config.json");
}

/**
 * Authenticated accounts start without provider or integration credentials.
 * Legacy/local config is deliberately not copied: doing so would silently share
 * the deployment owner's paid API keys and external channel accounts.
 */
export function createEmptyTenantConfig(): InnoConfig {
	return normalizeConfig({
		defaultProvider: "",
		defaultModel: "",
		providers: {},
	}, TENANT_CONFIG_OPTIONS);
}

export function loadTenantConfig(dataDir: string, tenantId: string): InnoConfig {
	const path = tenantConfigPath(dataDir, tenantId);
	if (!existsSync(path)) return createEmptyTenantConfig();
	return loadConfig(path, TENANT_CONFIG_OPTIONS);
}

export function saveTenantConfig(dataDir: string, tenantId: string, config: InnoConfig): InnoConfig {
	return saveConfig(tenantConfigPath(dataDir, tenantId), config, TENANT_CONFIG_OPTIONS);
}

const TENANT_CHANNEL_NAMES = ["feishu", "qq", "wechat", "wecom"] as const;

/**
 * Effective config = server-managed fields from the deployment config plus
 * user selections from the tenant config. Providers, search keys, channel
 * endpoints/mode and the bridge token are operator-owned; the tenant record
 * only carries default model, channel enable/whitelist toggles, personal
 * QR-bound credentials (feishu app), memory/smart-input/ui and scheduler.
 */
export function mergeTenantConfig(localConfig: InnoConfig, tenantConfig: InnoConfig): InnoConfig {
	const channels: NonNullable<InnoConfig["channels"]> = {};
	for (const name of TENANT_CHANNEL_NAMES) {
		const global = localConfig.channels?.[name] as Record<string, unknown> | undefined;
		const tenant = tenantConfig.channels?.[name] as Record<string, unknown> | undefined;
		if (!global && !tenant) continue;
		(channels as Record<string, unknown>)[name] = {
			...(global ?? {}),
			...(tenant ? {
				enabled: Boolean(tenant.enabled),
				...(tenant.personalOnly !== undefined ? { personalOnly: tenant.personalOnly } : {}),
				...(tenant.allowedUserIds !== undefined ? { allowedUserIds: tenant.allowedUserIds } : {}),
			} : {}),
		};
	}
	return {
		...localConfig,
		defaultProvider: tenantConfig.defaultProvider || localConfig.defaultProvider,
		defaultModel: tenantConfig.defaultModel || localConfig.defaultModel,
		providers: localConfig.providers,
		feishu: tenantConfig.feishu ?? localConfig.feishu,
		channels,
		memory: tenantConfig.memory ?? localConfig.memory,
		smartInput: tenantConfig.smartInput ?? localConfig.smartInput,
		ui: tenantConfig.ui ?? localConfig.ui,
		scheduler: tenantConfig.scheduler ?? localConfig.scheduler,
	};
}

/** Resolve configuration at execution time, inside the verified ALS tenant scope. */
export function resolveCurrentTenantConfig(dataDir: string, localConfig: InnoConfig): InnoConfig {
	const tenant = getCurrentTenant();
	return tenant ? mergeTenantConfig(localConfig, loadTenantConfig(dataDir, tenant.tenantId)) : localConfig;
}

/** Effective config for a specific tenant id (channel manager, webhook routing). */
export function resolveTenantConfig(dataDir: string, tenantId: string, localConfig: InnoConfig): InnoConfig {
	return mergeTenantConfig(localConfig, loadTenantConfig(dataDir, tenantId));
}

function tenantConfigSyncPath(dataDir: string, tenantId: string): string {
	return join(tenantConfigDir(dataDir, tenantId), "config.json.pg-sync");
}

/**
 * Materialise the authoritative PostgreSQL tenant config into the local file
 * when it is missing or the PG row moved past the recorded `updated_at` marker.
 * The local file stays the synchronous read path for every config consumer;
 * this runs once per authenticated request before routing/dispatch.
 */
export async function syncTenantConfigFromStore(
	store: TenantStore,
	dataDir: string,
	tenantId: string,
): Promise<void> {
	const record = await store.loadTenantConfigRecord(tenantId);
	if (!record) return;
	const path = tenantConfigPath(dataDir, tenantId);
	const marker = tenantConfigSyncPath(dataDir, tenantId);
	if (existsSync(path) && existsSync(marker)
		&& (await readFile(marker, "utf8")) === record.updatedAt) {
		return;
	}
	// Marker written after the config: a torn sync is retried on the next request.
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, record.config);
	await writeFile(marker, record.updatedAt);
}

/**
 * Tenant settings write path: updates the local file and the authoritative PG
 * row, then records the new sync marker. Pass the tenant store only inside a
 * verified tenant scope (or null to keep file-only local behaviour).
 */
export async function persistTenantConfig(
	store: TenantStore | null,
	dataDir: string,
	tenantId: string,
	config: InnoConfig,
): Promise<InnoConfig> {
	const saved = saveTenantConfig(dataDir, tenantId, config);
	if (store) {
		const updatedAt = await store.saveTenantConfigRecord(tenantId, JSON.stringify(saved));
		await writeFile(tenantConfigSyncPath(dataDir, tenantId), updatedAt);
	}
	return saved;
}
