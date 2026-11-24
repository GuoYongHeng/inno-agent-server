import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { writeJson } from "../storage/file-store.js";

export type RecoveryKind = "question" | "permission" | "ocr" | "outbox";

export interface RecoveryEntry<T> {
	key: string;
	value: T;
	/** Milliseconds since the epoch of the last write; drives retention pruning. */
	updatedAt: number;
}

/**
 * Async key-value storage for one kind of per-session recovery record (pending
 * and answered questions, approvals). Local mode keeps JSON files, authenticated
 * mode keeps PostgreSQL rows; the stores above this layer cannot tell which.
 */
export interface RecoveryRecordStore {
	get<T>(sessionId: string, key: string): Promise<T | undefined>;
	put(sessionId: string, key: string, value: object): Promise<void>;
	/** Entries of one session ordered by key. */
	list<T>(sessionId: string): Promise<RecoveryEntry<T>[]>;
	delete(sessionId: string, key: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
}

/**
 * Stable JSON with sorted keys and no NUL characters. PostgreSQL `jsonb` does not
 * keep key order and cannot hold U+0000, so comparing a record's arguments with
 * the ones a replayed call supplies has to ignore both.
 */
export function canonicalJson(value: unknown): string {
	const sort = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(sort);
		if (input && typeof input === "object") {
			return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => [k, sort(v)]));
		}
		return typeof input === "string" ? input.replaceAll("\0", "\ufffd") : input;
	};
	return JSON.stringify(sort(value));
}

/** `jsonb` rejects the escape for U+0000; keep the rest of the text instead of failing the write. */
export function withoutNul(json: string): string {
	return json.replace(/(?<!\\)((?:\\\\)*)\\u0000/g, "$1\\ufffd");
}

/** Runs async operations one at a time. Replaces the atomicity that synchronous file code had for free. */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.catch(() => undefined);
		return result;
	}
}

const KEY_PATTERN = /^[0-9a-f]{64}$/;

function assertKey(key: string): void {
	if (!KEY_PATTERN.test(key)) throw new Error("Invalid recovery record key");
}

/** One JSON file per record under `dirFor(sessionId)`, mode 0600, atomic writes. */
export class FileRecoveryStore implements RecoveryRecordStore {
	/**
	 * `belongsTo` marks a flat directory shared by every session: listing and
	 * deleting a session then touch only the records that name it, never the directory.
	 */
	constructor(
		private readonly dirFor: (sessionId: string) => string,
		private readonly belongsTo?: (value: unknown, sessionId: string) => boolean,
	) {}

	private path(sessionId: string, key: string): string {
		assertKey(key);
		return join(this.dirFor(sessionId), `${key}.json`);
	}

	async get<T>(sessionId: string, key: string): Promise<T | undefined> {
		const path = this.path(sessionId, key);
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	}

	async put(sessionId: string, key: string, value: object): Promise<void> {
		writeJson(this.path(sessionId, key), value, { mode: 0o600 });
	}

	async list<T>(sessionId: string): Promise<RecoveryEntry<T>[]> {
		const dir = this.dirFor(sessionId);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => {
				const path = join(dir, file);
				return { key: file.slice(0, -5), value: JSON.parse(readFileSync(path, "utf-8")) as T, updatedAt: statSync(path).mtimeMs };
			})
			.filter((entry) => !this.belongsTo || this.belongsTo(entry.value, sessionId));
	}

	async delete(sessionId: string, key: string): Promise<void> {
		rmSync(this.path(sessionId, key), { force: true });
	}

	async deleteSession(sessionId: string): Promise<void> {
		if (this.belongsTo) {
			for (const entry of await this.list(sessionId)) await this.delete(sessionId, entry.key);
			return;
		}
		rmSync(this.dirFor(sessionId), { recursive: true, force: true });
	}
}

/**
 * Tenant-scoped rows in `recovery_records`. The tenant is fixed at construction
 * from a verified request, never taken from a caller-supplied value.
 */
export class PgRecoveryStore implements RecoveryRecordStore {
	constructor(
		private readonly pool: Pool,
		private readonly tenantId: string,
		private readonly kind: RecoveryKind,
	) {}

	private async ready(_sessionId: string): Promise<void> {}


	async get<T>(sessionId: string, key: string): Promise<T | undefined> {
		assertKey(key);
		await this.ready(sessionId);
		const result = await this.pool.query<{ value: T }>(
			"SELECT value FROM recovery_records WHERE tenant_id = $1 AND session_id = $2 AND kind = $3 AND record_key = $4",
			[this.tenantId, sessionId, this.kind, key],
		);
		return result.rows[0]?.value;
	}

	async put(sessionId: string, key: string, value: object): Promise<void> {
		assertKey(key);
		await this.ready(sessionId);
		await this.pool.query(
			`INSERT INTO recovery_records (tenant_id, session_id, kind, record_key, value)
			 VALUES ($1, $2, $3, $4, $5::jsonb)
			 ON CONFLICT (tenant_id, session_id, kind, record_key)
			 DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId, sessionId, this.kind, key, withoutNul(JSON.stringify(value))],
		);
	}

	async list<T>(sessionId: string): Promise<RecoveryEntry<T>[]> {
		await this.ready(sessionId);
		const result = await this.pool.query<{ record_key: string; value: T; updated_at: Date }>(
			`SELECT record_key, value, updated_at FROM recovery_records
			 WHERE tenant_id = $1 AND session_id = $2 AND kind = $3 ORDER BY record_key`,
			[this.tenantId, sessionId, this.kind],
		);
		return result.rows.map((row) => ({ key: row.record_key, value: row.value, updatedAt: row.updated_at.getTime() }));
	}

	async delete(sessionId: string, key: string): Promise<void> {
		assertKey(key);
		await this.pool.query(
			"DELETE FROM recovery_records WHERE tenant_id = $1 AND session_id = $2 AND kind = $3 AND record_key = $4",
			[this.tenantId, sessionId, this.kind, key],
		);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM recovery_records WHERE tenant_id = $1 AND session_id = $2 AND kind = $3",
			[this.tenantId, sessionId, this.kind],
		);
	}
}
