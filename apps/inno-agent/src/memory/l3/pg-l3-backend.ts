import type { Pool } from "pg";
import type { L3Backend, L3IndexState } from "./l3-backend.js";
import { segmentForFts, type L3Chunk, type L3SearchHit } from "./sqlite-store.js";

/** `text` cannot hold U+0000 in PostgreSQL. */
const clean = (text: string) => text.replaceAll("\0", "�");

/**
 * Tenant-scoped L3 index in PostgreSQL, searched with ParadeDB's BM25 (`pg_search`).
 *
 * Text is segmented exactly as the SQLite index does (CJK bigrams, lowercase
 * ASCII words) and stored in a `tokens` column indexed with the whitespace
 * tokenizer, so index-time and query-time tokens line up without depending on
 * a word-segmentation dictionary, and recall behaves the same on both backends.
 * Every statement is filtered by the tenant fixed at construction.
 *
 * The index is derived from committed history: a session missing its state row
 * is simply re-indexed on its next snapshot, so nothing needs importing.
 */
export class PgL3Backend implements L3Backend {
	constructor(
		private readonly pool: Pool,
		private readonly tenantId: string,
	) {}

	async searchLexical(query: string, limit: number): Promise<L3SearchHit[]> {
		const tokens = segmentForFts(query);
		if (!tokens) return [];
		const result = await this.pool.query<{ id: string; session_id: string; role: string; text: string; ts: string; score: number }>(
			`SELECT id, session_id, role, text, ts, paradedb.score(rowid) AS score
			 FROM l3_chunks
			 WHERE tokens ||| $2 AND tenant_id = $1
			 ORDER BY score DESC
			 LIMIT $3`,
			[this.tenantId, tokens, limit],
		);
		return result.rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			role: row.role === "assistant" ? "assistant" : "user",
			text: row.text,
			ts: Number(row.ts),
			// SQLite's bm25() is negative-is-better; keep that contract for the recall sort.
			bm25: -Number(row.score),
		}));
	}

	async getIndexState(sessionId: string): Promise<L3IndexState | null> {
		const result = await this.pool.query<{ last_offset: number; revision: string; chunk_count: number }>(
			"SELECT last_offset, revision, chunk_count FROM l3_index_state WHERE tenant_id = $1 AND session_id = $2",
			[this.tenantId, sessionId],
		);
		const row = result.rows[0];
		return row ? { lastOffset: row.last_offset, lastMtimeMs: Number(row.revision), chunkCount: row.chunk_count } : null;
	}

	async replaceSession(sessionId: string, chunks: L3Chunk[], state: { lastOffset: number; revision: number }): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("DELETE FROM l3_chunks WHERE tenant_id = $1 AND session_id = $2", [this.tenantId, sessionId]);
			for (let start = 0; start < chunks.length; start += 200) {
				const values: unknown[] = [this.tenantId, sessionId];
				const rows = chunks.slice(start, start + 200).map((chunk) => {
					values.push(chunk.id, chunk.role, clean(chunk.text), segmentForFts(chunk.text), chunk.ts);
					const n = values.length;
					return `($1, $2, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
				});
				await client.query(
					`INSERT INTO l3_chunks (tenant_id, session_id, id, role, text, tokens, ts) VALUES ${rows.join(", ")}`,
					values,
				);
			}
			await client.query(
				`INSERT INTO l3_index_state (tenant_id, session_id, last_offset, revision, chunk_count)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (tenant_id, session_id) DO UPDATE SET
				   last_offset = EXCLUDED.last_offset, revision = EXCLUDED.revision,
				   chunk_count = EXCLUDED.chunk_count, updated_at = CURRENT_TIMESTAMP`,
				[this.tenantId, sessionId, state.lastOffset, state.revision, chunks.length],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("DELETE FROM l3_chunks WHERE tenant_id = $1 AND session_id = $2", [this.tenantId, sessionId]);
			await client.query("DELETE FROM l3_index_state WHERE tenant_id = $1 AND session_id = $2", [this.tenantId, sessionId]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	close(): void {
		// The pool belongs to the tenant store.
	}
}
