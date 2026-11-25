import { timingSafeEqual } from "node:crypto";
import type { InnoConfig } from "../config.js";
import { logger } from "../logger.js";
import { resolveTenantConfig } from "../tenants/config.js";
import { getCurrentTenant, getCurrentTenantStore, runInTenantContext } from "../tenants/current.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { feishuRegistrationBegin, feishuRegistrationPoll } from "./feishu/feishu-registration.js";
import { ChannelRegistry, type ChatChannel } from "./channel.js";
import { PersonalChannelDispatcher, type ChatSessionMap, type PersonalChannelDispatcherOptions } from "./personal-dispatcher.js";
import { TenantJsonLedger, TenantStateStore, type TenantStateKv } from "../tenants/state-store.js";
import { DedupeStore, type DedupeEntry } from "./dedupe-store.js";
import { ChannelRunLog, type ChannelRun } from "./run-log.js";
import type { IncomingMessage, PushTarget } from "./types.js";
import type { WeChatChannel } from "./wechat/wechat-channel.js";
import type { TokenData, WechatTokenPersistence } from "./wechat/ilink-client.js";

export interface TenantChannelRegistration {
	wechatChannel?: WeChatChannel;
	stop?: () => Promise<void> | void;
}

export interface TenantChannelFactoryOptions {
	config: InnoConfig;
	registry: ChannelRegistry;
	dispatch: (channel: ChatChannel, message: IncomingMessage) => void;
	/** PostgreSQL-backed persistence for the WeChat iLink token. */
	wechatTokenPersistence?: WechatTokenPersistence;
}

interface TenantChannelRuntime {
	context: TenantContext;
	registry: ChannelRegistry;
	dispatcher: PersonalChannelDispatcher;
	wechatChannel: WeChatChannel | null;
	hydrated: Promise<void>;
	stop?: () => Promise<void> | void;
}

export interface TenantChannelManagerOptions {
	tenantStore: TenantStore;
	/** Deployment config: providers, shared bridge token and channel endpoints. */
	getLocalConfig: () => InnoConfig;
	dispatcher: Omit<PersonalChannelDispatcherOptions, "channelRegistry" | "channelsDataDir">;
	createChannels: (options: TenantChannelFactoryOptions) => TenantChannelRegistration;
	/** Test seam: override the tenant_state KV (defaults to PostgreSQL). */
	createStateStore?: (tenant: { context: TenantContext; store: TenantStore }) => TenantStateKv;
}

export function channelUserResourceId(channel: string, userId: string): string {
	return `channel-user:${channel}:${userId}`;
}

export function channelChatResourceId(channel: string, chatId: string): string {
	return `channel-chat:${channel}:${chatId}`;
}

export function feishuChannelResourceId(appId: string): string {
	return `feishu:${appId}`;
}

export function wechatChannelResourceId(botId: string): string {
	return `wechat:${botId}`;
}

// Ownership claims derive from the tenant record only: the personal Feishu
// app bound via QR registration and the external user ids whitelisted on
// shared (bridge-mode) channels. The server-managed bridge token itself is
// not claimable — inbound routing resolves by channel-user/channel-chat.
function configuredChannelResourceIds(config: InnoConfig, localConfig: InnoConfig): Set<string> {
	const ids = new Set<string>();
	if (config.feishu?.appId) ids.add(feishuChannelResourceId(config.feishu.appId));
	for (const name of ["qq", "wechat"] as const) {
		const endpoint = localConfig.channels?.[name] as { mode?: string } | undefined;
		if (endpoint?.mode !== "bridge") continue;
		for (const userId of config.channels?.[name]?.allowedUserIds ?? []) {
			ids.add(channelUserResourceId(name, userId));
		}
	}
	return ids;
}

/**
 * Authenticated channel facade. Every operation resolves the verified ALS
 * tenant at execution time; no legacy/global registry is available as a fallback.
 */
export class TenantChannelManager extends ChannelRegistry {
	private readonly runtimes = new Map<string, TenantChannelRuntime>();
	private readonly feishuDevices = new Map<string, { tenantId: string; expiresAt: number }>();
	private readonly wechatQrs = new Map<string, { tenantId: string; expiresAt: number }>();

	constructor(private readonly options: TenantChannelManagerOptions) {
		super();
	}

