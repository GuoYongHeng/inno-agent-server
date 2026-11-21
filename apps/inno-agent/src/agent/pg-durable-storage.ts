import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { apply } from "@earendil-works/chord/delta";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	StorageRequestError,
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentCreate,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type JsonObject,
	type Page,
	type Seq,
	type Storage,
	type StorageWrite,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import type { Pool, QueryResult } from "pg";
import { logger } from "../logger.js";

/**
 * PostgreSQL `Storage` for pi-durable (H4): one session's records live in the
 * shared `ds_*` tables scoped by `session_id`. The SQL is a direct port of
 * pi-durable's `SqliteStorage` (`storage/sqlite/storage.js`); record columns
 * keep its JSON-text representation byte for byte.
 *
 * Ownership is a lease row in `ds_metadata`: `commit()`/`mintId()` only
 * succeed while the bound `lease_epoch` still owns the row, so a stale owner
 * (SIGSTOP-then-resume, partitioned) fails instead of writing — the storage
 * contract's "every error is fatal" then closes its Session, which is the
 * intended fencing behavior. When `leaseEpoch` is omitted the storage is
 * unfenced (single-owner contexts like tests and local tooling).
 */
export class DurableStorageFencedError extends Error {
	constructor(readonly sessionId: string) {
		super(`Durable storage lease lost for session ${sessionId}`);
		this.name = "DurableStorageFencedError";
	}
}

type Executor = {
	query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
};

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value);
// Indexed identities keep pi-durable's JSON encoding so lookups match the SQLite backend exactly.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

const RETRYABLE_CODES = new Set([
	"ECONNRESET", "EPIPE", "ETIMEDOUT",
	"57P01", "57P02", "57P03", // shutdown/crash recovery
	"08000", "08001", "08003", "08004", "08006", "08007", "08P01", // connection class
	"53300", // too many connections
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads have no side effects, so transient connection failures retry inside the method. */
async function withReadRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return await fn();
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (!code || !RETRYABLE_CODES.has(code) || i >= attempts - 1) throw error;
			await sleep(25 * (i + 1));
		}
	}
}

const cursorId = (cursor: Cursor | undefined): number | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) {
		throw new StorageRequestError("Invalid storage cursor");
	}
	return after as unknown as Id<string>;
};

const page = <T extends { id: Id<string> }>(values: T[], limit: number, order: "ascending" | "descending" = "ascending"): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: { after: items.at(-1)!.id as unknown as number, order } };
};

/** Resolve a scan's order and position; a cursor pins the order it was created with. */
function scanStart(
	requested: "ascending" | "descending" | undefined,
	cursor: Cursor | undefined,
	fallback: "ascending" | "descending",
): { order: "ascending" | "descending"; after: number | undefined } {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	}
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) {
		throw new StorageRequestError("Invalid storage cursor");
	}
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
		throw new StorageRequestError("Invalid storage cursor");
	}
	const order = stored ?? fallback;
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	return { order, after };
}

const scanSql = (start: { order: "ascending" | "descending"; after: number | undefined }, placeholder: string) =>
	start.order === "ascending"
		? { clause: `id > ${placeholder}`, param: start.after ?? -1, direction: "ASC" as const }
		: { clause: `id < ${placeholder}`, param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" as const };

const scopeColumns = (scope: DocumentAddress["scope"]) => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId as unknown as number };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId as unknown as number };
	}
};

const addressParts = (address: DocumentAddress | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const addressKey = (address: DocumentAddress | DocumentRecord) => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint) =>
	at === "current"
		? record.retiredAt === undefined
		: record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);

const isCurrentOnly = (record: DocumentRecord) => record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): number | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id as unknown as number;
		case "document.create":
		case "document.copy":
			return write.record.id as unknown as number;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

interface DocumentAction {
	create?: DocumentCreate;
	content?: Extract<StorageWrite, { type: "document.create" | "document.change" }>["content"];
	copy?: { id: DocumentId; at: DocumentPoint };
	retire: boolean;
}

export interface PgDurableStorageOptions {
	/** Bound lease epoch; commits/mints are fenced on it when set. */
	leaseEpoch?: number;
	/** Legacy per-session SQLite file to import once before serving reads. */
	legacySqlitePath?: string;
}

