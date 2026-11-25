import type { IncomingMessage } from "node:http";
import { withFileLock } from "../storage/file-lock.js";
import { readJson, writeJson } from "../storage/file-store.js";
import { setGauge, timed } from "../utils/metrics.js";

/** One row of the durable session catalog (application metadata; conversation
 * history lives in the per-session pi-durable storage). */
export interface DurableSessionRecord {
	id: string;
	workspaceId: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview: string;
	provider: string;
	modelId: string;
	topicGenerated?: boolean;
	topicUpgraded?: boolean;
	origin?: "web" | "scheduler";
	archived: boolean;
	/** The conversation the session continues in after an earlier message was
	 * edited. Omitted: the root conversation. */
	conversationId?: string;
	/** The remote sandbox this session runs shell and file tools in, once one exists. */
	sandboxId?: string;
	/** Simple Mode preset this session was opened from (image template id). */
	presetId?: string;
}

export const DURABLE_ID_PATTERN = /^durable-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DurableSessionPatch = Partial<Omit<DurableSessionRecord, "id">>;

export class SessionNotFoundError extends Error {
	constructor() {
		super("Durable session not found");
		this.name = "SessionNotFoundError";
	}
}

/**
 * Where session metadata lives. The request carries the verified tenant (or none
 * in local mode), so implementations never accept a tenant ID from callers.
 * Local/desktop mode uses {@link FileSessionCatalog}; authenticated mode uses
 * the PostgreSQL implementation, whose rows are tenant-scoped and written in the
 * same transaction as session ownership.
 */
export interface SessionCatalog {
	get(req: IncomingMessage, id: string): Promise<DurableSessionRecord | undefined>;
	/** All records of the caller's scope, newest `updatedAt` first. */
	list(req: IncomingMessage): Promise<DurableSessionRecord[]>;
	/**
	 * One page of records, newest `updatedAt` first. `cursor` is the opaque
	 * token returned by the previous call; omit both options for the full list.
	 */
	listPage(req: IncomingMessage, options?: SessionCatalogListOptions): Promise<SessionCatalogPage>;
	insert(req: IncomingMessage, record: DurableSessionRecord): Promise<void>;
	/** Merge `patch` into the record; throws {@link SessionNotFoundError}. */
	update(req: IncomingMessage, id: string, patch: DurableSessionPatch): Promise<DurableSessionRecord>;
	/** Remove the record; absent records are not an error. */
	remove(req: IncomingMessage, id: string): Promise<void>;
}

export interface SessionCatalogListOptions {
	limit?: number;
	cursor?: string;
}

export interface SessionCatalogPage {
	records: DurableSessionRecord[];
	/** Pass back to fetch the next page; null when the listing is exhausted. */
	nextCursor: string | null;
}

/** Opaque list cursor: the (updatedAt, id) tuple a page ended on. */
export function encodeSessionListCursor(record: DurableSessionRecord): string {
	return Buffer.from(JSON.stringify({ u: record.updatedAt, i: record.id }), "utf8").toString("base64url");
}

export function decodeSessionListCursor(cursor: string): { updatedAt: string; id: string } | null {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { u?: unknown; i?: unknown };
		return typeof parsed.u === "string" && typeof parsed.i === "string" ? { updatedAt: parsed.u, id: parsed.i } : null;
	} catch {
		return null;
	}
}

export function isSessionRecord(value: unknown): value is DurableSessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<DurableSessionRecord>;
	return typeof record.id === "string" && DURABLE_ID_PATTERN.test(record.id)
		&& typeof record.workspaceId === "string" && typeof record.name === "string"
		&& typeof record.createdAt === "string" && typeof record.updatedAt === "string"
		&& typeof record.messageCount === "number" && typeof record.preview === "string"
		&& typeof record.provider === "string" && typeof record.modelId === "string"
		&& (record.topicGenerated === undefined || typeof record.topicGenerated === "boolean")
		&& (record.topicUpgraded === undefined || typeof record.topicUpgraded === "boolean")
		&& (record.origin === undefined || record.origin === "web" || record.origin === "scheduler")
		&& (record.presetId === undefined || typeof record.presetId === "string")
		&& typeof record.archived === "boolean";
}

/** `sessions.json` beside the tenant (or local) durable root. Read-modify-write
 * sections run under a cross-process file lock. */
export class FileSessionCatalog implements SessionCatalog {
	constructor(private readonly catalogPath: (req: IncomingMessage) => string) {}

	private read(req: IncomingMessage): DurableSessionRecord[] {
		const value = timed("inno_catalog_read_ms", () => readJson<unknown>(this.catalogPath(req), []));
		const records = Array.isArray(value) ? value.filter(isSessionRecord) : [];
		setGauge("inno_catalog_sessions", records.length);
		return records;
	}

	private write(req: IncomingMessage, records: DurableSessionRecord[]): void {
		timed("inno_catalog_write_ms", () => writeJson(this.catalogPath(req), records));
	}

	private locked<T>(req: IncomingMessage, operation: () => T): T {
		return withFileLock(`${this.catalogPath(req)}.lock`, operation);
	}

	async get(req: IncomingMessage, id: string): Promise<DurableSessionRecord | undefined> {
		return this.read(req).find((record) => record.id === id);
	}

	async list(req: IncomingMessage): Promise<DurableSessionRecord[]> {
		return this.read(req).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}

	async listPage(req: IncomingMessage, options?: SessionCatalogListOptions): Promise<SessionCatalogPage> {
		const sorted = (await this.list(req))
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? 1 : -1));
		let start = 0;
		if (options?.cursor) {
			const cursor = decodeSessionListCursor(options.cursor);
			if (cursor) {
				const index = sorted.findIndex((record) =>
					record.updatedAt < cursor.updatedAt
					|| (record.updatedAt === cursor.updatedAt && record.id < cursor.id));
				start = index < 0 ? sorted.length : index;
			}
		}
		const limit = options?.limit && options.limit > 0 ? options.limit : sorted.length;
		const records = sorted.slice(start, start + limit);
		const more = start + records.length < sorted.length;
		return { records, nextCursor: more && records.length > 0 ? encodeSessionListCursor(records[records.length - 1]!) : null };
	}

	async insert(req: IncomingMessage, record: DurableSessionRecord): Promise<void> {
		this.locked(req, () => this.write(req, [...this.read(req), record]));
	}

	async update(req: IncomingMessage, id: string, patch: DurableSessionPatch): Promise<DurableSessionRecord> {
		return this.locked(req, () => {
			const records = this.read(req);
			const index = records.findIndex((record) => record.id === id);
			if (index < 0) throw new SessionNotFoundError();
			const next = { ...records[index]!, ...patch };
			records[index] = next;
			this.write(req, records);
			return next;
		});
	}

	async remove(req: IncomingMessage, id: string): Promise<void> {
		this.locked(req, () => this.write(req, this.read(req).filter((record) => record.id !== id)));
	}
}
