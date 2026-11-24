import type { Pool } from "pg";
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
