import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { logger } from "../logger.js";
import { WorkspaceStoreError } from "../workspace/workspace-store.js";
import { resolveDurableShardId } from "./durable-tenant-router.js";
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

export type WorkspaceFileKind = "file" | "directory";

/** One row of the `workspace_files` manifest (files AND explicit directories). */
export interface WorkspaceFileRow {
	relPath: string;
	kind: WorkspaceFileKind;
	size: number;
	mtimeMs: number;
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

/** Identity recorded as `ds_metadata.owner_worker`. The resolved shard id
 * (explicit config or container `HOSTNAME`) is preferred so leases line up
 * with routing; otherwise host+pid. */
export function durableWorkerId(env: NodeJS.ProcessEnv = process.env): string {
	const shard = resolveDurableShardId(env);
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
			 SET owner_worker = $2, last_worker = $2, lease_epoch = lease_epoch + 1,
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
		return (await this.durableSessionRouteHint(context, sessionId)).owner;
	}

	/**
	 * Routing hint for a session-scoped request: `owner` is the live recorded
	 * storage owner (lease unexpired and the advisory lock still held), while
	 * `affinity` is the worker that last claimed the session — set on every
	 * claim and kept on release so idle sessions stay near their worker-local
	 * files. Either may name a dead worker; the forward path handles that.
	 */
	async durableSessionRouteHint(context: TenantContext, sessionId: string): Promise<{ owner: string | null; affinity: string | null }> {
		const lockKey = BigInt(durableStorageLockKey(context.tenantId, sessionId));
		const classid = Number(BigInt.asIntN(32, lockKey >> 32n));
		const objid = Number(BigInt.asIntN(32, lockKey));
		const rows = await this.pool.query<{ owner_worker: string | null; last_worker: string | null; live: boolean }>(
			`SELECT owner_worker, last_worker,
				 (lease_expires_at > NOW()
				   AND EXISTS (SELECT 1 FROM pg_locks
					 WHERE locktype = 'advisory' AND classid = $2 AND objid = $3 AND granted)) AS live
			 FROM ds_metadata WHERE session_id = $1`,
			[sessionId, classid, objid],
		);
		const row = rows.rows[0];
		return {
			owner: row?.live ? row.owner_worker : null,
			affinity: row?.last_worker ?? null,
		};
	}

	/** Replicated workspace registry rows (durable source of truth across workers). */
	async upsertWorkspaceRow(context: TenantContext, ws: { workspaceId: string; relPath: string; name: string; isTemp: boolean }): Promise<void> {
		await this.pool.query(
			`INSERT INTO tenant_workspaces (tenant_id, workspace_id, rel_path, name, is_temp, updated_at)
			 VALUES ($1, $2, $3, $4, $5, NOW())
			 ON CONFLICT (tenant_id, workspace_id)
			 DO UPDATE SET rel_path = EXCLUDED.rel_path, name = EXCLUDED.name,
				is_temp = EXCLUDED.is_temp, updated_at = NOW()`,
			[context.tenantId, ws.workspaceId, ws.relPath, ws.name, ws.isTemp],
		);
	}

	async getWorkspaceRow(context: TenantContext, workspaceId: string): Promise<{ workspaceId: string; relPath: string; name: string; isTemp: boolean; createdAt: string; updatedAt: string } | null> {
		const rows = await this.pool.query(
			`SELECT workspace_id, rel_path, name, is_temp,
				 created_at::text AS created_at, updated_at::text AS updated_at
			 FROM tenant_workspaces WHERE tenant_id = $1 AND workspace_id = $2`,
			[context.tenantId, workspaceId],
		);
		const row = rows.rows[0];
		return row ? {
			workspaceId: row.workspace_id, relPath: row.rel_path, name: row.name,
			isTemp: row.is_temp, createdAt: row.created_at, updatedAt: row.updated_at,
		} : null;
	}

