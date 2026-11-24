import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import {
	normalizeSmartInputConfig,
	normalizeUiConfig,
	setDefaultModel,
	type InnoConfig,
	type InnoModelConfig,
	type InnoSmartInputConfig,
} from "../../config.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { requireRequestTenant } from "../../tenants/http.js";
import { getCurrentTenantStore } from "../../tenants/current.js";
import {
	loadTenantConfig,
	mergeTenantConfig,
	persistTenantConfig,
} from "../../tenants/config.js";
import { json, readBody } from "../http-helpers.js";

/**
 * Server state the settings routes touch. `config` is reassigned on every
 * write endpoint, so it flows through getter/setter; the three callbacks are
 * owned by server.ts (they serve other route domains too).
 */
export interface SettingsRouteContext {
	paths: RuntimePaths;
	getConfig: () => InnoConfig;
	setConfig: (config: InnoConfig) => void;
	reloadFeishuChannel: () => Promise<void>;
	syncChannelOwnership?: (previous: InnoConfig, next: InnoConfig) => Promise<void>;
	scheduleSkillsReload: () => void;
	invalidateContentSource: () => void;
	/** Drop the cached sandbox manager so the next session open reads the new settings. */
	invalidateSandbox?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (only used by this route domain).
// ---------------------------------------------------------------------------

function maskSecret(value: string | undefined): string {
	return value ? `****${value.slice(-4)}` : "";
}

function providerModelToRuntimeModel(model: InnoModelConfig, provider: string, baseUrl: string) {
	return {
		id: model.id,
		name: model.name,
		provider,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl,
	};
}

function buildSafeSettings(config: InnoConfig) {
	// Durable sessions pin their own model, so the settings view is derived only
	// from the persisted config; there is no process-wide "current model".
	const configuredModels = Object.entries(config.providers).flatMap(([providerId, providerConfig]) =>
		providerConfig.models.map((model) => providerModelToRuntimeModel(model, providerId, providerConfig.baseUrl)),
	);
	const availableModels = configuredModels;

	return {
		...config,
		defaultProvider: config.defaultProvider,
		defaultModel: config.defaultModel,
		configuredModels,
		availableModels,
		providers: Object.fromEntries(
			Object.entries(config.providers).map(([providerId, providerConfig]) => [
				providerId,
				{
					...providerConfig,
					apiKey: maskSecret(providerConfig.apiKey),
					headers: providerConfig.headers
						? Object.fromEntries(Object.entries(providerConfig.headers).map(([key, value]) => [key, maskSecret(value)]))
						: undefined,
				},
			]),
		),
		feishu: config.feishu
			? { ...config.feishu, appSecret: config.feishu.appSecret ? "****" : "" }
			: undefined,
		bridge: config.bridge
			? { token: maskSecret(config.bridge.token) }
			: undefined,
		github: config.github
			? { token: maskSecret(config.github.token) }
			: undefined,
		tavily: config.tavily
			? { apiKey: maskSecret(config.tavily.apiKey) }
			: undefined,
		// The spread above would otherwise carry the sandbox API key through unmasked.
		sandbox: config.sandbox
			? { ...config.sandbox, apiKey: maskSecret(config.sandbox.apiKey) }
			: undefined,
		contentHub: config.contentHub
			? { ...config.contentHub, token: maskSecret(config.contentHub.token) }
			: undefined,
	};
}



/**
 * /api/settings* and /api/mcp* route domain. Returns true when the request
 * was handled. Extracted verbatim from server.ts during the P2 route split —
 * behavior unchanged.
 */
export async function handleSettingsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SettingsRouteContext,
): Promise<boolean> {
	const { paths } = ctx;
	const tenant = requireRequestTenant(req);
	// Per-request view of the tenant's config. Tenant files start empty and
	// never inherit deployment-owner credentials from a global file.
	let config = loadTenantConfig(paths.dataDir, tenant.tenantId);
	const tenantStore = getCurrentTenantStore();
	const save = async (next: InnoConfig): Promise<void> => {
		config = await persistTenantConfig(tenantStore, paths.dataDir, tenant.tenantId, next);
	};
	// Durable runtimes read the config when a session is opened, so there is no
	// live process-wide registry to synchronise after a settings change.
	const sync = (): void => {};
	// The read surface shows the effective config: server-managed providers,
	// search and channel endpoints from the deployment config merged with this
	// tenant's selections. Writes below still persist the tenant record only.
	const effective = () => mergeTenantConfig(ctx.getConfig(), config);
	const safeSettings = () => {
		const view = buildSafeSettings(effective());
		// The sandbox is platform-level: a tenant neither sees nor edits it.
		// Providers, web-search and channel credentials are server-managed in
		// this deployment; tenants only pick a default model and flip
		// channel/memory toggles, so the payload tells the UI to hide those
		// edit affordances.
		return { ...view, sandbox: undefined, sandboxEditable: false,
			serverManaged: { providers: true, tavily: true, channelCredentials: true } };
	};
	const rejectSharedRuntime = (feature: string): true => {
		json(res, 409, { error: `${feature} is unavailable until its runtime is tenant-scoped` });
		return true;
	};

	if (method === "GET" && url === "/api/settings") {
		json(res, 200, safeSettings());
		return true;
	}

	if (method === "POST" && url === "/api/settings/model") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const provider = typeof body.provider === "string" ? body.provider.trim() : "";
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (!provider || !model) {
			json(res, 400, { error: "Missing provider or model" });
			return true;
		}

		setDefaultModel(effective(), provider, model);
		config.defaultProvider = provider;
		config.defaultModel = model;
		await save(config);
		json(res, 200, { defaultProvider: provider, defaultModel: model });
		return true;
	}

	if (method === "PUT" && url === "/api/settings/channels") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const previous = structuredClone(config);
		// Channel credentials (feishu appId/appSecret, bridge token, sidecar
		// endpoints, mode) are server-managed — reject them outright so a
		// stale client cannot silently shadow the operator config.
		if (body.feishu !== undefined || body.bridge !== undefined) {
			json(res, 403, { error: "Channel credentials are managed by the server operator" });
			return true;
		}
		try {
			// Update channels config
			if (body.channels && typeof body.channels === "object") {
				const channels = body.channels as Record<string, unknown>;
				config.channels = config.channels ?? {};
				for (const name of ["feishu", "qq", "wechat"] as const) {
					const ch = channels[name];
					if (ch && typeof ch === "object") {
						const chObj = ch as Record<string, unknown>;
						(config.channels as Record<string, unknown>)[name] = {
							...((config.channels as Record<string, unknown>)?.[name] as object ?? {}),
							enabled: typeof chObj.enabled === "boolean" ? chObj.enabled : false,
							...(typeof chObj.personalOnly === "boolean" ? { personalOnly: chObj.personalOnly } : {}),
							...(Array.isArray(chObj.allowedUserIds) ? { allowedUserIds: chObj.allowedUserIds.filter((v: unknown) => typeof v === "string") } : {}),
						};
						if (chObj.mode !== undefined || chObj.sidecarBaseUrl !== undefined) {
							throw new Error("Channel endpoints are managed by the server operator");
						}
					}
				}
			}
			if (tenant && ctx.syncChannelOwnership) await ctx.syncChannelOwnership(previous, config);
			try {
				await save(config);
			} catch (error) {
				if (tenant && ctx.syncChannelOwnership) {
					try { await ctx.syncChannelOwnership(config, previous); }
					catch (rollbackError) { logger.error({ err: rollbackError }, "failed to roll back channel ownership after settings save failure"); }
				}
				throw error;
			}
		} catch (err) {
			logger.warn({ err }, "failed to update channel settings");
			const statusCode = err && typeof err === "object" && "statusCode" in err
				? Number((err as { statusCode?: unknown }).statusCode) || 400
				: 400;
			json(res, statusCode, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}

		// Hot-reload Feishu channel: stop old instance, create new one if configured.
		try {
			await ctx.reloadFeishuChannel();
		} catch (err) {
			logger.warn({ err }, "feishu channel hot-reload failed");
		}

		json(res, 200, safeSettings());
		return true;
	}

	// --- Memory Settings (L3 cross-conversation recall toggle) ---
	if (method === "PUT" && url === "/api/settings/memory") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const keys = ["l2Enabled", "l3Enabled"] as const;
		if (keys.every((k) => typeof body[k] !== "boolean")) {
			json(res, 400, { error: "Provide at least one of l2Enabled / l3Enabled (boolean)" });
			return true;
		}
		for (const k of keys) {
			if (body[k] !== undefined && typeof body[k] !== "boolean") {
				json(res, 400, { error: `${k} must be a boolean` });
				return true;
			}
		}
		// Merge over current values so a partial payload leaves the other
		// layers untouched. normalizeMemoryConfig backfills defaults.
		const current = config.memory ?? { l2Enabled: true, l3Enabled: true };
		config.memory = {
			l2Enabled: typeof body.l2Enabled === "boolean" ? body.l2Enabled : current.l2Enabled,
			l3Enabled: typeof body.l3Enabled === "boolean" ? body.l3Enabled : current.l3Enabled,
		};
		await save(config);
		sync();
		json(res, 200, safeSettings());
		return true;
	}

	if (method === "PUT" && url === "/api/settings/smart-input") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const next = normalizeSmartInputConfig(body as Partial<InnoSmartInputConfig>);
		config.smartInput = next;
		await save(config);
		sync();
		json(res, 200, safeSettings());
		return true;
	}

	if (method === "PUT" && url === "/api/settings/github") {
		return rejectSharedRuntime("Content Hub credentials");
	}


	// --- Sandbox settings (platform-level): tenants neither see nor edit them. ---
	if (method === "PUT" && url === "/api/settings/sandbox") {
		json(res, 403, { error: "Sandbox settings are managed by the server operator" });
		return true;
	}

	// --- Content Hub settings (source for skill library + presets) ---
	if (method === "PUT" && url === "/api/settings/content-hub") {
		return rejectSharedRuntime("Content Hub settings");
	}

	// PUT /api/settings/theme — persist UI theme preference
	if (method === "PUT" && url === "/api/settings/theme") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const theme = typeof body.theme === "string" ? body.theme.trim() : "";
		// Legacy values (warm/ocean/innospark) stay accepted so older clients do
		// not break; the web UI normalizes them to "light" on read.
		const ALLOWED_THEMES = ["light", "dark", "warm", "ocean", "innospark"];
		if (!ALLOWED_THEMES.includes(theme)) {
			json(res, 400, { error: `Invalid theme. Allowed: ${ALLOWED_THEMES.join(", ")}` });
			return true;
		}
		config.ui = { ...normalizeUiConfig(config.ui), theme };
		await save(config);
		json(res, 200, safeSettings());
		return true;
	}

	// PUT /api/settings/markdown — persist user-facing Markdown parsing preferences
	if (method === "PUT" && url === "/api/settings/markdown") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.mathSingleDollar !== "boolean") {
			json(res, 400, { error: "mathSingleDollar must be a boolean" });
			return true;
		}
		config.ui = {
			...normalizeUiConfig(config.ui),
			mathSingleDollar: body.mathSingleDollar,
		};
		await save(config);
		json(res, 200, safeSettings());
		return true;
	}

	return false;
}
