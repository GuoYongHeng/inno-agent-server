import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { requireRequestTenant } from "../tenants/http.js";
import { ResourceOwnershipError, type TenantContext } from "../tenants/store.js";
import { setGauge, timedAsync } from "../utils/metrics.js";
import {
	SessionNotFoundError,
	decodeSessionListCursor,
	encodeSessionListCursor,
	type DurableSessionPatch,
	type DurableSessionRecord,
	type SessionCatalog,
	type SessionCatalogListOptions,
	type SessionCatalogPage,
} from "./session-catalog.js";

export interface SessionRow {
	id: string;
	workspace_id: string;
	name: string;
	provider: string;
	model_id: string;
	origin: "web" | "scheduler";
	archived: boolean;
	message_count: number;
	preview: string;
	topic_generated: boolean | null;
	topic_upgraded: boolean | null;
	conversation_id: string | null;
	sandbox_id: string | null;
	preset_id: string | null;
	created_at: Date;
	updated_at: Date;
}

export const COLUMNS = "id, workspace_id, name, provider, model_id, origin, archived, message_count, preview, topic_generated, topic_upgraded, conversation_id, sandbox_id, preset_id, created_at, updated_at";

/** Patch field -> column. `id` is never patchable and `version` is bumped by every update. */
const PATCH_COLUMNS: Record<keyof DurableSessionPatch, string> = {
	workspaceId: "workspace_id",
	name: "name",
	createdAt: "created_at",
	updatedAt: "updated_at",
	messageCount: "message_count",
	preview: "preview",
	provider: "provider",
	modelId: "model_id",
	topicGenerated: "topic_generated",
	topicUpgraded: "topic_upgraded",
	origin: "origin",
	archived: "archived",
	conversationId: "conversation_id",
	sandboxId: "sandbox_id",
	presetId: "preset_id",
};

export function toRecord(row: SessionRow): DurableSessionRecord {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		messageCount: row.message_count,
		preview: row.preview,
		provider: row.provider,
		modelId: row.model_id,
		origin: row.origin,
		archived: row.archived,
		...(row.topic_generated !== null ? { topicGenerated: row.topic_generated } : {}),
		...(row.topic_upgraded !== null ? { topicUpgraded: row.topic_upgraded } : {}),
		...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
		...(row.sandbox_id !== null ? { sandboxId: row.sandbox_id } : {}),
		...(row.preset_id !== null ? { presetId: row.preset_id } : {}),
	};
}

function requireTenant(req: IncomingMessage): TenantContext {
	const tenant = requireRequestTenant(req);
	if (!tenant) throw new Error("The PostgreSQL session catalog requires a verified tenant");
	return tenant;
}

/**
 * Tenant-scoped session catalog in PostgreSQL. Every statement filters by the
 * verified tenant taken from the request, never from a caller-supplied value.
 * Creating a session writes its ownership row and catalog row in one
 * transaction, so there is no window with an owned-but-unlisted session.
 *
 */
export class PgSessionCatalog implements SessionCatalog {

	constructor(private readonly pool: Pool) {}

	private async ready(req: IncomingMessage): Promise<TenantContext> {
		return requireTenant(req);
	}


	async get(req: IncomingMessage, id: string): Promise<DurableSessionRecord | undefined> {
		const tenant = await this.ready(req);
		const result = await timedAsync("inno_durable_sessions_get_ms", () => this.pool.query<SessionRow>(
			`SELECT ${COLUMNS} FROM durable_sessions WHERE id = $1 AND tenant_id = $2`, [id, tenant.tenantId]));
		return result.rows[0] ? toRecord(result.rows[0]) : undefined;
	}

