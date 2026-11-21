import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { logger } from "../logger.js";
import { withTenantTransaction } from "./schema.js";

export type ResourceKind = "session" | "workspace" | "job" | "channel" | "memory" | "terminal" | "permission";

export interface TenantContext {
	tenantId: string;
	userId: string;
	role: "owner";
}

export interface LegacyResourceSet {
	sessions: string[];
	workspaces: string[];
}

export interface LegacyMigrationReport {
	dryRun: boolean;
	ownerUserId: string;
	tenantId: string | null;
	assigned: number;
	alreadyOwned: number;
	conflicts: Array<{ resourceType: ResourceKind; resourceId: string }>;
}

export class ResourceOwnershipError extends Error {
	readonly statusCode = 404;
	constructor(kind: ResourceKind, resourceId: string) {
		super(`${kind} not found: ${resourceId}`);
		this.name = "ResourceOwnershipError";
	}
}

export interface JobRunClaim {
	readonly occurrenceId: string;
	release(): Promise<void>;
}

export interface DurableStorageLock {
	readonly lost: boolean;
	/** Backend pid of the dedicated connection holding the advisory lock. */
	readonly backendPid: number;
	onLost(listener: () => void): void;
	release(): Promise<void>;
}

/** A PostgreSQL connection owns this non-expiring advisory lock. Process death
 * releases it; connection loss invalidates the old runtime instead of allowing
 * a timed takeover while a paused process may still write SQLite. */
class PostgresDurableStorageLock implements DurableStorageLock {
	private released = false;
	private invalidated = false;
	private readonly listeners = new Set<() => void>();
	private readonly handleError = (): void => {
		if (this.released || this.invalidated) return;
		this.invalidated = true;
		for (const listener of this.listeners) {
			try { listener(); } catch (error) { logger.error({ err: error }, "durable storage lock loss handler failed"); }
		}
	};

	constructor(private readonly client: PoolClient, private readonly key: string) {
		this.client.on("error", this.handleError);
	}

	get lost(): boolean { return this.invalidated; }

	get backendPid(): number {
		return (this.client as unknown as { processID?: number }).processID ?? 0;
	}

	onLost(listener: () => void): void {
		if (this.invalidated) listener();
		else this.listeners.add(listener);
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.listeners.clear();
		this.client.off("error", this.handleError);
		let failure: unknown;
		try {
			if (!this.invalidated) await this.client.query("SELECT pg_advisory_unlock($1)", [this.key]);
		} catch (error) {
			failure = error;
		} finally {
			this.client.release(failure instanceof Error ? failure : undefined);
		}
		if (failure) throw failure;
	}
}

