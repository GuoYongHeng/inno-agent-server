import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Pool } from "pg";
import type { ObjectStore } from "../object-store/object-store.js";
import { tenantObjectKey, tenantObjectPrefix } from "../object-store/object-store.js";
import {
	outboxSessionId,
	type ChannelOutbox,
	type ChannelOutboxCompletion,
	type ChannelOutboxRecord,
	type OutboxPayload,
} from "./channel-outbox.js";

/** A snapshot larger than this is refused before upload. */
export const MAX_OUTBOX_PAYLOAD_BYTES = 100 * 1024 * 1024;

const KIND = "outbox";

function keyOf(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

/** Deterministic object-store key for an outbox payload (tenant + session + op hash). */
export function outboxObjectKey(tenantId: string, operationId: string): string {
	return tenantObjectKey(tenantId, "outbox", outboxSessionId(operationId), keyOf(operationId));
}

/**
 * Tenant-scoped channel outbox: intent / completion live in `recovery_records`;
 * the file snapshot lives in the platform ObjectStore under
 * `tenants/<tenant>/outbox/<session>/<opHash>`. Binary payloads never enter
 * PostgreSQL. Put-then-record leaves a rare orphan object on a failed insert
 * (best-effort delete); record-without-object fails closed on resume.
 */
export class PgChannelOutbox implements ChannelOutbox {
	constructor(
		private readonly pool: Pool,
		private readonly tenantId: string,
		private readonly objects: ObjectStore,
	) {}

	async load(operationId: string): Promise<ChannelOutboxRecord | undefined> {
		const sessionId = outboxSessionId(operationId);
		const result = await this.pool.query<{ value: ChannelOutboxRecord }>(
			"SELECT value FROM recovery_records WHERE tenant_id = $1 AND session_id = $2 AND kind = $3 AND record_key = $4",
			[this.tenantId, sessionId, KIND, keyOf(operationId)],
		);
		const record = result.rows[0]?.value;
		if (!record) return undefined;
		if (record.operationId !== operationId || !record.channel || !record.chatId || !record.filePath) {
			throw new Error("Channel outbox record does not match the durable tool call");
		}
		return record;
	}

	private materialize(bytes: Uint8Array): OutboxPayload {
		return { bytes: new Uint8Array(bytes), cleanup() {} };
	}

	async prepare(record: ChannelOutboxRecord, sourceFilePath: string): Promise<OutboxPayload> {
		const sessionId = outboxSessionId(record.operationId);
		if (statSync(sourceFilePath).size > MAX_OUTBOX_PAYLOAD_BYTES) {
			throw new Error(`File is larger than the ${MAX_OUTBOX_PAYLOAD_BYTES / 1024 / 1024} MB outbox limit`);
		}
		const bytes = new Uint8Array(readFileSync(sourceFilePath));
		const objectKey = outboxObjectKey(this.tenantId, record.operationId);
		const recordKey = keyOf(record.operationId);
		await this.objects.put(objectKey, bytes, { contentType: "application/octet-stream" });
		try {
			await this.pool.query(
				`INSERT INTO recovery_records (tenant_id, session_id, kind, record_key, value) VALUES ($1, $2, $3, $4, $5::jsonb)
				 ON CONFLICT (tenant_id, session_id, kind, record_key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
				[this.tenantId, sessionId, KIND, recordKey, JSON.stringify(record)],
			);
		} catch (error) {
			await this.objects.delete(objectKey).catch(() => undefined);
			throw error;
		}
		return this.materialize(bytes);
	}

	async payload(record: ChannelOutboxRecord): Promise<OutboxPayload | undefined> {
		const bytes = await this.objects.get(outboxObjectKey(this.tenantId, record.operationId));
		return bytes ? this.materialize(bytes) : undefined;
	}

	async complete(record: ChannelOutboxRecord, completion: ChannelOutboxCompletion): Promise<void> {
		const sessionId = outboxSessionId(record.operationId);
		await this.pool.query(
			`INSERT INTO recovery_records (tenant_id, session_id, kind, record_key, value) VALUES ($1, $2, $3, $4, $5::jsonb)
			 ON CONFLICT (tenant_id, session_id, kind, record_key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId, sessionId, KIND, keyOf(record.operationId), JSON.stringify({ ...record, completion })],
		);
	}

	async pruneCompletedForIdleSession(sessionId: string, completedBefore: number): Promise<number> {
		const expired = await this.pool.query<{ record_key: string; value: ChannelOutboxRecord }>(
			`DELETE FROM recovery_records
			 WHERE tenant_id = $1 AND session_id = $2 AND kind = $3
			   AND value ? 'completion' AND updated_at <= to_timestamp($4 / 1000.0)
			 RETURNING record_key, value`,
			[this.tenantId, sessionId, KIND, completedBefore],
		);
		for (const row of expired.rows) {
			const operationId = row.value?.operationId;
			if (operationId) {
				await this.objects.delete(outboxObjectKey(this.tenantId, operationId)).catch(() => undefined);
			} else {
				await this.objects.delete(tenantObjectKey(this.tenantId, "outbox", sessionId, row.record_key)).catch(() => undefined);
			}
		}
		return expired.rowCount ?? 0;
	}

	async deleteSession(sessionId: string): Promise<number> {
		const removed = await this.pool.query(
			"DELETE FROM recovery_records WHERE tenant_id = $1 AND session_id = $2 AND kind = $3",
			[this.tenantId, sessionId, KIND],
		);
		await this.objects.deletePrefix(tenantObjectPrefix(this.tenantId, "outbox", sessionId));
		return removed.rowCount ?? 0;
	}
}
