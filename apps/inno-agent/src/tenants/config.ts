import { normalizeConfig, type InnoConfig } from "../config.js";
import { getCurrentTenant, getCurrentTenantStore } from "./current.js";
import type { TenantStore } from "./store.js";

const TENANT_CONFIG_OPTIONS = { allowEmptyProviders: true } as const;

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

/**
 * Tenant config is a single indexed PostgreSQL row (`tenant_configs`) — the
 * read is cheap enough to serve every consumer directly, so there is no local
 * file or cache copy; PostgreSQL is the only source of truth.
 */
export async function loadTenantConfig(
	store: TenantStore | null,
	tenantId: string,
): Promise<InnoConfig> {
	const record = await store?.loadTenantConfigRecord?.(tenantId);
	if (!record) return createEmptyTenantConfig();
	return normalizeConfig(JSON.parse(record.config) as Record<string, unknown>, TENANT_CONFIG_OPTIONS);
}

/** Persist a tenant's selections to the authoritative PG row. */
export async function persistTenantConfig(
	store: TenantStore | null,
	tenantId: string,
	config: InnoConfig,
): Promise<InnoConfig> {
	const normalized = normalizeConfig(config, TENANT_CONFIG_OPTIONS);
	if (store) await store.saveTenantConfigRecord(tenantId, JSON.stringify(normalized));
	return normalized;
}

/** Resolve configuration at execution time, inside the verified ALS tenant scope. */
export async function resolveCurrentTenantConfig(localConfig: InnoConfig): Promise<InnoConfig> {
	const tenant = getCurrentTenant();
	return tenant
		? mergeTenantConfig(localConfig, await loadTenantConfig(getCurrentTenantStore(), tenant.tenantId))
		: localConfig;
}

/** Effective config for a specific tenant id (channel manager, webhook routing). */
export async function resolveTenantConfig(
	tenantId: string,
	localConfig: InnoConfig,
	store: TenantStore | null,
): Promise<InnoConfig> {
	return mergeTenantConfig(localConfig, await loadTenantConfig(store, tenantId));
}
