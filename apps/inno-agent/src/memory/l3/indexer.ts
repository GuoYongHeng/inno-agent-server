/**
 * L3 session indexer.
 *
 * Turns a durable session's projected history (user and assistant text only;
 * thinking and tool payloads are left out because they bloat the index and
 * rarely help cross-conversation recall) into retrievable chunks and upserts
 * them into the L3 store.
 *
 * Indexing is incremental: the committed entry revision gates each re-index.
 * Chunk ids are stable (`${sessionId}:${ordinal}`) and upserts are idempotent.
 */

import type { L3Chunk, L3Store } from "./sqlite-store.js";

/** Minimum characters for a chunk to be worth indexing. */
const MIN_CHUNK_CHARS = 8;
/** Cap a single chunk so one huge message can't dominate the index. */
const MAX_CHUNK_CHARS = 4000;

interface ExtractedMessage {
	role: "user" | "assistant";
	text: string;
	ts: number;
}

export interface L3IndexMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

/** Split overly long text into bounded chunks on paragraph/sentence edges. */
function splitLong(text: string): string[] {
	if (text.length <= MAX_CHUNK_CHARS) return [text];
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > MAX_CHUNK_CHARS) {
		// Prefer a break near the limit (newline, then space).
		const window = rest.slice(0, MAX_CHUNK_CHARS);
		const nl = window.lastIndexOf("\n");
		const sp = window.lastIndexOf(" ");
		const cut = nl > MAX_CHUNK_CHARS * 0.6 ? nl : sp > MAX_CHUNK_CHARS * 0.6 ? sp : MAX_CHUNK_CHARS;
		pieces.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) pieces.push(rest);
	return pieces.filter((p) => p.length > 0);
}

function buildChunks(sessionId: string, messages: ExtractedMessage[]): L3Chunk[] {
	const chunks: L3Chunk[] = [];
	let ordinal = 0;
	for (const m of messages) {
		for (const piece of splitLong(m.text)) {
			if (piece.length < MIN_CHUNK_CHARS) {
				ordinal++;
				continue;
			}
			chunks.push({
				id: `${sessionId}:${ordinal}`,
				sessionId,
				role: m.role,
				text: piece,
				ts: m.ts,
			});
			ordinal++;
		}
	}
	return chunks;
}

function replaceSessionChunks(
	store: L3Store,
	sessionId: string,
	messages: ExtractedMessage[],
	revisionOffset: number,
	revision: number,
): number {
	const chunks = buildChunks(sessionId, messages);
	// Re-index cleanly: drop old chunks for this session, then insert current.
	store.deleteSession(sessionId);
	if (chunks.length > 0) store.upsertChunks(chunks);
	store.setIndexState(sessionId, revisionOffset, revision, chunks.length);
	return chunks.length;
}

/** Index an already projected durable history. The committed entry revision is
 * the incremental gate; user-visible projection has already removed hidden
 * attachment/OCR context, thinking, and tool payloads. */
export function indexSessionMessages(
	store: L3Store,
	sessionId: string,
	messages: L3IndexMessage[],
	revision: number,
): number {
	const previous = store.getIndexState(sessionId);
	if (previous?.lastMtimeMs === revision && previous.lastOffset === messages.length) return 0;
	return replaceSessionChunks(store, sessionId, messages.map((message) => ({
		role: message.role,
		text: message.content,
		ts: message.timestamp,
	})), messages.length, revision);
}