	async deleteWorkspaceRow(context: TenantContext, workspaceId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM tenant_workspaces WHERE tenant_id = $1 AND workspace_id = $2",
			[context.tenantId, workspaceId],
		);
		await this.pool.query(
			"DELETE FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2",
			[context.tenantId, workspaceId],
		);
		await this.pool.query(
			"DELETE FROM session_workspaces WHERE tenant_id = $1 AND workspace_id = $2",
			[context.tenantId, workspaceId],
		);
	}

	/** Replicated session→workspace bindings (the local session map is a cache). */
	async setSessionWorkspace(context: TenantContext, sessionId: string, workspaceId: string): Promise<void> {
		await this.pool.query(
			`INSERT INTO session_workspaces (tenant_id, session_id, workspace_id, updated_at)
			 VALUES ($1, $2, $3, NOW())
			 ON CONFLICT (tenant_id, session_id)
			 DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = NOW()`,
			[context.tenantId, sessionId, workspaceId],
		);
	}

	async getSessionWorkspace(context: TenantContext, sessionId: string): Promise<string | null> {
		const rows = await this.pool.query<{ workspace_id: string }>(
			"SELECT workspace_id FROM session_workspaces WHERE tenant_id = $1 AND session_id = $2",
			[context.tenantId, sessionId],
		);
		return rows.rows[0]?.workspace_id ?? null;
	}

	async deleteSessionWorkspace(context: TenantContext, sessionId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM session_workspaces WHERE tenant_id = $1 AND session_id = $2",
			[context.tenantId, sessionId],
		);
	}

	/** The remote file listing for one workspace replica. */
	async listWorkspaceFiles(context: TenantContext, workspaceId: string): Promise<WorkspaceFileRow[]> {
		const rows = await this.pool.query<{ rel_path: string; kind: string; size: string; mtime_ms: string }>(
			"SELECT rel_path, kind, size, mtime_ms FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2",
			[context.tenantId, workspaceId],
		);
		return rows.rows.map((row) => ({
			relPath: row.rel_path,
			kind: row.kind === "directory" ? "directory" : "file",
			size: Number(row.size),
			mtimeMs: Number(row.mtime_ms),
		}));
	}

	/** One manifest row, or null. */
	async getWorkspaceFile(context: TenantContext, workspaceId: string, relPath: string): Promise<WorkspaceFileRow | null> {
		const rows = await this.pool.query<{ rel_path: string; kind: string; size: string; mtime_ms: string }>(
			"SELECT rel_path, kind, size, mtime_ms FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2 AND rel_path = $3",
			[context.tenantId, workspaceId, relPath],
		);
		const row = rows.rows[0];
		return row ? {
			relPath: row.rel_path,
			kind: row.kind === "directory" ? "directory" : "file",
			size: Number(row.size),
			mtimeMs: Number(row.mtime_ms),
		} : null;
	}

	/**
	 * Manifest rows whose rel_path equals `prefix` or sits under `prefix + "/"`,
	 * in rel_path order, capped at `limit` rows. `""` lists the whole workspace.
	 */
	async listWorkspaceFilesUnder(
		context: TenantContext,
		workspaceId: string,
		prefix: string,
		limit: number,
	): Promise<WorkspaceFileRow[]> {
		const rows = await this.pool.query<{ rel_path: string; kind: string; size: string; mtime_ms: string }>(
			`SELECT rel_path, kind, size, mtime_ms FROM workspace_files
			 WHERE tenant_id = $1 AND workspace_id = $2 AND starts_with(rel_path, $3)
			 ORDER BY rel_path LIMIT $4`,
			[context.tenantId, workspaceId, prefix, limit],
		);
		return rows.rows.map((row) => ({
			relPath: row.rel_path,
			kind: row.kind === "directory" ? "directory" : "file",
			size: Number(row.size),
			mtimeMs: Number(row.mtime_ms),
		}));
	}

	/**
	 * Cheap existence/mtime probe under `prefix` (`""` = whole workspace):
	 * whether any descendant row exists and the newest mtime among them,
	 * without materializing the rows.
	 */
	async summarizeWorkspacePrefix(
		context: TenantContext,
		workspaceId: string,
		prefix: string,
	): Promise<{ count: number; maxMtimeMs: number }> {
		const rows = await this.pool.query<{ count: string; max_mtime_ms: string | null }>(
			`SELECT COUNT(*)::text AS count, MAX(mtime_ms)::text AS max_mtime_ms
			 FROM workspace_files
			 WHERE tenant_id = $1 AND workspace_id = $2 AND starts_with(rel_path, $3)`,
			[context.tenantId, workspaceId, prefix],
		);
		const row = rows.rows[0];
		return { count: Number(row?.count ?? 0), maxMtimeMs: Number(row?.max_mtime_ms ?? 0) };
	}

	/** Upsert one manifest row (file or directory). */
	async putWorkspaceFile(context: TenantContext, workspaceId: string, row: WorkspaceFileRow): Promise<void> {
		await this.pool.query(
			`INSERT INTO workspace_files (tenant_id, workspace_id, rel_path, kind, size, mtime_ms, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW())
			 ON CONFLICT (tenant_id, workspace_id, rel_path)
			 DO UPDATE SET kind = EXCLUDED.kind, size = EXCLUDED.size,
				mtime_ms = EXCLUDED.mtime_ms, updated_at = NOW()`,
			[context.tenantId, workspaceId, row.relPath, row.kind, row.size, row.mtimeMs],
		);
	}

	/**
	 * Delete the row at `path` plus, when `descendants`, every row under
	 * `path + "/"`, in one transaction. Returns the removed rows so callers can
	 * clean up file objects afterwards.
	 */
	async deleteWorkspaceFiles(
		context: TenantContext,
		workspaceId: string,
		path: string,
		descendants: boolean,
	): Promise<WorkspaceFileRow[]> {
		const client = await this.pool.connect();
		try {
			return await withTenantTransaction(client, async () => {
				const removed = await client.query<{ rel_path: string; kind: string; size: string; mtime_ms: string }>(
					`DELETE FROM workspace_files
					 WHERE tenant_id = $1 AND workspace_id = $2
					   AND (rel_path = $3 OR ($4 AND starts_with(rel_path, $5)))
					 RETURNING rel_path, kind, size, mtime_ms`,
					[context.tenantId, workspaceId, path, descendants, path === "" ? "" : `${path}/`],
				);
				return removed.rows.map((row) => ({
					relPath: row.rel_path,
					kind: row.kind === "directory" ? "directory" as const : "file" as const,
					size: Number(row.size),
					mtimeMs: Number(row.mtime_ms),
				}));
			});
		} finally {
			client.release();
		}
	}

	/**
	 * Rewrite a path subtree to a new prefix in ONE transaction: the row at
	 * `from` and every `from + "/"` descendant becomes `to` / `to + "/…"`.
	 * Throws `WorkspaceStoreError("exists")` when the destination path or a
	 * descendant of it already has a row, and a plain Error when the source
	 * subtree changed underneath (moved count mismatch).
	 */
	async moveWorkspaceFiles(
		context: TenantContext,
		workspaceId: string,
		from: string,
		to: string,
	): Promise<WorkspaceFileRow[]> {
		const client = await this.pool.connect();
		try {
			return await withTenantTransaction(client, async () => {
				const conflicts = await client.query(
					`SELECT 1 FROM workspace_files
					 WHERE tenant_id = $1 AND workspace_id = $2
					   AND (rel_path = $3 OR starts_with(rel_path, $4)) LIMIT 1`,
					[context.tenantId, workspaceId, to, `${to}/`],
				);
				if ((conflicts.rowCount ?? 0) > 0) {
					throw new WorkspaceStoreError("exists", `destination exists: ${to}`, to);
				}
				const source = await client.query<{ rel_path: string; kind: string; size: string; mtime_ms: string }>(
					`SELECT rel_path, kind, size, mtime_ms FROM workspace_files
					 WHERE tenant_id = $1 AND workspace_id = $2
					   AND (rel_path = $3 OR starts_with(rel_path, $4))
					 FOR UPDATE`,
					[context.tenantId, workspaceId, from, `${from}/`],
				);
				if (source.rows.length === 0) return [];
				const moved: WorkspaceFileRow[] = source.rows.map((row) => ({
					relPath: row.rel_path,
					kind: row.kind === "directory" ? "directory" : "file",
					size: Number(row.size),
					mtimeMs: Number(row.mtime_ms),
				}));
				await client.query(
					`DELETE FROM workspace_files
					 WHERE tenant_id = $1 AND workspace_id = $2
					   AND (rel_path = $3 OR starts_with(rel_path, $4))`,
					[context.tenantId, workspaceId, from, `${from}/`],
				);
				await client.query(
					`INSERT INTO workspace_files (tenant_id, workspace_id, rel_path, kind, size, mtime_ms, updated_at)
					 SELECT $1, $2, rel_path, kind, size, mtime_ms, NOW()
					 FROM unnest($3::text[], $4::text[], $5::bigint[], $6::double precision[]) AS t(rel_path, kind, size, mtime_ms)`,
					[
						context.tenantId, workspaceId,
						moved.map((row) => to + row.relPath.slice(from.length)),
						moved.map((row) => row.kind),
						moved.map((row) => row.size),
						moved.map((row) => row.mtimeMs),
					],
				);
				return moved;
			});
		} finally {
			client.release();
		}
	}

	/** Drop every manifest row of the workspace. */
	async deleteAllWorkspaceFiles(context: TenantContext, workspaceId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2",
			[context.tenantId, workspaceId],
		);
	}

	/**
	 * Apply one push diff: upsert present files and delete vanished ones in a
	 * single transaction so the remote listing never observes a half-applied sync.
	 */
	async syncWorkspaceFiles(
		context: TenantContext,
		workspaceId: string,
		upserts: Array<{ relPath: string; size: number; mtimeMs: number; kind?: WorkspaceFileKind }>,
		deletes: string[],
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await withTenantTransaction(client, async () => {
				if (upserts.length > 0) {
					await client.query(
						`INSERT INTO workspace_files (tenant_id, workspace_id, rel_path, kind, size, mtime_ms, updated_at)
						 SELECT $1, $2, rel_path, kind, size, mtime_ms, NOW()
						 FROM unnest($3::text[], $4::text[], $5::bigint[], $6::double precision[]) AS t(rel_path, kind, size, mtime_ms)
						 ON CONFLICT (tenant_id, workspace_id, rel_path)
						 DO UPDATE SET kind = EXCLUDED.kind, size = EXCLUDED.size,
							mtime_ms = EXCLUDED.mtime_ms, updated_at = NOW()`,
						[
							context.tenantId, workspaceId,
							upserts.map((f) => f.relPath),
							upserts.map((f) => f.kind ?? "file"),
							upserts.map((f) => f.size),
							upserts.map((f) => f.mtimeMs),
						],
					);
				}
				if (deletes.length > 0) {
					await client.query(
						"DELETE FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2 AND rel_path = ANY($3::text[])",
						[context.tenantId, workspaceId, deletes],
					);
				}
			});
		} finally {
			client.release();
		}
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
