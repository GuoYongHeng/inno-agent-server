import {
	SandboxFsError,
	SandboxRunError,
	type SandboxBackend,
	type SandboxEntry,
	type SandboxRunOptions,
} from "./sandbox-backend.js";

/** Per-tenant sandbox limits. A value of 0 means unlimited. */
export interface SandboxLimits {
	/** Sandboxes one tenant may have running at the same time (one per open session). */
	maxConcurrent: number;
	/** Sandboxes one tenant may own at all, running or paused. */
	maxSandboxes: number;
	/** Running time one tenant may use per UTC day, in minutes. */
	maxActiveMinutesPerDay: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { maxConcurrent: 3, maxSandboxes: 20, maxActiveMinutesPerDay: 480 };

export type SandboxQuotaReason = "concurrent" | "time";

export type SandboxQuotaDecision =
	| { ok: true }
	| { ok: false; reason: SandboxQuotaReason; message: string };

export function quotaMessage(reason: SandboxQuotaReason | "sandboxes", limits: SandboxLimits): string {
	switch (reason) {
		case "concurrent":
			return `已达到同时运行的沙箱数量上限（${limits.maxConcurrent}）。请先关闭其他正在使用沙箱的对话，稍后再试。`;
		case "sandboxes":
			return `已达到沙箱总数上限（${limits.maxSandboxes}）。请删除不再需要的对话来释放沙箱。`;
		case "time":
			return `今日沙箱使用时长已达上限（${limits.maxActiveMinutesPerDay} 分钟），明天（UTC）重置。`;
	}
}

/**
 * Accounting for sandbox use, keyed by tenant. A lease is held for as long as a
 * session's runtime is open on a sandbox; its running time is added to the
 * tenant's usage for the day when it ends. A lease whose owner stopped
 * heartbeating (a crashed worker) is reaped and counted up to its last heartbeat.
 */
export interface SandboxQuotaStore {
	/** Take a lease for the session unless the tenant is at a limit. Idempotent per session. */
	acquire(tenant: string, sessionId: string, limits: SandboxLimits): Promise<SandboxQuotaDecision>;
	/** Refresh the lease and re-check the time budget (including the current lease). */
	heartbeat(tenant: string, sessionId: string, limits: SandboxLimits): Promise<SandboxQuotaDecision>;
	/** End the lease and add its running time to today's usage. */
	release(tenant: string, sessionId: string): Promise<void>;
	/** Minutes used today, including running leases. */
	usedMinutesToday(tenant: string): Promise<number>;
}

/** Leases without a heartbeat for this long belong to a dead owner. */
export const SANDBOX_LEASE_STALE_MS = 10 * 60_000;

const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Process-local store for local mode and single-process deployments. */
export class InMemorySandboxQuotaStore implements SandboxQuotaStore {
	private readonly leases = new Map<string, { tenant: string; startedAt: number; heartbeatAt: number }>();
	private readonly usage = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	private addUsage(tenant: string, ms: number, at: number): void {
		const key = `${tenant}|${dayKey(at)}`;
		this.usage.set(key, (this.usage.get(key) ?? 0) + Math.max(0, ms));
	}

	private reap(): void {
		const now = this.now();
		for (const [sessionId, lease] of this.leases) {
			if (now - lease.heartbeatAt > SANDBOX_LEASE_STALE_MS) {
				this.addUsage(lease.tenant, lease.heartbeatAt - lease.startedAt, lease.heartbeatAt);
				this.leases.delete(sessionId);
			}
		}
	}

	private usedMs(tenant: string, excludeSession?: string): number {
		const now = this.now();
		let total = this.usage.get(`${tenant}|${dayKey(now)}`) ?? 0;
		for (const [sessionId, lease] of this.leases) {
			if (lease.tenant === tenant && sessionId !== excludeSession) total += now - lease.startedAt;
		}
		return total;
	}