	async list(req: IncomingMessage): Promise<DurableSessionRecord[]> {
		const tenant = await this.ready(req);
		const result = await timedAsync("inno_durable_sessions_list_ms", () => this.pool.query<SessionRow>(
			`SELECT ${COLUMNS} FROM durable_sessions WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenant.tenantId]));
		setGauge("inno_durable_sessions", result.rowCount ?? result.rows.length);
		return result.rows.map(toRecord);
	}

	async listPage(req: IncomingMessage, options?: SessionCatalogListOptions): Promise<SessionCatalogPage> {
		const tenant = await this.ready(req);
		const limit = options?.limit && options.limit > 0 ? options.limit : 500;
		const values: unknown[] = [tenant.tenantId];
		let where = "tenant_id = $1";
		if (options?.cursor) {
			const cursor = decodeSessionListCursor(options.cursor);
			if (!cursor) throw new Error("Invalid session list cursor");
			values.push(cursor.updatedAt, cursor.id);
			where += " AND (updated_at, id) < ($2::timestamptz, $3)";
		}
		values.push(limit + 1);
		const result = await timedAsync("inno_durable_sessions_list_ms", () => this.pool.query<SessionRow>(
			`SELECT ${COLUMNS} FROM durable_sessions WHERE ${where}
			 ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`, values));
		const records = result.rows.slice(0, limit).map(toRecord);
		const more = result.rows.length > limit;
		return { records, nextCursor: more && records.length > 0 ? encodeSessionListCursor(records[records.length - 1]!) : null };
	}

	async insert(req: IncomingMessage, record: DurableSessionRecord): Promise<void> {
		const tenant = await this.ready(req);
		const client = await this.pool.connect();
		try {
			await timedAsync("inno_durable_sessions_insert_ms", async () => {
			await client.query("BEGIN");
			const member = await client.query(
				"SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [tenant.tenantId, tenant.userId]);
			if (member.rowCount !== 1) throw new ResourceOwnershipError("session", record.id);
			await client.query(
				`INSERT INTO resource_ownership (tenant_id, resource_type, resource_id)
				 VALUES ($1, 'session', $2) ON CONFLICT (resource_type, resource_id) DO NOTHING`,
				[tenant.tenantId, record.id],
			);
			const owner = await client.query<{ tenant_id: string }>(
				"SELECT tenant_id FROM resource_ownership WHERE resource_type = 'session' AND resource_id = $1", [record.id]);
			if (owner.rows[0]?.tenant_id !== tenant.tenantId) throw new ResourceOwnershipError("session", record.id);
			await client.query(
				`INSERT INTO durable_sessions
				   (id, tenant_id, workspace_id, name, provider, model_id, origin, archived, message_count, preview,
				    topic_generated, topic_upgraded, conversation_id, sandbox_id, preset_id, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17::timestamptz)`,
				[
					record.id, tenant.tenantId, record.workspaceId, record.name, record.provider, record.modelId,
					record.origin ?? "web", record.archived, record.messageCount, record.preview,
					record.topicGenerated ?? null, record.topicUpgraded ?? null, record.conversationId ?? null, record.sandboxId ?? null,
					record.presetId ?? null,
					record.createdAt, record.updatedAt,
				],
			);
			await client.query("COMMIT");
			});
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async update(req: IncomingMessage, id: string, patch: DurableSessionPatch): Promise<DurableSessionRecord> {
		const tenant = await this.ready(req);
		const sets: string[] = [];
		const values: unknown[] = [id, tenant.tenantId];
		for (const [key, value] of Object.entries(patch) as Array<[keyof DurableSessionPatch, unknown]>) {
			const column = PATCH_COLUMNS[key];
			if (!column || value === undefined) continue;
			values.push(column === "origin" ? value ?? "web" : value);
			sets.push(`${column} = $${values.length}${column.endsWith("_at") ? "::timestamptz" : ""}`);
		}
		sets.push("version = version + 1");
		const result = await timedAsync("inno_durable_sessions_update_ms", () => this.pool.query<SessionRow>(
			`UPDATE durable_sessions SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING ${COLUMNS}`, values));
		if (!result.rows[0]) throw new SessionNotFoundError();
		return toRecord(result.rows[0]);
	}

	async remove(req: IncomingMessage, id: string): Promise<void> {
		const tenant = await this.ready(req);
		const client = await this.pool.connect();
		try {
			await timedAsync("inno_durable_sessions_remove_ms", async () => {
				await client.query("BEGIN");
				await client.query("DELETE FROM durable_sessions WHERE id = $1 AND tenant_id = $2", [id, tenant.tenantId]);
				await client.query(
					"DELETE FROM resource_ownership WHERE tenant_id = $1 AND resource_type = 'session' AND resource_id = $2",
					[tenant.tenantId, id]);
				await client.query("COMMIT");
			});
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
}
