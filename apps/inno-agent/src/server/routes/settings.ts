import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { probeProviderModels } from "../../agent/model-probe.js";
import {
	deleteModel,
	deleteProvider,
	normalizeContentHubConfig,
	normalizeSmartInputConfig,
	normalizeUiConfig,
	saveConfig,
	setDefaultModel,
	upsertProvider,
	normalizeSandboxConfig,
	type InnoConfig,
	type InnoModelConfig,
	type InnoProviderConfig,
	type InnoSmartInputConfig,
} from "../../config.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { applyProviderProxyBypass } from "../../utils/proxy-bypass.js";
import { getRequestTenant } from "../../tenants/http.js";
import {
	loadTenantConfig,
	saveTenantConfig,
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
		ocrApi: config.ocrApi
			? {
				token: maskSecret(config.ocrApi.token),
				model: config.ocrApi.model,
				baseUrl: config.ocrApi.baseUrl,
			}
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

function parseModelConfig(value: unknown): InnoModelConfig {
	if (!value || typeof value !== "object") throw new Error("Invalid model");
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) throw new Error("Model id is required");
	return {
		id,
		name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
		reasoning: Boolean(record.reasoning),
		input: ("input" in record)
			? (Array.isArray(record.input) && record.input.includes("image") ? ["text", "image"] : ["text"])
			: ["text", "image"],
		contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : Number(record.contextWindow ?? 128000),
		maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : Number(record.maxTokens ?? 8192),
	};
}

function parseStringHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		const normalizedKey = key.trim();
		if (normalizedKey && typeof headerValue === "string") {
			headers[normalizedKey] = headerValue;
		}
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseProviderPayload(body: Record<string, unknown>): {
	providerId: string;
	provider: InnoProviderConfig;
	makeDefault: boolean;
	preserveApiKey: boolean;
	preserveHeaders: boolean;
} {
	const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
		throw new Error("Provider id must use letters, numbers, dot, underscore, or dash");
	}
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
	const api = typeof body.api === "string" ? body.api.trim() : "openai-completions";
	const headers = parseStringHeaders(body.headers);
	const rawModels = Array.isArray(body.models) ? body.models : [];
	const models = rawModels.map(parseModelConfig);
	return {
		providerId,
		provider: {
			baseUrl,
			apiKey,
			api,
			...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
			...(body.authHeader === true ? { authHeader: true } : {}),
			...(body.bypassProxy === true ? { bypassProxy: true } : {}),
			models,
		},
		makeDefault: Boolean(body.makeDefault),
		preserveApiKey: Boolean(body.preserveApiKey),
		preserveHeaders: !Object.prototype.hasOwnProperty.call(body, "headers"),
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
	const tenant = getRequestTenant(req);
	const tenantScoped = tenant !== null;
	// Per-request view of local or tenant config. Tenant files start empty and
	// never inherit deployment-owner credentials from the legacy global file.
	let config = tenant ? loadTenantConfig(paths.dataDir, tenant.tenantId) : ctx.getConfig();
	const save = (next: InnoConfig): void => {
		config = tenant
			? saveTenantConfig(paths.dataDir, tenant.tenantId, next)
			: saveConfig(paths.configPath, next);
		if (!tenant) ctx.setConfig(config);
	};
	// Durable runtimes read the config when a session is opened, so there is no
	// live process-wide registry to synchronise after a settings change.
	const sync = (): void => {};
	const refreshProviders = async (): Promise<void> => {};
	const safeSettings = () => {
		const view = buildSafeSettings(config);
		// The sandbox is platform-level: a tenant neither sees nor edits it.
		if (tenantScoped) return { ...view, sandbox: undefined, sandboxEditable: false };
		return { ...view, sandboxEditable: true, sandboxEnvKey: Boolean(process.env.E2B_API_KEY?.trim()) };
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

		save(setDefaultModel(config, provider, model));
		json(res, 200, { defaultProvider: provider, defaultModel: model });
		return true;
	}

	if ((method === "PUT" || method === "POST" || method === "PATCH") && url === "/api/settings/providers") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const payload = parseProviderPayload(body);
		if (tenantScoped && payload.provider.bypassProxy) {
			json(res, 400, { error: "bypassProxy is process-global and unavailable for tenant providers" });
			return true;
		}
		save(upsertProvider(config, payload.providerId, payload.provider, {
			makeDefault: payload.makeDefault,
			preserveApiKey: payload.preserveApiKey,
			preserveHeaders: payload.preserveHeaders,
		}));
		if (!tenantScoped) applyProviderProxyBypass(config);
		await refreshProviders();
		if (payload.makeDefault) {
			save(setDefaultModel(config, config.defaultProvider, config.defaultModel));
		}
		json(res, 200, safeSettings());
		return true;
	}

	// Probe a provider's model list server-side (the browser can't call
	// provider APIs directly due to CORS + API key exposure). If apiKey is
	// omitted, fall back to the stored key of an existing provider.
	if (method === "POST" && url === "/api/settings/providers/probe-models") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		const api = typeof body.api === "string" ? body.api : undefined;
		let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
		if ((!apiKey || apiKey.startsWith("****")) && providerId) {
			apiKey = config.providers?.[providerId]?.apiKey ?? "";
		}
		try {
			const result = await probeProviderModels({ baseUrl, apiKey, api });
			json(res, 200, result);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	// Delete a single model from a provider. Must be matched before the
	// provider-delete route below (which uses startsWith on the same prefix).
	if (method === "DELETE" && /^\/api\/settings\/providers\/[^/]+\/models\/[^/]+$/.test(url)) {
		const rest = url.slice("/api/settings/providers/".length);
		const [providerPart, modelPart] = rest.split("/models/");
		const providerId = decodeURIComponent(providerPart);
		const modelId = decodeURIComponent(modelPart);
		if (!providerId || !modelId) {
			json(res, 400, { error: "Missing provider or model id" });
			return true;
		}
		try {
			save(deleteModel(config, providerId, modelId));
			await refreshProviders();
		} catch (err) {
			logger.error({ err, providerId, modelId }, "failed to delete model");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		json(res, 200, safeSettings());
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/settings/providers/")) {
		const providerId = decodeURIComponent(url.slice("/api/settings/providers/".length));
		if (!providerId) {
			json(res, 400, { error: "Missing provider id" });
			return true;
		}
		try {
			save(deleteProvider(config, providerId));
			await refreshProviders();
		} catch (err) {
			logger.error({ err }, "failed to update channel settings");
			json(res, 400, { error: err instanceof Error ? err.message : String(err) });
			return true;
		}
		json(res, 200, safeSettings());
		return true;
	}

	// --- Channels Settings ---
	if (method === "PUT" && url === "/api/settings/channels") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const previous = structuredClone(config);
		try {
			// Update feishu config
			if (body.feishu && typeof body.feishu === "object") {
				const feishuBody = body.feishu as Record<string, unknown>;
				const appId = typeof feishuBody.appId === "string" ? feishuBody.appId.trim() : "";
				const appSecret = typeof feishuBody.appSecret === "string" ? feishuBody.appSecret.trim() : "";
				if (appId) {
					config.feishu = {
						appId,
						appSecret: (appSecret.startsWith("****") ? "" : appSecret) || config.feishu?.appSecret || "",
					};
				}
			}
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
							...(typeof chObj.mode === "string" ? { mode: chObj.mode } : {}),
							...(typeof chObj.sidecarBaseUrl === "string" ? { sidecarBaseUrl: chObj.sidecarBaseUrl.trim() } : {}),
						};
					}
				}
			}
			// Update bridge config
			if (body.bridge && typeof body.bridge === "object") {
				const bridgeBody = body.bridge as Record<string, unknown>;
				const token = typeof bridgeBody.token === "string" ? bridgeBody.token.trim() : "";
				if (token && !token.startsWith("****")) {
					config.bridge = { token };
				} else if (!config.bridge && token) {
					// preserve existing
				}
			}
			if (tenant && ctx.syncChannelOwnership) await ctx.syncChannelOwnership(previous, config);
			try {
				save(config);
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
		const keys = ["l1Enabled", "l2Enabled", "l3Enabled"] as const;
		if (keys.every((k) => typeof body[k] !== "boolean")) {
			json(res, 400, { error: "Provide at least one of l1Enabled / l2Enabled / l3Enabled (boolean)" });
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
		const current = config.memory ?? { l1Enabled: true, l2Enabled: true, l3Enabled: true };
		config.memory = {
			l1Enabled: typeof body.l1Enabled === "boolean" ? body.l1Enabled : current.l1Enabled,
			l2Enabled: typeof body.l2Enabled === "boolean" ? body.l2Enabled : current.l2Enabled,
			l3Enabled: typeof body.l3Enabled === "boolean" ? body.l3Enabled : current.l3Enabled,
		};
		save(config);
		sync();
		json(res, 200, safeSettings());
		return true;
	}

	if (method === "PUT" && url === "/api/settings/smart-input") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const next = normalizeSmartInputConfig(body as Partial<InnoSmartInputConfig>);
		config.smartInput = next;
		save(config);
		sync();
		json(res, 200, safeSettings());
		return true;
	}

	if (method === "PUT" && url === "/api/settings/github") {
		if (tenantScoped) return rejectSharedRuntime("Content Hub credentials");
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.token !== "string") {
			json(res, 400, { error: "Missing token (string)" });
			return true;
		}
		const incoming = body.token.trim();
		// A masked value (e.g. "****abcd") means "keep the existing token".
		const token = incoming.startsWith("****") ? (config.github?.token ?? "") : incoming;
		config.github = token ? { token } : undefined;
		save(config);
		sync();
		// Rebuild the content source so the new auth (and higher limit) applies.
		ctx.invalidateContentSource();
		json(res, 200, safeSettings());
		return true;
	}

	// --- OCR API settings (Baidu PaddleOCR-VL token / model / baseUrl) ---
	if (method === "PUT" && url === "/api/settings/ocr") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.token !== "string") {
			json(res, 400, { error: "Missing token (string)" });
			return true;
		}
		const incoming = body.token.trim();
		// A masked value (e.g. "****abcd") means "keep the existing token".
		const token = incoming.startsWith("****") ? (config.ocrApi?.token ?? "") : incoming;
		const model = typeof body.model === "string" ? body.model.trim() : config.ocrApi?.model;
		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : config.ocrApi?.baseUrl;
		if (!token) {
			config.ocrApi = undefined;
		} else {
			config.ocrApi = {
				token,
				model: model || undefined,
				baseUrl: baseUrl || undefined,
			};
		}
		save(config);
		sync();
		json(res, 200, safeSettings());
		return true;
	}

	// --- Sandbox settings (platform-level; local mode only) ---
	if (method === "PUT" && url === "/api/settings/sandbox") {
		if (tenantScoped) {
			json(res, 403, { error: "Sandbox settings are managed by the server operator" });
			return true;
		}
		const body = (await readBody(req)) as Record<string, unknown>;
		const current = config.sandbox ?? {};
		const bad = (message: string): true => { json(res, 400, { error: message }); return true; };
		const next: NonNullable<InnoConfig["sandbox"]> = { ...current };
		if ("enabled" in body) { if (typeof body.enabled !== "boolean") return bad("enabled must be a boolean"); next.enabled = body.enabled; }
		if ("apiKey" in body) {
			if (typeof body.apiKey !== "string") return bad("apiKey must be a string");
			const incoming = body.apiKey.trim();
			// A masked value (e.g. "****abcd") means "keep the existing key".
			if (!incoming.startsWith("****")) next.apiKey = incoming || undefined;
		}
		for (const key of ["domain", "template"] as const) {
			if (key in body) {
				if (typeof body[key] !== "string") return bad(`${key} must be a string`);
				const value = (body[key] as string).trim();
				next[key] = value || undefined;
			}
		}
		for (const key of ["timeoutMinutes", "commandTimeoutSeconds"] as const) {
			if (key in body) {
				const value = body[key];
				if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return bad(`${key} must be a positive number`);
				next[key] = value;
			}
		}
		if ("allowInternetAccess" in body) { if (typeof body.allowInternetAccess !== "boolean") return bad("allowInternetAccess must be a boolean"); next.allowInternetAccess = body.allowInternetAccess; }
		if ("requireApproval" in body) { if (body.requireApproval !== "always" && body.requireApproval !== "never") return bad("requireApproval must be 'always' or 'never'"); next.requireApproval = body.requireApproval; }
		if ("allowedDomains" in body) {
			if (!Array.isArray(body.allowedDomains) || body.allowedDomains.some((entry) => typeof entry !== "string")) return bad("allowedDomains must be an array of strings");
			next.allowedDomains = body.allowedDomains as string[];
		}
		if ("limits" in body) {
			const limits = body.limits as Record<string, unknown> | null;
			if (!limits || typeof limits !== "object") return bad("limits must be an object");
			const merged = { ...(current.limits ?? {}) } as Record<string, number>;
			for (const key of ["maxConcurrent", "maxSandboxes", "maxActiveMinutesPerDay"]) {
				if (key in limits) {
					const value = limits[key];
					if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return bad(`limits.${key} must be a number >= 0`);
					merged[key] = Math.floor(value);
				}
			}
			next.limits = merged;
		}
		if (normalizeSandboxConfig(next).enabled && !normalizeSandboxConfig(next).apiKey) {
			return bad("Enabling the sandbox needs an API key (here or in the E2B_API_KEY environment variable)");
		}
		config.sandbox = next;
		save(config);
		ctx.invalidateSandbox?.();
		json(res, 200, safeSettings());
		return true;
	}

	// --- Tavily settings (web_search tool API key) ---
	if (method === "PUT" && url === "/api/settings/tavily") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.apiKey !== "string") {
			json(res, 400, { error: "Missing apiKey (string)" });
			return true;
		}
		const incoming = body.apiKey.trim();
		// A masked value (e.g. "****abcd") means "keep the existing key".
		const apiKey = incoming.startsWith("****") ? (config.tavily?.apiKey ?? "") : incoming;
		if (!apiKey) {
			config.tavily = undefined;
		} else {
			config.tavily = { apiKey };
		}
		save(config);
		sync();
		json(res, 200, safeSettings());
		return true;
	}

	// --- Content Hub settings (source for skill library + presets) ---
	if (method === "PUT" && url === "/api/settings/content-hub") {
		if (tenantScoped) return rejectSharedRuntime("Content Hub settings");
		const body = (await readBody(req)) as Record<string, unknown>;
		const current = config.contentHub ?? normalizeContentHubConfig(undefined, config.github?.token);
		const str = (key: string, fallback: string): string =>
			typeof body[key] === "string" ? (body[key] as string).trim() : fallback;
		// A masked token (e.g. "****abcd") means "keep the existing token".
		const incomingToken = typeof body.token === "string" ? body.token.trim() : "";
		const token = incomingToken.startsWith("****") ? current.token : incomingToken;
		config.contentHub = normalizeContentHubConfig({
			type: body.type === "bundle" ? "bundle" : "github",
			owner: str("owner", current.owner),
			repo: str("repo", current.repo),
			ref: str("ref", current.ref),
			skillsPath: str("skillsPath", current.skillsPath),
			presetsPath: str("presetsPath", current.presetsPath),
			baseUrl: str("baseUrl", current.baseUrl),
			token,
		});
		save(config);
		sync();
		// Rebuild the content source so the new hub takes effect immediately.
		ctx.invalidateContentSource();
		json(res, 200, safeSettings());
		return true;
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
		save(config);
		json(res, 200, safeSettings());
		return true;
	}

	// PUT /api/settings/close-behavior — persist the cross-platform window-close preference
	if (method === "PUT" && url === "/api/settings/close-behavior") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const closeBehavior = body.closeBehavior;
		if (closeBehavior !== "ask" && closeBehavior !== "hide" && closeBehavior !== "quit") {
			json(res, 400, { error: "closeBehavior must be one of ask, hide, quit" });
			return true;
		}
		config.ui = {
			...normalizeUiConfig(config.ui),
			closeBehavior,
		};
		save(config);
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
		save(config);
		json(res, 200, safeSettings());
		return true;
	}

	return false;
}
