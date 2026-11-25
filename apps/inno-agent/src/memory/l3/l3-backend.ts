import type { L3Chunk, L3SearchHit, L3Store } from "./sqlite-store.js";

export interface L3IndexState {
	lastOffset: number;
	/** The committed entry revision the session was last indexed at. */
	lastMtimeMs: number;
	chunkCount: number;
}

/**
 * Where indexed conversation chunks live and are searched. The recall and
 * indexing logic only needs these operations, so a local SQLite file and a
 * tenant-scoped PostgreSQL table are interchangeable behind it.
 */
export interface L3Backend {
	/** Lexical candidates, most relevant first; `bm25` is negative-is-better like FTS5's. */
	searchLexical(query: string, limit: number): Promise<L3SearchHit[]>;
	getIndexState(sessionId: string): Promise<L3IndexState | null>;
	/** Replace a session's chunks and its index state as one atomic step. */
	replaceSession(sessionId: string, chunks: L3Chunk[], state: { lastOffset: number; revision: number }): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	close(): void;
}

/** The local `node:sqlite` store as a {@link L3Backend}. */
export class SqliteL3Backend implements L3Backend {
	constructor(private readonly store: L3Store) {}

	async searchLexical(query: string, limit: number): Promise<L3SearchHit[]> {
		return this.store.searchLexical(query, limit);
	}

	async getIndexState(sessionId: string): Promise<L3IndexState | null> {
		return this.store.getIndexState(sessionId);
	}

	async replaceSession(sessionId: string, chunks: L3Chunk[], state: { lastOffset: number; revision: number }): Promise<void> {
		this.store.deleteSession(sessionId);
		if (chunks.length > 0) this.store.upsertChunks(chunks);
		this.store.setIndexState(sessionId, state.lastOffset, state.revision, chunks.length);
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.store.deleteSession(sessionId);
	}

	close(): void {
		this.store.close();
	}
}