	async acquire(tenant: string, sessionId: string, limits: SandboxLimits): Promise<SandboxQuotaDecision> {
		this.reap();
		const others = [...this.leases].filter(([id, lease]) => lease.tenant === tenant && id !== sessionId).length;
		if (limits.maxConcurrent > 0 && others >= limits.maxConcurrent) {
			return { ok: false, reason: "concurrent", message: quotaMessage("concurrent", limits) };
		}
		if (limits.maxActiveMinutesPerDay > 0 && this.usedMs(tenant) >= limits.maxActiveMinutesPerDay * 60_000) {
			return { ok: false, reason: "time", message: quotaMessage("time", limits) };
		}
		const now = this.now();
		this.leases.set(sessionId, { tenant, startedAt: this.leases.get(sessionId)?.startedAt ?? now, heartbeatAt: now });
		return { ok: true };
	}

	async heartbeat(tenant: string, sessionId: string, limits: SandboxLimits): Promise<SandboxQuotaDecision> {
		const lease = this.leases.get(sessionId);
		if (lease) lease.heartbeatAt = this.now();
		if (limits.maxActiveMinutesPerDay > 0 && this.usedMs(tenant) >= limits.maxActiveMinutesPerDay * 60_000) {
			return { ok: false, reason: "time", message: quotaMessage("time", limits) };
		}
		return { ok: true };
	}

	async release(tenant: string, sessionId: string): Promise<void> {
		const lease = this.leases.get(sessionId);
		if (!lease) return;
		this.addUsage(tenant, this.now() - lease.startedAt, this.now());
		this.leases.delete(sessionId);
	}

	async usedMinutesToday(tenant: string): Promise<number> {
		return Math.ceil(this.usedMs(tenant) / 60_000);
	}
}

/**
 * Wraps a sandbox so it can be switched off without disconnecting the runtime
 * that holds it: while blocked, every operation fails with the quota message,
 * which the model and the user see as the tool error. Used both for a session
 * that could not get a sandbox and for one that ran out of time mid-session.
 */
export class GuardedSandboxBackend implements SandboxBackend {
	private blockedReason: string | undefined;

	constructor(private inner: SandboxBackend | undefined, readonly id: string) {}

	get blocked(): boolean { return this.blockedReason !== undefined; }

	/** Point at the live sandbox once one is connected. */
	attach(inner: SandboxBackend): void { this.inner = inner; }

	block(reason: string): void { this.blockedReason = reason; }
	unblock(): void { this.blockedReason = undefined; }

	private live(path?: string): SandboxBackend {
		if (this.blockedReason !== undefined || !this.inner) {
			throw new SandboxFsError("permission_denied", this.blockedReason ?? "The sandbox is unavailable", path);
		}
		return this.inner;
	}

	async readFile(path: string, signal?: AbortSignal) { return this.live(path).readFile(path, signal); }
	async writeFile(path: string, data: Uint8Array | string, signal?: AbortSignal) { return this.live(path).writeFile(path, data, signal); }
	async list(path: string) { return this.live(path).list(path); }
	async listTree(path: string, maxDepth: number) { return this.live(path).listTree(path, maxDepth); }
	async stat(path: string): Promise<SandboxEntry> { return this.live(path).stat(path); }
	async makeDir(path: string) { return this.live(path).makeDir(path); }
	async remove(path: string) { return this.live(path).remove(path); }
	async rename(from: string, to: string) { return this.live(from).rename(from, to); }

	async run(command: string, options?: SandboxRunOptions) {
		if (this.blockedReason !== undefined || !this.inner) {
			throw new SandboxRunError("unavailable", this.blockedReason ?? "The sandbox is unavailable");
		}
		return this.inner.run(command, options);
	}

	async keepAlive(ms: number) { if (!this.blocked) await this.inner?.keepAlive(ms); }
	async pause() { await this.inner?.pause(); }
	async kill() { await this.inner?.kill(); }
}
