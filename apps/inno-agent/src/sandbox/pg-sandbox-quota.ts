import type { Pool } from "pg";
import {
	SANDBOX_LEASE_STALE_MS,
	quotaMessage,
	type SandboxLimits,
	type SandboxQuotaDecision,
	type SandboxQuotaStore,
} from "./sandbox-quota.js";

/**
 * Sandbox accounting in PostgreSQL, shared by every worker. Each decision runs
 * in a transaction that holds a per-tenant advisory lock, so concurrent opens
 * across workers cannot both slip under a limit.
 */
export class PgSandboxQuotaStore implements SandboxQuotaStore {
	constructor(private readonly pool: Pool) {}

	private async inTenantTransaction<T>(tenant: string, operation: (query: Pool["query"]) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`sandbox-quota:${tenant}`]);
			const result = await operation(client.query.bind(client) as Pool["query"]);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	/** Count leases that stopped heartbeating up to their last sign of life, then drop them. */
	private async reap(query: Pool["query"], tenant: string): Promise<void> {
		await query(
			`WITH dead AS (
			   DELETE FROM sandbox_leases
			   WHERE tenant_id = $1 AND heartbeat_at < now() - make_interval(secs => $2)
			   RETURNING started_at, heartbeat_at)
			 INSERT INTO sandbox_usage (tenant_id, day, active_ms)
			 SELECT $1, (heartbeat_at AT TIME ZONE 'UTC')::date,
			        SUM(GREATEST(0, EXTRACT(EPOCH FROM (heartbeat_at - started_at)) * 1000))::bigint
			 FROM dead GROUP BY 2
			 ON CONFLICT (tenant_id, day) DO UPDATE SET active_ms = sandbox_usage.active_ms + EXCLUDED.active_ms`,
			[tenant, SANDBOX_LEASE_STALE_MS / 1000],
		);
	}

	private async usedMs(query: Pool["query"], tenant: string, excludeSession?: string): Promise<number> {
		const result = await query(
			`SELECT
			   COALESCE((SELECT active_ms FROM sandbox_usage WHERE tenant_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date), 0)
			 + COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)
			             FROM sandbox_leases WHERE tenant_id = $1 AND session_id IS DISTINCT FROM $2), 0) AS used_ms`,
			[tenant, excludeSession ?? null],
		);
		return Number((result.rows[0] as { used_ms: string | number }).used_ms);
	}

	async acquire(tenant: string, sessionId: string, limits: SandboxLimits): Promise<SandboxQuotaDecision> {
		return this.inTenantTransaction(tenant, async (query) => {
			await this.reap(query, tenant);
			const others = await query(
				"SELECT COUNT(*)::int AS n FROM sandbox_leases WHERE tenant_id = $1 AND session_id <> $2", [tenant, sessionId]);
			if (limits.maxConcurrent > 0 && (others.rows[0] as { n: number }).n >= limits.maxConcurrent) {
				return { ok: false as const, reason: "concurrent" as const, message: quotaMessage("concurrent", limits) };
			}
			if (limits.maxActiveMinutesPerDay > 0 && await this.usedMs(query, tenant) >= limits.maxActiveMinutesPerDay * 60_000) {
				return { ok: false as const, reason: "time" as const, message: quotaMessage("time", limits) };
			}
			await query(
				`INSERT INTO sandbox_leases (session_id, tenant_id, started_at, heartbeat_at) VALUES ($1, $2, now(), now())
				 ON CONFLICT (session_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, heartbeat_at = now()`,
				[sessionId, tenant],
			);
			return { ok: true as const };
		});
	}

	async heartbeat(tenant: string, sessionId: string, limits: SandboxLimits): Promise<SandboxQuotaDecision> {
		return this.inTenantTransaction(tenant, async (query) => {
			await query("UPDATE sandbox_leases SET heartbeat_at = now() WHERE session_id = $1 AND tenant_id = $2", [sessionId, tenant]);
			if (limits.maxActiveMinutesPerDay > 0 && await this.usedMs(query, tenant) >= limits.maxActiveMinutesPerDay * 60_000) {
				return { ok: false as const, reason: "time" as const, message: quotaMessage("time", limits) };
			}
			return { ok: true as const };
		});
	}

	async release(tenant: string, sessionId: string): Promise<void> {
		await this.inTenantTransaction(tenant, async (query) => {
			await query(
				`WITH ended AS (
				   DELETE FROM sandbox_leases WHERE session_id = $1 AND tenant_id = $2 RETURNING started_at)
				 INSERT INTO sandbox_usage (tenant_id, day, active_ms)
				 SELECT $2, (now() AT TIME ZONE 'UTC')::date, GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint FROM ended
				 ON CONFLICT (tenant_id, day) DO UPDATE SET active_ms = sandbox_usage.active_ms + EXCLUDED.active_ms`,
				[sessionId, tenant],
			);
		});
	}

	async usedMinutesToday(tenant: string): Promise<number> {
		const used = await this.usedMs(this.pool.query.bind(this.pool) as Pool["query"], tenant);
		return Math.ceil(used / 60_000);
	}
}