export class PgDurableStorage implements Storage {
	private closed = false;
	private closing: Promise<void> | undefined;
	private admittedReads = 0;
	private readsDrained: (() => void) | undefined;

	private constructor(
		private readonly pool: Pool,
		private readonly sessionId: string,
		private readonly leaseEpoch: number | undefined,
	) {}

	static async open(pool: Pool, sessionId: string, options: PgDurableStorageOptions = {}): Promise<PgDurableStorage> {
		const storage = new PgDurableStorage(pool, sessionId, options.leaseEpoch);
		await storage.ensureMetadata();
		if (options.legacySqlitePath) {
			await storage.importLegacy(options.legacySqlitePath);
		}
		return storage;
	}

	private async ensureMetadata(): Promise<void> {
		await this.pool.query("INSERT INTO ds_metadata (session_id) VALUES ($1) ON CONFLICT DO NOTHING", [this.sessionId]);
	}

	/** The fencing condition appended to ownership-checked writes. */
	private leaseClause(placeholder: string): { clause: string; params: unknown[] } {
		return this.leaseEpoch === undefined
			? { clause: "TRUE", params: [] }
			: { clause: `lease_epoch = ${placeholder}`, params: [this.leaseEpoch] };
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PgDurableStorage is closed");
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const documentActions = this.prepareDocumentActions(writes);
		let candidate = 2;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) candidate = Math.max(candidate, id + 1);
		}
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const lease = this.leaseClause("$3");
			const meta = await client.query<{ committed_seq: string }>(
				`UPDATE ds_metadata
				 SET next_seq = next_seq + 1, next_id = GREATEST(next_id, $2)
				 WHERE session_id = $1 AND ${lease.clause}
				 RETURNING next_seq - 1 AS committed_seq`,
				[this.sessionId, candidate, ...lease.params],
			);
			if (meta.rowCount !== 1) {
				throw new DurableStorageFencedError(this.sessionId);
			}
			const committedSeq = Number(meta.rows[0]!.committed_seq) as Seq;
			await this.checkGlobalIds(client, writes);
			await this.checkDocumentActions(client, documentActions);
			for (const write of writes) {
				await this.applyTableWrite(client, write, committedSeq as unknown as number);
			}
			await this.applyDocumentActions(client, documentActions, committedSeq as unknown as number);
			await client.query("COMMIT");
			return committedSeq;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		const lease = this.leaseClause("$2");
		const result = await withReadRetry(() => this.pool.query<{ minted: string }>(
			`UPDATE ds_metadata SET next_id = next_id + 1
			 WHERE session_id = $1 AND ${lease.clause}
			 RETURNING next_id - 1 AS minted`,
			[this.sessionId, ...lease.params],
		));
		if (result.rowCount !== 1) throw new DurableStorageFencedError(this.sessionId);
		const minted = Number(result.rows[0]!.minted);
		if (!Number.isSafeInteger(minted)) throw new Error("ID space is exhausted");
		return minted as unknown as I;
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const row = await this.get("SELECT record FROM ds_conversations WHERE session_id = $1 AND id = $2", [this.sessionId, id]);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record as string);
	}

	async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start, "$2");
		const clauses = ["session_id = $1", scan.clause];
		const params: unknown[] = [this.sessionId, scan.param];
		if (query.ownerConversationId !== undefined) {
			clauses.push(`owner_conversation_id = $${params.length + 1}`);
			params.push(query.ownerConversationId);
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push(`owner_task_id = $${params.length + 1}`);
			params.push(query.ownerTaskId);
		}
		params.push(limit + 1);
		const rows = await this.all(
			`SELECT record FROM ds_conversations WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`,
			params,
		);
		return page(rows.map((row) => parseJson<ConversationRecord>(row.record as string)), limit, start.order);
	}

	entry(id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
	entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context) {
		return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext as EntryId, context));
	}

	findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, _context: Context) {
		return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context) {
		return this.admitRead(() => this.readEntries(query, limit, cursor));
	}

	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		id: EntryId,
		context?: Context,
	): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
		const entryId = context === undefined ? (idOrConversationId as unknown as number) : (id as unknown as number);
		if (entryId === undefined || typeof entryId !== "number") {
			throw new StorageRequestError("Storage.entry() requires an entry ID");
		}
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = idOrConversationId as unknown as number;
			conversation = await this.readConversation(conversationId);
			if (conversation === undefined) {
				throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			}
		}
		const row = await this.get(
			"SELECT record, commit_seq FROM ds_entries WHERE session_id = $1 AND id = $2",
			[this.sessionId, entryId],
		);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record as string);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at as unknown as number);
				conversation = (await this.readConversation(conversation.parent.conversationId as unknown as number))!;
			}
			if ((entry.id as unknown as number) > upperEntryId) return undefined;
		}
		return { entry, commitSeq: Number(row.commit_seq) as Seq };
	}

	private async readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): Promise<(EntryRecord & { head: EntryId }) | undefined> {
		let conversation = await this.readConversation(conversationId as unknown as number);
		if (conversation === undefined) {
			throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		let upper = atOrBeforeEntryId as unknown as number | undefined;
		while (true) {
			const row = upper === undefined
				? await this.get(
					`SELECT record FROM ds_entries
					 WHERE session_id = $1 AND conversation_id = $2 AND head IS NOT NULL
					 ORDER BY id DESC LIMIT 1`,
					[this.sessionId, conversation.id],
				)
				: await this.get(
					`SELECT record FROM ds_entries
					 WHERE session_id = $1 AND conversation_id = $2 AND head IS NOT NULL AND id <= $3
					 ORDER BY id DESC LIMIT 1`,
					[this.sessionId, conversation.id, upper],
				);
			if (row !== undefined) return parseJson<EntryRecord & { head: EntryId }>(row.record as string);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined
				? conversation.parent.at as unknown as number
				: Math.min(upper, conversation.parent.at as unknown as number);
			conversation = (await this.readConversation(conversation.parent.conversationId as unknown as number))!;
		}
	}

	private async readEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined): Promise<Page<EntryRecord, Cursor>> {
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.readEntriesAscending(query, limit, after);
		let conversation = await this.readConversation(query.conversationId as unknown as number);
		if (conversation === undefined) {
			throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		}
		let upper = query.maxEntryId as unknown as number | undefined;
		if (after !== undefined) {
			upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		}
		const values: EntryRecord[] = [];
		while (true) {
			const clauses = ["session_id = $1", "conversation_id = $2"];
			const params: unknown[] = [this.sessionId, conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push(`id >= $${params.length + 1}`);
				params.push(query.minEntryId);
			}
			if (upper !== undefined) {
				clauses.push(`id <= $${params.length + 1}`);
				params.push(upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.all(
				`SELECT record FROM ds_entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
				params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record as string)));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined
				? conversation.parent.at as unknown as number
				: Math.min(upper, conversation.parent.at as unknown as number);
			if (query.minEntryId !== undefined && upper < (query.minEntryId as unknown as number)) break;
			conversation = (await this.readConversation(conversation.parent.conversationId as unknown as number))!;
		}
		return page(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	private async readEntriesAscending(query: EntryQuery, limit: number, after: number | undefined): Promise<Page<EntryRecord, Cursor>> {
		const segments: { conversationId: number; upper: number | undefined }[] = [];
		let conversation = await this.readConversation(query.conversationId as unknown as number);
		if (conversation === undefined) {
			throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		}
		let upper = query.maxEntryId as unknown as number | undefined;
		while (true) {
			segments.push({ conversationId: conversation.id as unknown as number, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined
				? conversation.parent.at as unknown as number
				: Math.min(upper, conversation.parent.at as unknown as number);
			if (query.minEntryId !== undefined && upper < (query.minEntryId as unknown as number)) break;
			conversation = (await this.readConversation(conversation.parent.conversationId as unknown as number))!;
		}
		let lower = query.minEntryId as unknown as number | undefined;
		if (after !== undefined) {
			lower = Math.max(lower ?? after + 1, after + 1);
		}
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const clauses = ["session_id = $1", "conversation_id = $2"];
			const params: unknown[] = [this.sessionId, segment.conversationId];
			if (lower !== undefined) {
				clauses.push(`id >= $${params.length + 1}`);
				params.push(lower);
			}
			if (segment.upper !== undefined) {
				clauses.push(`id <= $${params.length + 1}`);
				params.push(segment.upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.all(
				`SELECT record FROM ds_entries WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT $${params.length}`,
				params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record as string)));
			if (values.length > limit) break;
		}
		return page(values, limit, "ascending");
	}

	async task(id: TaskId, _context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		this.assertOpen();
		const row = await this.get("SELECT record FROM ds_tasks WHERE session_id = $1 AND id = $2", [this.sessionId, id]);
		return row === undefined ? undefined : parseJson<TaskRecord<JsonValue, JsonValue, JsonValue>>(row.record as string);
	}

	async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start, "$2");
		const clauses = ["session_id = $1", scan.clause];
		const params: unknown[] = [this.sessionId, scan.param];
		if (query.conversationId !== undefined) {
			clauses.push(`conversation_id = $${params.length + 1}`);
			params.push(query.conversationId);
		}
		if (query.kind !== undefined) {
			clauses.push(`kind = $${params.length + 1}`);
			params.push(encodeIndexedString(query.kind));
		}
		if (query.status !== undefined) {
			clauses.push(`status = $${params.length + 1}`);
			params.push(query.status);
		}
		if (query.abortRequested !== undefined) {
			clauses.push(`abort_requested = $${params.length + 1}`);
			params.push(query.abortRequested);
		}
		if (query.background !== undefined) {
			clauses.push(`background = $${params.length + 1}`);
			params.push(query.background);
		}
		params.push(limit + 1);
		const rows = await this.all(
			`SELECT record FROM ds_tasks WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`,
			params,
		);
		return page(rows.map((row) => parseJson<TaskRecord<JsonValue, JsonValue, JsonValue>>(row.record as string)), limit, start.order);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.get("SELECT record FROM ds_submissions WHERE session_id = $1 AND id = $2", [this.sessionId, id]);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record as string);
	}

	async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start, "$2");
		const clauses = ["session_id = $1", scan.clause];
		const params: unknown[] = [this.sessionId, scan.param];
		if (query.conversationId !== undefined) {
			clauses.push(`conversation_id = $${params.length + 1}`);
			params.push(query.conversationId);
		}
		if (query.status !== undefined) {
			clauses.push(`status = $${params.length + 1}`);
			params.push(query.status);
		}
		params.push(limit + 1);
		const rows = await this.all(
			`SELECT record FROM ds_submissions WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`,
			params,
		);
		return page(rows.map((row) => parseJson<SubmissionRecord>(row.record as string)), limit, start.order);
	}

	async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.get(
			"SELECT record FROM ds_submissions WHERE session_id = $1 AND conversation_id = $2 AND request_id = $3",
			[this.sessionId, conversationId, encodeIndexedString(requestId)],
		);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record as string);
	}

	async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const parts = addressParts(address);
		const params: unknown[] = [this.sessionId, parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
		const sql = at === "current"
			? `SELECT record FROM ds_documents
				WHERE session_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6
				AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
			: `SELECT record FROM ds_documents
				WHERE session_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6
				AND created_at <= $7 AND (retired_at IS NULL OR retired_at > $8)
				ORDER BY created_at DESC LIMIT 1`;
		if (at !== "current") params.push(at, at);
		const row = await this.get(sql, params);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record as string);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		// The record and revision queries must observe one committed state; a commit
		// between them can replace the base, so pin a repeatable-read snapshot.
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
			const stored = await this.materializeDocument(client, id, at);
			await client.query("COMMIT");
			return stored;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const scope = scopeColumns(query.scope);
		const clauses = ["session_id = $1", "scope_kind = $2", "owner_id = $3", "id > $4"];
		const params: unknown[] = [this.sessionId, scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
		if (query.kind !== undefined) {
			clauses.push(`kind = $${params.length + 1}`);
			params.push(encodeIndexedString(query.kind));
		}
		if (query.at === "current") {
			clauses.push("retired_at IS NULL");
		} else {
			clauses.push(`created_at <= $${params.length + 1}`, `(retired_at IS NULL OR retired_at > $${params.length + 2})`);
			params.push(query.at, query.at);
		}
		params.push(limit + 1);
		const rows = await this.all(
			`SELECT record FROM ds_documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
			params,
		);
		return page(rows.map((row) => parseJson<DocumentRecord>(row.record as string)), limit);
	}

	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.drainReads();
		}
		return this.closing;
	}

	private async drainReads(): Promise<void> {
		if (this.admittedReads > 0) {
			await new Promise<void>((resolve) => {
				this.readsDrained = resolve;
			});
		}
		// The pool is shared; closing only detaches this session's storage view.
	}

	/**
	 * Run a read that issues several queries. Close waits for admitted reads, so
	 * their later queries never observe a closed storage.
	 */
	private async admitRead<T>(read: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.admittedReads++;
		try {
			return await read();
		} finally {
			if (--this.admittedReads === 0) this.readsDrained?.();
		}
	}

	private get(text: string, params: readonly unknown[]): Promise<QueryResult["rows"][number] | undefined> {
		return withReadRetry(async () => (await this.pool.query(text, params as unknown[])).rows[0]);
	}

	private all(text: string, params: readonly unknown[]): Promise<QueryResult["rows"]> {
		return withReadRetry(async () => (await this.pool.query(text, params as unknown[])).rows);
	}

	private async readConversation(id: number): Promise<ConversationRecord | undefined> {
		const row = await this.get("SELECT record FROM ds_conversations WHERE session_id = $1 AND id = $2", [this.sessionId, id]);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record as string);
	}

	private async materializeDocument(executor: Executor, id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
		const row = (await executor.query(
			"SELECT record FROM ds_documents WHERE session_id = $1 AND id = $2",
			[this.sessionId, id],
		)).rows[0];
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record as string);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = (await executor.query(
			`SELECT seq, kind, version, content FROM ds_document_revisions
			 WHERE session_id = $1 AND document_id = $2 AND kind = 'base' AND seq <= $3
			 ORDER BY seq DESC LIMIT 1`,
			[this.sessionId, id, upper],
		)).rows[0];
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content as string);
		const tail = (await executor.query(
			`SELECT seq, kind, version, content FROM ds_document_revisions
			 WHERE session_id = $1 AND document_id = $2 AND seq > $3 AND seq <= $4
			 ORDER BY seq`,
			[this.sessionId, id, Number(base.seq), upper],
		)).rows;
		for (const revision of tail) {
			if (revision.kind !== "delta" || Number(revision.version) !== Number(base.version)) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, parseJson<readonly never[]>(revision.content as string)) as JsonObject;
		}
		return { record, version: Number(base.version), value, deltasSinceBase: tail.length };
	}

	private async checkGlobalIds(executor: Executor, writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<number, string>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table = document ? "document" : write.type;
			const id = (document ? write.record.id : write.value.id) as unknown as number;
			const existing = (await executor.query(
				"SELECT record_type FROM ds_record_ids WHERE session_id = $1 AND id = $2",
				[this.sessionId, id],
			)).rows[0]?.record_type as string | undefined;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<number, DocumentAction> {
		const actions = new Map<number, DocumentAction>();
		for (const write of writes) {
			if (write.type !== "document.create"
				&& write.type !== "document.copy"
				&& write.type !== "document.change"
				&& write.type !== "document.retire") {
				continue;
			}
			const id = (write.type === "document.create" || write.type === "document.copy"
				? write.record.id
				: write.id) as unknown as number;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	private async checkDocumentActions(executor: Executor, actions: Map<number, DocumentAction>): Promise<void> {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id as unknown as number)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const row = (await executor.query(
				"SELECT record FROM ds_documents WHERE session_id = $1 AND id = $2",
				[this.sessionId, id],
			)).rows[0];
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record as string);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = (await executor.query(
					`SELECT version FROM ds_document_revisions
					 WHERE session_id = $1 AND document_id = $2 ORDER BY seq DESC LIMIT 1`,
					[this.sessionId, id],
				)).rows[0];
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (Number(previous.version) !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) {
				live = (await this.currentDocumentId(executor, record)) === undefined ? 0 : 1;
			}
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	private async currentDocumentId(executor: Executor, address: DocumentAddress | DocumentRecord): Promise<number | undefined> {
		const parts = addressParts(address);
		const id = (await executor.query(
			`SELECT id FROM ds_documents
			 WHERE session_id = $1 AND kind = $2 AND scope_kind = $3 AND owner_id = $4 AND family = $5 AND key_value = $6
			 AND retired_at IS NULL LIMIT 1`,
			[this.sessionId, parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue],
		)).rows[0]?.id;
		return id === undefined ? undefined : Number(id);
	}

	private async applyTableWrite(executor: Executor, write: StorageWrite, seq: number): Promise<void> {
		switch (write.type) {
			case "conversation":
				await this.claimId(executor, write.value.id as unknown as number, "conversation");
				await executor.query(
					`INSERT INTO ds_conversations (session_id, id, owner_conversation_id, owner_task_id, record)
					 VALUES ($1, $2, $3, $4, $5)`,
					[this.sessionId, write.value.id, write.value.owner?.conversationId ?? null, write.value.owner?.taskId ?? null, encodeJson(write.value)],
				);
				break;
			case "entry":
				await this.claimId(executor, write.value.id as unknown as number, "entry");
				await executor.query(
					`INSERT INTO ds_entries (session_id, id, conversation_id, head, commit_seq, record)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[this.sessionId, write.value.id, write.value.conversationId, write.value.head ?? null, seq, encodeJson(write.value)],
				);
				break;
			case "task":
				await this.claimId(executor, write.value.id as unknown as number, "task");
				await executor.query(
					`INSERT INTO ds_tasks (session_id, id, conversation_id, kind, status, abort_requested, background, record)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					 ON CONFLICT (session_id, id) DO UPDATE SET conversation_id = excluded.conversation_id,
					 kind = excluded.kind, status = excluded.status, abort_requested = excluded.abort_requested,
					 background = excluded.background, record = excluded.record`,
					[
						this.sessionId, write.value.id, write.value.conversationId,
						encodeIndexedString(write.value.kind), write.value.state.status,
						write.value.abortRequested ? true : false, write.value.background ? true : false,
						encodeJson(write.value),
					],
				);
				break;
			case "submission":
				await this.claimId(executor, write.value.id as unknown as number, "submission");
				await executor.query(
					`INSERT INTO ds_submissions (session_id, id, conversation_id, request_id, status, record)
					 VALUES ($1, $2, $3, $4, $5, $6)
					 ON CONFLICT (session_id, id) DO UPDATE SET conversation_id = excluded.conversation_id,
					 request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
					[
						this.sessionId, write.value.id, write.value.conversationId,
						write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
						write.value.status, encodeJson(write.value),
					],
				);
				break;
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	private async claimId(executor: Executor, id: number, table: string): Promise<void> {
		await executor.query(
			"INSERT INTO ds_record_ids (session_id, id, record_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
			[this.sessionId, id, table],
		);
	}

	private async applyDocumentActions(executor: Executor, actions: Map<number, DocumentAction>, seq: number): Promise<void> {
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.materializeDocument(executor, action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (stored.record.scope.kind !== "conversation"
						|| create.scope.kind !== "conversation"
						|| stored.record.kind !== create.kind
						|| stored.record.key !== create.key
						|| stored.record.history !== create.history
						|| stored.record.fork !== create.fork) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					throw new Error(`Document copy ${id} was rejected`, { cause: error });
				}
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				} as DocumentRecord;
				const parts = addressParts(record);
				await this.claimId(executor, id, "document");
				await executor.query(
					`INSERT INTO ds_documents
					 (session_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
					[
						this.sessionId, id, parts.kind, parts.family, parts.keyValue,
						parts.scopeKind, parts.ownerId, seq, action.retire ? seq : null, encodeJson(record),
					],
				);
			} else {
				const row = (await executor.query(
					"SELECT record FROM ds_documents WHERE session_id = $1 AND id = $2",
					[this.sessionId, id],
				)).rows[0];
				record = parseJson<DocumentRecord>(row.record as string);
			}
			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await executor.query(
						"DELETE FROM ds_document_revisions WHERE session_id = $1 AND document_id = $2",
						[this.sessionId, id],
					);
				}
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await executor.query(
					`INSERT INTO ds_document_revisions (session_id, document_id, seq, kind, version, content)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[this.sessionId, id, seq, content.kind, content.version, encodedContent],
				);
			}
			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq as unknown as Seq };
					await executor.query(
						"UPDATE ds_documents SET retired_at = $3, record = $4 WHERE session_id = $1 AND id = $2",
						[this.sessionId, id, seq, encodeJson(record)],
					);
				}
				if (isCurrentOnly(record)) {
					await executor.query(
						"DELETE FROM ds_document_revisions WHERE session_id = $1 AND document_id = $2",
						[this.sessionId, id],
					);
				}
			}
		}
	}

	/**
	 * One-time import of a session's legacy `session.sqlite` (H4): rows are copied
	 * verbatim into the session's `ds_*` partition, counters are taken from
	 * `durable_metadata`, then the file is renamed so the import never repeats.
	 */
	private async importLegacy(legacyPath: string): Promise<void> {
		if (!existsSync(legacyPath)) return;
		const client = await this.pool.connect();
		let renamed = false;
		try {
			const db = await openNodeSqliteDatabase(legacyPath);
			try {
				const tableExists = async (name: string) =>
					(await db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name)) !== undefined;
				if (!(await tableExists("durable_metadata"))) return;
				const meta = await db.get("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1") as
					{ next_id: string; next_seq: number } | undefined;
				if (meta === undefined) return;
				const tableRows = async (name: string) =>
					(await tableExists(name)) ? db.all(`SELECT * FROM ${name}`) : [];
				await client.query("BEGIN");
				try {
					await client.query(
						`UPDATE ds_metadata SET next_id = GREATEST(next_id, $2::numeric), next_seq = GREATEST(next_seq, $3)
						 WHERE session_id = $1`,
						[this.sessionId, meta.next_id, meta.next_seq],
					);
					for (const row of await tableRows("record_ids") as { id: number; record_type: string }[]) {
						await client.query(
							`INSERT INTO ds_record_ids (session_id, id, record_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.id, row.record_type],
						);
					}
					for (const row of await tableRows("conversations") as { id: number; owner_conversation_id: number | null; owner_task_id: number | null; record: string }[]) {
						await client.query(
							`INSERT INTO ds_conversations (session_id, id, owner_conversation_id, owner_task_id, record)
							 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.id, row.owner_conversation_id, row.owner_task_id, row.record],
						);
					}
					for (const row of await tableRows("entries") as { id: number; conversation_id: number; head: number | null; commit_seq: number; record: string }[]) {
						await client.query(
							`INSERT INTO ds_entries (session_id, id, conversation_id, head, commit_seq, record)
							 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.id, row.conversation_id, row.head, row.commit_seq, row.record],
						);
					}
					for (const row of await tableRows("tasks") as { id: number; conversation_id: number; kind: string; status: string; abort_requested: number; background: number; record: string }[]) {
						await client.query(
							`INSERT INTO ds_tasks (session_id, id, conversation_id, kind, status, abort_requested, background, record)
							 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.id, row.conversation_id, row.kind, row.status, row.abort_requested === 1, row.background === 1, row.record],
						);
					}
					for (const row of await tableRows("submissions") as { id: number; conversation_id: number; request_id: string | null; status: string; record: string }[]) {
						await client.query(
							`INSERT INTO ds_submissions (session_id, id, conversation_id, request_id, status, record)
							 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.id, row.conversation_id, row.request_id, row.status, row.record],
						);
					}
					for (const row of await tableRows("documents") as { id: number; kind: string; family: number; key_value: string; scope_kind: string; owner_id: number; created_at: number; retired_at: number | null; record: string }[]) {
						await client.query(
							`INSERT INTO ds_documents (session_id, id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
							 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.id, row.kind, row.family, row.key_value, row.scope_kind, row.owner_id, row.created_at, row.retired_at, row.record],
						);
					}
					for (const row of await tableRows("document_revisions") as { document_id: number; seq: number; kind: string; version: number; content: string }[]) {
						await client.query(
							`INSERT INTO ds_document_revisions (session_id, document_id, seq, kind, version, content)
							 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
							[this.sessionId, row.document_id, row.seq, row.kind, row.version, row.content],
						);
					}
					await client.query("COMMIT");
					renamed = true;
				} catch (error) {
					await client.query("ROLLBACK").catch(() => undefined);
					throw error;
				}
			} finally {
				await db.close().catch(() => undefined);
			}
		} finally {
			client.release();
		}
		if (renamed) {
			await rename(legacyPath, `${legacyPath}.migrated`).catch((error: unknown) => {
				logger.warn({ err: error, legacyPath }, "failed to rename imported durable sqlite storage");
			});
			logger.info({ sessionId: this.sessionId, legacyPath }, "imported legacy durable sqlite storage into PostgreSQL");
		}
	}
}
