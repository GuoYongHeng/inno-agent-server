import type { SubmissionId, UserInput } from "@earendil-works/pi-durable";
import type { Pool } from "pg";
import type { SessionStreamState, StreamEventEnvelope, StreamStateSnapshot } from "../chat/stream-registry.js";
import { snapshotStreamState } from "../chat/stream-registry.js";
import { logger } from "../logger.js";
import {
	TERMINAL_RETENTION_MS,
	type RestoredDurableStream,
	type StreamJournal,
} from "./durable-stream-store.js";
import { withoutNul } from "./recovery-store.js";

const TERMINAL_TYPES = new Set(["done", "error", "aborted"]);
const DURABLE_ID_PATTERN = /^durable-[0-9a-f-]{36}$/;
const TURN_ID_PATTERN = /^[0-9a-f-]{36}$/;

function validIds(sessionId: string, turnId?: string): boolean {
	return DURABLE_ID_PATTERN.test(sessionId) && (!turnId || TURN_ID_PATTERN.test(turnId));
}

const json = (value: unknown) => withoutNul(JSON.stringify(value));

interface TurnRow {
	header: StreamStateSnapshot;
	input: UserInput;
	submission_id: string | null;
	cancel_requested: boolean;
	finished_at: Date | null;
}

/**
 * Tenant-scoped SSE journal in PostgreSQL. Events are buffered and written in
 * one multi-row insert per flush, in order, so a fast model stream costs a
 * handful of statements rather than one per token. Any worker can replay a
 * turn another worker started. Finished turns stay replayable for five minutes
 * and are deleted the next time the session starts a turn or the turn is read.
 */
export class PgStreamJournal implements StreamJournal {
	private buffer: Array<{ envelope: StreamEventEnvelope }> = [];
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly pool: Pool,
		private readonly tenantId: string,
		private readonly retentionMs = TERMINAL_RETENTION_MS,
	) {}

	async create(state: SessionStreamState, input: UserInput): Promise<void> {
		if (!validIds(state.sessionId, state.turnId)) throw new Error("Invalid durable stream identity");
		// Drop this session's expired turns first; nothing else bounds the table.
		await this.pool.query(
			`DELETE FROM stream_turns WHERE tenant_id = $1 AND session_id = $2
			 AND finished_at IS NOT NULL AND finished_at < CURRENT_TIMESTAMP - ($3 || ' milliseconds')::interval`,
			[this.tenantId, state.sessionId, String(this.retentionMs)],
		);
		const result = await this.pool.query(
			`INSERT INTO stream_turns (tenant_id, session_id, turn_id, header, input)
			 SELECT $1, $2, $3, $4::jsonb, $5::jsonb
			 WHERE EXISTS (SELECT 1 FROM resource_ownership WHERE tenant_id = $1 AND resource_type = 'session' AND resource_id = $2)
			 ON CONFLICT DO NOTHING`,
			[this.tenantId, state.sessionId, state.turnId, json(snapshotStreamState(state)), json(input)],
		);
		// A client-supplied turn identity must never overwrite an existing journal.
		if (result.rowCount !== 1) throw new Error("Durable stream journal already exists or the session is not owned by this tenant");
	}

	append(envelope: StreamEventEnvelope): void {
		this.buffer.push({ envelope });
		this.tail = this.tail.then(() => this.drain()).catch((error) => {
			// Observability/disk failures must not turn a healthy model run into a failed response.
			logger.error({ err: error, sessionId: envelope.sessionId, turnId: envelope.turnId }, "durable SSE journal append failed");
		});
	}

	private async drain(): Promise<void> {
		const batch = this.buffer;
		if (batch.length === 0) return;
		this.buffer = [];
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			for (let start = 0; start < batch.length; start += 500) {
				const chunk = batch.slice(start, start + 500);
				const values: unknown[] = [this.tenantId];
				const rows = chunk.map(({ envelope }) => {
					values.push(envelope.sessionId, envelope.turnId, json(envelope));
					const n = values.length;
					return `($1, $${n - 2}, $${n - 1}, $${n}::jsonb)`;
				});
				await client.query(`INSERT INTO stream_events (tenant_id, session_id, turn_id, envelope) VALUES ${rows.join(", ")}`, values);
			}
			for (const finished of new Map(batch
				.filter(({ envelope }) => TERMINAL_TYPES.has(envelope.event.type))
				.map(({ envelope }) => [`${envelope.sessionId}/${envelope.turnId}`, envelope])).values()) {
				await client.query(
					"UPDATE stream_turns SET finished_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND session_id = $2 AND turn_id = $3 AND finished_at IS NULL",
					[this.tenantId, finished.sessionId, finished.turnId],
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	flush(): Promise<void> {
		return this.tail;
	}

	async markAdmitted(sessionId: string, turnId: string, submissionId: SubmissionId): Promise<void> {
		await this.flush();
		await this.pool.query(
			"UPDATE stream_turns SET submission_id = $4 WHERE tenant_id = $1 AND session_id = $2 AND turn_id = $3",
			[this.tenantId, sessionId, turnId, submissionId],
		);
	}

	async markCancelled(sessionId: string, turnId: string): Promise<void> {
		await this.flush();
		await this.pool.query(
			"UPDATE stream_turns SET cancel_requested = true WHERE tenant_id = $1 AND session_id = $2 AND turn_id = $3",
			[this.tenantId, sessionId, turnId],
		);
	}

	async load(sessionId: string, turnId: string): Promise<RestoredDurableStream | undefined> {
		if (!validIds(sessionId, turnId)) return undefined;
		await this.flush();
		const turn = await this.pool.query<TurnRow>(
			"SELECT header, input, submission_id, cancel_requested, finished_at FROM stream_turns WHERE tenant_id = $1 AND session_id = $2 AND turn_id = $3",
			[this.tenantId, sessionId, turnId],
		);
		const row = turn.rows[0];
		if (!row) return undefined;
		if (row.finished_at && Date.now() - row.finished_at.getTime() >= this.retentionMs) {
			await this.pool.query("DELETE FROM stream_turns WHERE tenant_id = $1 AND session_id = $2 AND turn_id = $3", [this.tenantId, sessionId, turnId]);
			return undefined;
		}
		const events = await this.pool.query<{ envelope: StreamEventEnvelope }>(
			"SELECT envelope FROM stream_events WHERE tenant_id = $1 AND session_id = $2 AND turn_id = $3 ORDER BY id",
			[this.tenantId, sessionId, turnId],
		);
		const history = events.rows.map((event) => event.envelope);
		return {
			snapshot: row.header,
			history,
			input: row.input,
			...(row.submission_id !== null ? { submissionId: Number(row.submission_id) as SubmissionId } : {}),
			cancelRequested: row.cancel_requested,
			terminal: history.some((envelope) => TERMINAL_TYPES.has(envelope.event.type)),
		};
	}

	async latest(sessionId: string): Promise<RestoredDurableStream | undefined> {
		if (!validIds(sessionId)) return undefined;
		const turn = await this.pool.query<{ turn_id: string }>(
			"SELECT turn_id FROM stream_turns WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT 1",
			[this.tenantId, sessionId],
		);
		const turnId = turn.rows[0]?.turn_id;
		return turnId ? this.load(sessionId, turnId) : undefined;
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.flush();
		await this.pool.query("DELETE FROM stream_turns WHERE tenant_id = $1 AND session_id = $2", [this.tenantId, sessionId]);
	}
}