export function durableStorageLockKey(tenantId: string, sessionId: string): string {
	const digest = createHash("sha256").update(`durable\0${tenantId}\0${sessionId}`).digest();
	return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

const JOB_RUN_LEASE_MS = 5 * 60_000;

/** How long a durable storage lease stays valid without a heartbeat.
 * `INNO_DURABLE_STORAGE_LEASE_MS` shortens it in tests (zombie-owner takeover). */
export const DURABLE_STORAGE_LEASE_MS = Math.max(1_000, Number(process.env.INNO_DURABLE_STORAGE_LEASE_MS) || 45_000);

/** Identity recorded as `ds_metadata.owner_worker`. The configured shard id
 * is preferred so leases line up with routing; otherwise host+pid. */
export function durableWorkerId(env: NodeJS.ProcessEnv = process.env): string {
	const shard = env.INNO_DURABLE_SHARD_ID?.trim();
	if (shard) return shard;
	return `${hostname()}:${process.pid}`;
}

/** A leased occurrence claim. Renewal and release are owner-token fenced. */
class PostgresJobRunClaim implements JobRunClaim {
	private readonly heartbeat: NodeJS.Timeout;
	private released = false;

	constructor(
		private readonly pool: Pool,
		readonly occurrenceId: string,
		private readonly ownerToken: string,
		leaseMs: number,
	) {
		this.heartbeat = setInterval(() => {
			void this.pool.query(
				`UPDATE job_run_claims SET expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
				 WHERE occurrence_id = $1 AND owner_token = $3`,
				[occurrenceId, leaseMs, ownerToken],
			).then((result) => {
				if (result.rowCount !== 1) logger.warn({ occurrenceId }, "scheduled job claim lease was lost");
			}).catch((error) => logger.error({ err: error, occurrenceId }, "scheduled job claim renewal failed"));
		}, Math.max(1_000, Math.floor(leaseMs / 3)));
		this.heartbeat.unref();
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		clearInterval(this.heartbeat);
		await this.pool.query(
			"DELETE FROM job_run_claims WHERE occurrence_id = $1 AND owner_token = $2",
			[this.occurrenceId, this.ownerToken],
		);
	}
}

export class TenantStore {
	constructor(private readonly pool: Pool) {}

	/** The shared pool, for stores that keep tenant-scoped rows in the same database. */
	get database(): Pool { return this.pool; }

	async ensurePersonalTenant(userId: string): Promise<TenantContext> {
		const client = await this.pool.connect();
		try {
			return await withTenantTransaction(client, async () => {
				const tenant = await client.query<{ id: string }>(
					`INSERT INTO tenants (id, owner_user_id)
					 VALUES ($1, $2)
					 ON CONFLICT (owner_user_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id
					 RETURNING id`,
					[randomUUID(), userId],
				);
				const tenantId = tenant.rows[0].id;
				await client.query(
					`INSERT INTO tenant_memberships (tenant_id, user_id, role)
					 VALUES ($1, $2, 'owner') ON CONFLICT (user_id) DO NOTHING`,
					[tenantId, userId],
				);
				return { tenantId, userId, role: "owner" as const };
			});
		} finally {
			client.release();
		}
	}

	async findPersonalTenant(userId: string): Promise<TenantContext | null> {
		const result = await this.pool.query<{ id: string }>(
			"SELECT id FROM tenants WHERE owner_user_id = $1",
			[userId],
		);
		const tenantId = result.rows[0]?.id;
		return tenantId ? { tenantId, userId, role: "owner" } : null;
	}

	async claimResource(context: TenantContext, kind: ResourceKind, resourceId: string): Promise<void> {
		const client = await this.pool.connect();
		try {
			await withTenantTransaction(client, async () => {
				// Membership is checked in the same transaction as the claim; callers
				// never supply a tenant id directly.
				const member = await client.query(
					"SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2",
					[context.tenantId, context.userId],
				);
				if (member.rowCount !== 1) throw new ResourceOwnershipError(kind, resourceId);
				const inserted = await client.query(
					`INSERT INTO resource_ownership (tenant_id, resource_type, resource_id)
					 VALUES ($1, $2, $3) ON CONFLICT (resource_type, resource_id) DO NOTHING RETURNING tenant_id`,
					[context.tenantId, kind, resourceId],
				);
				if (inserted.rowCount === 1) return;
				const existing = await client.query<{ tenant_id: string }>(
					"SELECT tenant_id FROM resource_ownership WHERE resource_type = $1 AND resource_id = $2",
					[kind, resourceId],
				);
				if (existing.rows[0]?.tenant_id !== context.tenantId) {
					throw new ResourceOwnershipError(kind, resourceId);
				}
			});
		} finally {
			client.release();
		}
	}

	async ownsResource(context: TenantContext, kind: ResourceKind, resourceId: string): Promise<boolean> {
		const result = await this.pool.query(
			`SELECT 1 FROM resource_ownership
			 WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3`,
			[context.tenantId, kind, resourceId],
		);
		return result.rowCount === 1;
	}

	/** Resolve an external connection identity without accepting a tenant id from its callback. */
	async findResourceOwner(kind: ResourceKind, resourceId: string): Promise<TenantContext | null> {
		const result = await this.pool.query<{ tenant_id: string; user_id: string }>(
			`SELECT ownership.tenant_id, membership.user_id
			 FROM resource_ownership ownership
			 JOIN tenant_memberships membership ON membership.tenant_id = ownership.tenant_id
			 WHERE ownership.resource_type = $1 AND ownership.resource_id = $2`,
			[kind, resourceId],
		);
		const row = result.rows[0];
		return row ? { tenantId: row.tenant_id, userId: row.user_id, role: "owner" } : null;
	}

	async listResourceOwners(kind: ResourceKind): Promise<TenantContext[]> {
		const result = await this.pool.query<{ tenant_id: string; user_id: string }>(
			`SELECT DISTINCT ownership.tenant_id, membership.user_id
			 FROM resource_ownership ownership
			 JOIN tenant_memberships membership ON membership.tenant_id = ownership.tenant_id
			 WHERE ownership.resource_type = $1`,
			[kind],
		);
		return result.rows.map((row) => ({ tenantId: row.tenant_id, userId: row.user_id, role: "owner" }));
	}

	/** Serialize authenticated durable SQLite owners across server processes.
	 * The dedicated connection is retained for the entire runtime lease. */
	async acquireDurableStorageLock(
		context: TenantContext,
		sessionId: string,
	): Promise<DurableStorageLock | null> {
		const client = await this.pool.connect();
		try {
			const owned = await client.query(
				`SELECT 1 FROM resource_ownership ownership
				 JOIN tenant_memberships membership ON membership.tenant_id = ownership.tenant_id
				 WHERE ownership.tenant_id = $1 AND ownership.resource_type = 'session'
				   AND ownership.resource_id = $2 AND membership.user_id = $3`,
				[context.tenantId, sessionId, context.userId],
			);
			if (owned.rowCount !== 1) throw new ResourceOwnershipError("session", sessionId);
			const key = durableStorageLockKey(context.tenantId, sessionId);
			const locked = await client.query<{ locked: boolean }>(
				"SELECT pg_try_advisory_lock($1) AS locked",
				[key],
			);
			if (locked.rows[0]?.locked !== true) {
				client.release();
				return null;
			}
			return new PostgresDurableStorageLock(client, key);
		} catch (error) {
			client.release(error instanceof Error ? error : undefined);
			throw error;
		}
	}

	/**
	 * Claim durable session storage ownership for `workerId`. The conditional
	 * update wins when the recorded lease is unowned/expired, already owned by
	 * the claimant, or its owner is provably dead (no other backend holds the
	 * session advisory lock); each successful claim bumps the fencing epoch
	 * that `PgDurableStorage` commits are checked against. Returns the new
	 * epoch, or null while another worker's live lease is still defensible.
	 */
	async claimDurableStorage(
		context: TenantContext,
		sessionId: string,
		workerId: string,
		leaseMs = DURABLE_STORAGE_LEASE_MS,
		advisoryBackendPid: number | null = null,
	): Promise<number | null> {
		const owned = await this.pool.query(
			`SELECT 1 FROM resource_ownership ownership
			 JOIN tenant_memberships membership ON membership.tenant_id = ownership.tenant_id
			 WHERE ownership.tenant_id = $1 AND ownership.resource_type = 'session'
			   AND ownership.resource_id = $2 AND membership.user_id = $3`,
			[context.tenantId, sessionId, context.userId],
		);
		if (owned.rowCount !== 1) throw new ResourceOwnershipError("session", sessionId);
		// Sessions created before the storage migration have no metadata row yet.
		await this.pool.query(
			`INSERT INTO ds_metadata (session_id)
			 SELECT id FROM durable_sessions WHERE id = $1
			 ON CONFLICT DO NOTHING`,
			[sessionId],
		);
		// A recorded owner is provably dead once no other backend still holds its
		// advisory lock (process death releases it): a claimant that already owns
		// the lock passes its backend pid so its own lock does not count; a
		// claimant holding nothing requires the lock to be free entirely or the
		// recorded lease to be expired, which fences a merely paused owner.
		const lockKey = BigInt(durableStorageLockKey(context.tenantId, sessionId));
		const classid = Number(BigInt.asIntN(32, lockKey >> 32n));
		const objid = Number(BigInt.asIntN(32, lockKey));
		const claimed = await this.pool.query<{ lease_epoch: string }>(
			`UPDATE ds_metadata
			 SET owner_worker = $2, lease_epoch = lease_epoch + 1,
				 lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
			 WHERE session_id = $1
			   AND (owner_worker IS NULL OR owner_worker = $2
					OR lease_expires_at IS NULL OR lease_expires_at < NOW()
					OR NOT EXISTS (SELECT 1 FROM pg_locks
						WHERE locktype = 'advisory' AND classid = $4 AND objid = $5 AND granted
						  AND pid IS DISTINCT FROM $6))
			 RETURNING lease_epoch`,
			[sessionId, workerId, leaseMs, classid, objid, advisoryBackendPid],
		);
		const epoch = claimed.rows[0]?.lease_epoch;
		return epoch === undefined ? null : Number(epoch);
	}

	/** Renew a held storage lease; false once the epoch was taken over. */
	async renewDurableStorage(
		sessionId: string,
		workerId: string,
		epoch: number,
		leaseMs = DURABLE_STORAGE_LEASE_MS,
	): Promise<boolean> {
		const result = await this.pool.query(
			`UPDATE ds_metadata
			 SET lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond')
			 WHERE session_id = $1 AND owner_worker = $2 AND lease_epoch = $3`,
			[sessionId, workerId, epoch, leaseMs],
		);
		return result.rowCount === 1;
	}

	/** Release a held storage lease so another worker can claim immediately. */
	async releaseDurableStorage(sessionId: string, epoch: number): Promise<void> {
		await this.pool.query(
			`UPDATE ds_metadata SET owner_worker = NULL, lease_expires_at = NULL
			 WHERE session_id = $1 AND lease_epoch = $2`,
			[sessionId, epoch],
		);
	}

	/**
	 * Authoritative tenant config copy for cross-worker takeover. Workers
	 * materialise it into their local `tenants/<id>/config/config.json` on
	 * request entry; `updatedAt` is the sync marker.
	 */
	async loadTenantConfigRecord(tenantId: string): Promise<{ config: string; updatedAt: string } | null> {
		const rows = await this.pool.query<{ config: string; updated_at: string }>(
			"SELECT config, updated_at::text AS updated_at FROM tenant_configs WHERE tenant_id = $1",
			[tenantId],
		);
		const row = rows.rows[0];
		return row ? { config: row.config, updatedAt: row.updated_at } : null;
	}

	/** Upsert the authoritative tenant config; returns the new updated_at marker. */
	async saveTenantConfigRecord(tenantId: string, configJson: string): Promise<string> {
		const rows = await this.pool.query<{ updated_at: string }>(
			`INSERT INTO tenant_configs (tenant_id, config) VALUES ($1, $2)
			 ON CONFLICT (tenant_id) DO UPDATE SET config = $2, updated_at = NOW()
			 RETURNING updated_at::text AS updated_at`,
			[tenantId, configJson],
		);
		return rows.rows[0]!.updated_at;
	}

	/**
	 * Live recorded storage owner for request routing: owner_worker only while
	 * its lease is unexpired and some backend still holds the session's advisory
	 * lock (process death releases it, so a dead owner's live-looking lease is
	 * ignored). Returns null for unowned or provably-dead-owner sessions.
	 */
	async durableSessionOwner(context: TenantContext, sessionId: string): Promise<string | null> {
		const lockKey = BigInt(durableStorageLockKey(context.tenantId, sessionId));
		const classid = Number(BigInt.asIntN(32, lockKey >> 32n));
		const objid = Number(BigInt.asIntN(32, lockKey));
		const rows = await this.pool.query<{ owner_worker: string }>(
			`SELECT owner_worker FROM ds_metadata
			 WHERE session_id = $1 AND owner_worker IS NOT NULL
			   AND lease_expires_at > NOW()
			   AND EXISTS (SELECT 1 FROM pg_locks
				 WHERE locktype = 'advisory' AND classid = $2 AND objid = $3 AND granted)`,
			[sessionId, classid, objid],
		);
		return rows.rows[0]?.owner_worker ?? null;
	}

	/**
	 * Atomically claim one scheduled occurrence. A crashed owner's lease can be
	 * taken over only after expiry; successful/failed executions release it and
	 * rely on the job/occurrence ledgers for their durable completion state.
	 */
	async claimJobRun(
		context: TenantContext,
		jobId: string,
		occurrenceId: string,
		scheduledAt: string,
		leaseMs = JOB_RUN_LEASE_MS,
	): Promise<JobRunClaim | null> {
		const ownerToken = randomUUID();
		const client = await this.pool.connect();
		try {
			const claimed = await withTenantTransaction(client, async () => {
				const owned = await client.query(
					`SELECT 1 FROM resource_ownership ownership
					 JOIN tenant_memberships membership ON membership.tenant_id = ownership.tenant_id
					 WHERE ownership.tenant_id = $1 AND ownership.resource_type = 'job'
					   AND ownership.resource_id = $2 AND membership.user_id = $3`,
					[context.tenantId, jobId, context.userId],
				);
				if (owned.rowCount !== 1) return false;
				const inserted = await client.query(
					`INSERT INTO job_run_claims
					 (occurrence_id, tenant_id, job_id, scheduled_at, owner_token, expires_at)
					 VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 millisecond'))
					 ON CONFLICT (occurrence_id) DO NOTHING`,
					[occurrenceId, context.tenantId, jobId, scheduledAt, ownerToken, leaseMs],
				);
				if (inserted.rowCount !== 1) {
					const taken = await client.query(
						`UPDATE job_run_claims
						 SET tenant_id = $2, job_id = $3, scheduled_at = $4, owner_token = $5,
						     claimed_at = NOW(), expires_at = NOW() + ($6 * INTERVAL '1 millisecond')
						 WHERE occurrence_id = $1 AND expires_at <= NOW()`,
						[occurrenceId, context.tenantId, jobId, scheduledAt, ownerToken, leaseMs],
					);
					if (taken.rowCount !== 1) return false;
				}
				return true;
			});
			return claimed ? new PostgresJobRunClaim(this.pool, occurrenceId, ownerToken, leaseMs) : null;
		} finally {
			client.release();
		}
	}

	async listResourceIds(context: TenantContext, kind: ResourceKind): Promise<Set<string>> {
		const result = await this.pool.query<{ resource_id: string }>(
			"SELECT resource_id FROM resource_ownership WHERE tenant_id = $1 AND resource_type = $2",
			[context.tenantId, kind],
		);
		return new Set(result.rows.map((row) => row.resource_id));
	}

	async releaseResource(context: TenantContext, kind: ResourceKind, resourceId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM resource_ownership WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3",
			[context.tenantId, kind, resourceId],
		);
	}

	async migrateLegacyResources(
		ownerUserId: string,
		resources: LegacyResourceSet,
		dryRun: boolean,
	): Promise<LegacyMigrationReport> {
		const context = dryRun
			? await this.findPersonalTenant(ownerUserId)
			: await this.ensurePersonalTenant(ownerUserId);
		const report: LegacyMigrationReport = {
			dryRun,
			ownerUserId,
			tenantId: context?.tenantId ?? null,
			assigned: 0,
			alreadyOwned: 0,
			conflicts: [],
		};
		for (const [kind, ids] of [["session", resources.sessions], ["workspace", resources.workspaces]] as const) {
			for (const resourceId of new Set(ids)) {
				const existing = await this.pool.query<{ tenant_id: string }>(
					"SELECT tenant_id FROM resource_ownership WHERE resource_type = $1 AND resource_id = $2",
					[kind, resourceId],
				);
				const owner = existing.rows[0]?.tenant_id;
				if (owner && owner !== context?.tenantId) {
					report.conflicts.push({ resourceType: kind, resourceId });
					continue;
				}
				if (owner) {
					report.alreadyOwned += 1;
					continue;
				}
				report.assigned += 1;
				if (!dryRun) await this.claimResource(context!, kind, resourceId);
			}
		}
		return report;
	}
}
