import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { readJson, writeJson } from "../storage/file-store.js";
import { getCurrentTenant } from "./current.js";

/**
 * Small per-tenant JSON key-value ledger (table `tenant_state`). Replaces the
 * file ledgers that lived under `<tenant data root>/channels/` and
 * `sessions/`: channel default targets, chat-session bindings, session-channel
 * metadata, and the wechat login token.
 *
 * The tenant is resolved from the ambient request/scheduler context at call
 * time — every caller runs inside a verified tenant context.
 */
/** Minimal KV surface `TenantJsonLedger` needs — production uses `TenantStateStore`, tests inject in-memory fakes. */
export interface TenantStateKv {
	/** Distinguishes two stores that could otherwise share in-process lock keys (file fakes only). */
	readonly scope?: string;
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}

export class TenantStateStore implements TenantStateKv {
	constructor(private readonly pool: Pool) {}

	private tenantId(): string {
		const tenant = getCurrentTenant();
		if (!tenant) throw new Error("TenantStateStore requires a verified tenant context");
		return tenant.tenantId;
	}

	async get<T>(key: string): Promise<T | undefined> {
		const result = await this.pool.query<{ value: T }>(
			"SELECT value FROM tenant_state WHERE tenant_id = $1 AND key = $2",
			[this.tenantId(), key],
		);
		return result.rows[0]?.value;
	}

	async set(key: string, value: unknown): Promise<void> {
		await this.pool.query(
			`INSERT INTO tenant_state (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
			 ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3::jsonb, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId(), key, JSON.stringify(value)],
		);
	}

	async delete(key: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM tenant_state WHERE tenant_id = $1 AND key = $2",
			[this.tenantId(), key],
		);
	}
}

/**
 * Serialized write-through wrapper over `tenant_state`: every `save` queues
 * behind the previous one, so rapid in-memory mutations cannot interleave
 * partial writes.
 */
export class TenantJsonLedger<T> {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly store: TenantStateKv,
		private readonly key: string,
	) {}

	load(): Promise<T | undefined> {
		return this.store.get<T>(this.key);
	}

	save(value: T): Promise<void> {
		this.chain = this.chain.then(() => this.store.set(this.key, value));
		return this.chain as Promise<void>;
	}
}

/**
 * File-backed `TenantStateKv` — one JSON file per key under `<root>/state/`.
 * Unit-test / local fake only; production always uses `TenantStateStore`.
 */
export class FileStateKv implements TenantStateKv {
	readonly scope: string;

	constructor(private readonly root: string) {
		this.scope = root;
	}

	private path(key: string): string {
		return join(this.root, "state", `${encodeURIComponent(key)}.json`);
	}

	async get<T>(key: string): Promise<T | undefined> {
		const path = this.path(key);
		return existsSync(path) ? readJson<T | undefined>(path, undefined) : undefined;
	}

	async set(key: string, value: unknown): Promise<void> {
		writeJson(this.path(key), value);
	}

	async delete(key: string): Promise<void> {
		rmSync(this.path(key), { force: true });
	}
}

const updateChains = new Map<string, Promise<unknown>>();

/**
 * Serialised read-modify-write of one key. `tenant_state` rows have no
 * compare-and-swap, so concurrent in-process callers queue per
 * (tenant, key); a tenant is pinned to one worker, so this is sufficient.
 * Returning `undefined` from `mutate` deletes the key; returning a value
 * stores it.
 */
export function updateTenantState<T, R = void>(
	kv: TenantStateKv,
	key: string,
	mutate: (current: T | undefined) => { next: T | undefined; result: R },
): Promise<R> {
	const lockKey = `${kv.scope ?? getCurrentTenant()?.tenantId ?? "-"}\0${key}`;
	const previous = updateChains.get(lockKey) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(async () => {
		const current = await kv.get<T>(key);
		const { next, result } = mutate(current);
		if (next === undefined) {
			if (current !== undefined) await kv.delete(key);
		} else {
			await kv.set(key, next);
		}
		return result;
	});
	updateChains.set(lockKey, run);
	void run.finally(() => {
		if (updateChains.get(lockKey) === run) updateChains.delete(lockKey);
	}).catch(() => undefined);
	return run;
}