	override register(channel: ChatChannel): void {
		this.runtime().registry.register(channel);
	}

	override unregister(name: string): void {
		this.runtime().registry.unregister(name);
	}

	override get(name: string): ChatChannel | undefined {
		return this.runtime().registry.get(name);
	}

	override all(): ChatChannel[] {
		return this.runtime().registry.all();
	}

	override async setDefaultTarget(target: Parameters<ChannelRegistry["setDefaultTarget"]>[0]): Promise<void> {
		const runtime = this.runtime();
		await runtime.hydrated;
		const tenant = this.tenant();
		const previous = await runtime.registry.getDefaultTarget(target.channel);
		if (previous?.chatId && previous.chatId !== target.chatId) {
			await tenant.store.releaseResource(tenant.context, "channel",
				channelChatResourceId(target.channel, previous.chatId));
		}
		await tenant.store.claimResource(tenant.context, "channel",
			channelChatResourceId(target.channel, target.chatId));
		await runtime.registry.setDefaultTarget(target);
	}

	override getDefaultTarget(channelName: string): ReturnType<ChannelRegistry["getDefaultTarget"]> {
		return this.runtime().registry.getDefaultTarget(channelName);
	}

	async handle(channel: ChatChannel, message: IncomingMessage): Promise<void> {
		const runtime = this.runtime();
		await runtime.hydrated;
		await runtime.dispatcher.handle(channel, message);
	}

	getRunLog(): ChannelRunLog {
		return this.runtime().dispatcher.getRunLog();
	}

	/** Channels are built asynchronously from the tenant's PostgreSQL config;
	 * await this before sync registry reads (get/all) that must see them. */
	async ready(): Promise<void> {
		await this.runtime().hydrated;
	}

	async getWechatChannel(): Promise<WeChatChannel | null> {
		const runtime = this.runtime();
		await runtime.hydrated;
		return runtime.wechatChannel;
	}

	async setWechatChannel(channel: WeChatChannel): Promise<void> {
		const runtime = this.runtime();
		await runtime.hydrated;
		runtime.wechatChannel = channel;
	}

	/** QR-created channels need the same ALS rebinding as boot-time native channels. */
	async startWechatChannel(channel: WeChatChannel): Promise<void> {
		const runtime = this.runtime();
		await runtime.hydrated;
		if (runtime.wechatChannel !== channel) throw new Error("WeChat channel is not registered for this tenant");
		channel.onMessage((message) => this.dispatch(runtime, channel, message));
		void Promise.resolve(channel.start()).catch((err) => logger.error({ err }, "[wechat] failed to start channel"));
	}

	/** Claim newly configured external identities before their config becomes active. */
	async syncOwnership(previous: InnoConfig, next: InnoConfig): Promise<void> {
		const tenant = this.tenant();
		const localConfig = this.options.getLocalConfig();
		const before = configuredChannelResourceIds(previous, localConfig);
		const after = configuredChannelResourceIds(next, localConfig);
		const added = [...after].filter((id) => !before.has(id));
		const claimed: string[] = [];
		try {
			for (const id of added) {
				await tenant.store.claimResource(tenant.context, "channel", id);
				claimed.push(id);
			}
		} catch (error) {
			await Promise.all(claimed.map((id) => tenant.store.releaseResource(tenant.context, "channel", id)));
			throw error;
		}
		for (const id of before) {
			if (!after.has(id)) await tenant.store.releaseResource(tenant.context, "channel", id);
		}
	}

	async claimWechatBot(botId: string): Promise<void> {
		const tenant = this.tenant();
		if (!botId) throw new Error("WeChat login did not return a bot id");
		await tenant.store.claimResource(tenant.context, "channel", wechatChannelResourceId(botId));
	}

	trackWechatQr(qrId: string): void {
		const tenant = this.tenant();
		if (!qrId) throw new Error("WeChat QR login did not return a qr id");
		this.wechatQrs.set(qrId, { tenantId: tenant.context.tenantId, expiresAt: Date.now() + 15 * 60_000 });
	}

	assertWechatQr(qrId: string): void {
		const tenant = this.tenant();
		const pending = this.wechatQrs.get(qrId);
		if (!pending || pending.tenantId !== tenant.context.tenantId || pending.expiresAt <= Date.now()) {
			const error = new Error("WeChat QR login not found") as Error & { statusCode: number };
			error.statusCode = 404;
			throw error;
		}
	}

