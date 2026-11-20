import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Pool } from "pg";
import { logger } from "../logger.js";
import {
	outboxSessionId,
	type ChannelOutbox,
	type ChannelOutboxCompletion,
	type ChannelOutboxRecord,
	type OutboxPayload,
} from "./channel-outbox.js";

/** A snapshot larger than this is refused: the whole file goes through memory and one row. */
export const MAX_OUTBOX_PAYLOAD_BYTES = 100 * 1024 * 1024;

const KIND = "outbox";

function keyOf(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

/**
 * Tenant-scoped channel outbox in PostgreSQL: the record is a `recovery_records`
 * row and the payload snapshot a `recovery_blobs` row written in the same
 * transaction, so there is never a record without its payload. Any worker can
 * resume an interrupted send. A snapshot is written to a private temporary
 * file only for the duration of the upload.
 *
 * Files from before the move (`legacyDir`, flat and shared by all sessions)
 * are imported per session on first access and then removed.
 */
export class PgChannelOutbox implements ChannelOutbox {
	private readonly imported = new Map<string, Promise<void>>();

	constructor(
		private readonly pool: Pool,
		private readonly tenantId: string,
		private readonly legacyDir?: string,
	) {}

	private async ready(sessionId: string): Promise<void> {
		if (!this.legacyDir) return;
		let pending = this.imported.get(sessionId);
		if (!pending) {
			pending = this.importLegacy(sessionId, this.legacyDir).catch((error) => {
				this.imported.delete(sessionId);
				throw error;
			});
			this.imported.set(sessionId, pending);
		}
		await pending;
	}

	private async importLegacy(sessionId: string, dir: string): Promise<void> {
		if (!existsSync(dir)) return;
		const prefix = `send_file_to_channel:${sessionId}:`;
		const imported: string[] = [];
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
				const base = join(dir, file.slice(0, -5));
				let record: ChannelOutboxRecord;
				try {
					record = JSON.parse(readFileSync(join(dir, file), "utf-8")) as ChannelOutboxRecord;
				} catch (error) {
					logger.error({ err: error, file }, "legacy channel outbox record is unreadable; skipping it");
					continue;
				}
				if (!record.operationId?.startsWith(prefix) || keyOf(record.operationId) !== file.slice(0, -5)) continue;
				const payloadPath = `${base}.payload`;
				const owned = `EXISTS (SELECT 1 FROM resource_ownership WHERE tenant_id = $1 AND resource_type = 'session' AND resource_id = $2)`;
				await client.query(
					`INSERT INTO recovery_records (tenant_id, session_id, kind, record_key, value)
					 SELECT $1, $2, $3, $4, $5::jsonb WHERE ${owned} ON CONFLICT DO NOTHING`,
					[this.tenantId, sessionId, KIND, file.slice(0, -5), JSON.stringify(record)],
				);
				if (existsSync(payloadPath) && statSync(payloadPath).isFile() && statSync(payloadPath).size <= MAX_OUTBOX_PAYLOAD_BYTES) {
					await client.query(
						`INSERT INTO recovery_blobs (tenant_id, session_id, kind, record_key, payload)
						 SELECT $1, $2, $3, $4, $5 WHERE ${owned} ON CONFLICT DO NOTHING`,
						[this.tenantId, sessionId, KIND, file.slice(0, -5), readFileSync(payloadPath)],
					);
				}
				imported.push(join(dir, file), payloadPath);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
		for (const path of imported) rmSync(path, { force: true });
	}

	async load(operationId: string): Promise<ChannelOutboxRecord | undefined> {
		const sessionId = outboxSessionId(operationId);
		await this.ready(sessionId);
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

	private materialize(record: ChannelOutboxRecord, bytes: Buffer): OutboxPayload {
		const dir = mkdtempSync(join(tmpdir(), "inno-outbox-"));
		const path = join(dir, basename(record.fileName ?? record.filePath) || "file");
		writeFileSync(path, bytes, { mode: 0o600 });
		return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
	}

	async prepare(record: ChannelOutboxRecord, sourceFilePath: string): Promise<OutboxPayload> {
		const sessionId = outboxSessionId(record.operationId);
		await this.ready(sessionId);
		if (statSync(sourceFilePath).size > MAX_OUTBOX_PAYLOAD_BYTES) {
			throw new Error(`File is larger than the ${MAX_OUTBOX_PAYLOAD_BYTES / 1024 / 1024} MB outbox limit`);
		}
		const bytes = readFileSync(sourceFilePath);
		const key = keyOf(record.operationId);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`INSERT INTO recovery_blobs (tenant_id, session_id, kind, record_key, payload) VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (tenant_id, session_id, kind, record_key) DO UPDATE SET payload = EXCLUDED.payload`,
				[this.tenantId, sessionId, KIND, key, bytes],
			);
			await client.query(
				`INSERT INTO recovery_records (tenant_id, session_id, kind, record_key, value) VALUES ($1, $2, $3, $4, $5::jsonb)
				 ON CONFLICT (tenant_id, session_id, kind, record_key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
				[this.tenantId, sessionId, KIND, key, JSON.stringify(record)],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
		return this.materialize(record, bytes);
	}

	async payload(record: ChannelOutboxRecord): Promise<OutboxPayload | undefined> {
		const sessionId = outboxSessionId(record.operationId);
		await this.ready(sessionId);
		const result = await this.pool.query<{ payload: Buffer }>(
			"SELECT payload FROM recovery_blobs WHERE tenant_id = $1 AND session_id = $2 AND kind = $3 AND record_key = $4",
			[this.tenantId, sessionId, KIND, keyOf(record.operationId)],
		);
		const bytes = result.rows[0]?.payload;
		return bytes ? this.materialize(record, bytes) : undefined;
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
		await this.ready(sessionId);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const expired = await client.query<{ record_key: string }>(
				`DELETE FROM recovery_records
				 WHERE tenant_id = $1 AND session_id = $2 AND kind = $3
				   AND value ? 'completion' AND updated_at <= to_timestamp($4 / 1000.0)
				 RETURNING record_key`,
				[this.tenantId, sessionId, KIND, completedBefore],
			);
			if (expired.rowCount) {
				await client.query(
					"DELETE FROM recovery_blobs WHERE tenant_id = $1 AND session_id = $2 AND kind = $3 AND record_key = ANY($4::text[])",
					[this.tenantId, sessionId, KIND, expired.rows.map((row) => row.record_key)],
				);
			}
			await client.query("COMMIT");
			return expired.rowCount ?? 0;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async deleteSession(sessionId: string): Promise<number> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const removed = await client.query(
				"DELETE FROM recovery_records WHERE tenant_id = $1 AND session_id = $2 AND kind = $3",
				[this.tenantId, sessionId, KIND],
			);
			await client.query("DELETE FROM recovery_blobs WHERE tenant_id = $1 AND session_id = $2 AND kind = $3", [this.tenantId, sessionId, KIND]);
			await client.query("COMMIT");
			return removed.rowCount ?? 0;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