	async confirmWechatLogin(qrId: string, botId: string, confirm: () => void): Promise<void> {
		const tenant = this.tenant();
		this.assertWechatQr(qrId);
		const previousBotId = this.runtime().wechatChannel?.botId || "";
		await this.claimWechatBot(botId);
		try {
			confirm();
		} catch (error) {
			if (previousBotId !== botId) {
				await tenant.store.releaseResource(tenant.context, "channel", wechatChannelResourceId(botId));
			}
			throw error;
		}
		if (previousBotId && previousBotId !== botId) {
			await tenant.store.releaseResource(tenant.context, "channel", wechatChannelResourceId(previousBotId));
		}
		this.wechatQrs.delete(qrId);
	}

	/** Constant-time check of the shared, operator-managed bridge token. */
	hasBridgeToken(token: string): boolean {
		const expected = this.options.getLocalConfig().bridge?.token;
		return Boolean(token && expected && token.length === expected.length
			&& timingSafeEqual(Buffer.from(token), Buffer.from(expected)));
	}

	/**
	 * Bridge inbound: the token is server-managed and shared across tenants, so
	 * it only authenticates the sidecar. The owning tenant is resolved from the
	 * claimed external identity — the bound chat, else the whitelisted user.
	 */
	async runWithBridgeMessage<T>(
		token: string,
		msg: { channel?: string; chatId?: string; userId?: string },
		operation: () => T,
	): Promise<T | null> {
		const expected = this.options.getLocalConfig().bridge?.token;
		if (!token || !expected || token.length !== expected.length
			|| !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
		const channel = typeof msg.channel === "string" ? msg.channel : "";
		const candidates = [
			typeof msg.chatId === "string" && msg.chatId ? channelChatResourceId(channel, msg.chatId) : null,
			typeof msg.userId === "string" && msg.userId ? channelUserResourceId(channel, msg.userId) : null,
		];
		for (const id of candidates) {
			if (!id) continue;
			const context = await this.options.tenantStore.findResourceOwner("channel", id);
			if (context) {
				return runInTenantContext(context, this.options.tenantStore, async () => {
					await this.runtime().hydrated;
					return operation();
				});
			}
		}
		return null;
	}

	async beginFeishuRegistration(): ReturnType<typeof feishuRegistrationBegin> {
		const tenant = this.tenant();
		const now = Date.now();
		for (const [code, pending] of this.feishuDevices) {
			if (pending.expiresAt <= now) this.feishuDevices.delete(code);
		}
		const result = await feishuRegistrationBegin();
		this.feishuDevices.set(result.deviceCode, {
			tenantId: tenant.context.tenantId,
			expiresAt: now + result.expiresIn * 1000,
		});
		return result;
	}

	async pollFeishuRegistration(deviceCode: string): ReturnType<typeof feishuRegistrationPoll> {
		const tenant = this.tenant();
		const pending = this.feishuDevices.get(deviceCode);
		if (!pending || pending.tenantId !== tenant.context.tenantId || pending.expiresAt <= Date.now()) {
			const error = new Error("Feishu registration not found") as Error & { statusCode: number };
			error.statusCode = 404;
			throw error;
		}
		const result = await feishuRegistrationPoll(deviceCode);
		if (result.status === "confirmed" || result.status === "expired") this.feishuDevices.delete(deviceCode);
		return result;
	}

	async reloadCurrent(): Promise<void> {
		const tenant = this.tenant();
		const existing = this.runtimes.get(tenant.context.tenantId);
		this.runtimes.delete(tenant.context.tenantId);
		await existing?.hydrated.catch(() => {});
		await existing?.stop?.();
		await this.runtime().hydrated;
	}

	async close(): Promise<void> {
		const runtimes = [...this.runtimes.values()];
		this.runtimes.clear();
		for (const runtime of runtimes) {
			await runtime.hydrated.catch(() => {});
			await runtime.stop?.();
		}
	}

	private tenant(): { context: TenantContext; store: TenantStore } {
		const context = getCurrentTenant();
		const store = getCurrentTenantStore();
		if (!context || !store) throw new Error("Authenticated channel access requires a verified tenant context");
		return { context, store };
	}

	private runtime(): TenantChannelRuntime {
		const tenant = this.tenant();
		const existing = this.runtimes.get(tenant.context.tenantId);
		if (existing) return existing;

		const state = this.options.createStateStore?.(tenant) ?? new TenantStateStore(tenant.store.database);
		const targetsLedger = new TenantJsonLedger<PushTarget[]>(state, "channels.defaultTargets");
		const dedupeLedger = new TenantJsonLedger<DedupeEntry[]>(state, "channels.dedupe");
		const runsLedger = new TenantJsonLedger<ChannelRun[]>(state, "channels.runs");
		const chatSessionsLedger = new TenantJsonLedger<ChatSessionMap>(state, "channels.chatSessions");
		const registry = new ChannelRegistry({
			load: async () => (await targetsLedger.load()) ?? [],
			save: (targets) => targetsLedger.save(targets),
		});
		const dedupeStore = new DedupeStore({ load: async () => (await dedupeLedger.load()) ?? [], save: (entries) => dedupeLedger.save(entries) });
		const runLog = new ChannelRunLog({ load: async () => (await runsLedger.load()) ?? [], save: (runs) => runsLedger.save(runs) });
		const dispatcher = new PersonalChannelDispatcher({
			...this.options.dispatcher,
			onSessionCreated: async (sessionId, channel) => {
				await tenant.store.claimResource(tenant.context, "session", sessionId);
				await this.options.dispatcher.onSessionCreated?.(sessionId, channel);
			},
			authorizeSession: (sessionId) => tenant.store.ownsResource(tenant.context, "session", sessionId),
			allowGlobalSessionFallback: false,
			channelRegistry: registry,
			dedupeStore,
			runLog,
			chatSessionsLedger: { load: () => chatSessionsLedger.load(), save: (map) => chatSessionsLedger.save(map) },
		});
		const dispatch = (channel: ChatChannel, message: IncomingMessage): void => {
			this.dispatch(runtime, channel, message);
		};
		const wechatTokenLedger = new TenantJsonLedger<TokenData>(state, "channels.wechatToken");
		let wechatTokenCache: TokenData | undefined;
		const wechatTokenPersistence: WechatTokenPersistence = {
			read: () => wechatTokenCache,
			write: (data) => {
				wechatTokenCache = data;
				void wechatTokenLedger.save(data).catch((err) => logger.error({ err }, "[wechat] failed to persist token"));
			},
			hydrate: async () => {
				wechatTokenCache = await wechatTokenLedger.load();
			},
		};
		const runtime: TenantChannelRuntime = {
			context: tenant.context,
			registry,
			dispatcher,
			wechatChannel: null,
			// Channel construction needs the tenant's merged config — an async
			// PostgreSQL read — so it happens inside the hydration step, after
			// the ledgers. A failed hydration drops the runtime so the next
			// access retries instead of caching a broken channel set.
			hydrated: Promise.all([
				registry.loadDefaultTargets(),
				dedupeStore.hydrate(),
				runLog.hydrate(),
				dispatcher.chatSessionMapHydrated,
				wechatTokenPersistence.hydrate?.(),
			]).then(async () => {
				const registration = this.options.createChannels({
					config: await resolveTenantConfig(tenant.context.tenantId, this.options.getLocalConfig(), tenant.store),
					registry,
					dispatch,
					wechatTokenPersistence,
				});
				runtime.wechatChannel = registration.wechatChannel ?? null;
				runtime.stop = async () => {
					dispatcher.dispose();
					await registration.stop?.();
					await runtime.wechatChannel?.stop();
				};
			}),
		};
		runtime.hydrated.catch((err) => {
			this.runtimes.delete(tenant.context.tenantId);
			logger.error({ err }, "tenant channel runtime hydration failed");
		});
		this.runtimes.set(tenant.context.tenantId, runtime);
		return runtime;
	}

	private dispatch(runtime: TenantChannelRuntime, channel: ChatChannel, message: IncomingMessage): void {
		void runInTenantContext(runtime.context, this.options.tenantStore, async () => {
			await runtime.hydrated;
			await runtime.dispatcher.handle(channel, message);
		})
			.catch((error) => logger.error({ err: error, tenantId: runtime.context.tenantId }, "tenant channel dispatch failed"));
	}
}
