/**
 * Tenant-scoped L2 storage in PostgreSQL (+ object storage for binaries).
 *
 * - Text files (wiki pages, logs, extracted text, raw text) → `l2_files`.
 * - Binary originals (PDF, Word, images, opaque uploads) → the shared
 *   {@link ObjectStore}; `l2_objects` keeps the object key, sha256 and size.
 * - Manifest entries → `l2_manifest` (entry kept as JSONB).
 * - Retrieval index → `l2_pages`, searched with ParadeDB BM25 exactly like
 *   `l3_chunks`: the same `segmentForFts` CJK-bigram tokenization is stored
 *   in `tokens` and queried with a whitespace tokenizer, so recall behaves
 *   identically to the local SQLite index.
 *
 * On first access a legacy `<tenant>/l2` directory is imported once and
 * renamed to `l2.migrated`; the sqlite index is derived state and gets
 * rebuilt from the imported pages instead of being imported.
 */

import type { Pool } from "pg";
import type { ObjectStore } from "../../object-store/index.js";
import { sha256Hex, tenantObjectKey } from "../../object-store/index.js";
import { segmentForFts } from "../l3/sqlite-store.js";
import { checkL2Path, type L2Backend, type L2FileStat } from "./l2-backend.js";
import type { L2LexHit, L2PageDoc, L2PageMeta } from "./l2-index-store.js";
import type { ManifestEntry } from "./types.js";

/** `text`/`jsonb` cannot hold U+0000 in PostgreSQL. */
const clean = (text: string) => text.replaceAll("\0", "�");



/** Object-key name segment: hash-prefixed so CJK filenames stay valid. */
function objectKeyFor(tenantId: string, sha256: string, path: string): string {
	const base = path
		.split("/")
		.pop()!
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return tenantObjectKey(tenantId, "l2-raw", `${sha256.slice(0, 16)}-${base || "object"}`);
}


export class PgL2Backend implements L2Backend {
	constructor(
		private readonly pool: Pool,
		private readonly tenantId: string,
		private readonly objects: ObjectStore,
	) {}

	/** Kept for symmetry with the previous lazy-init contract; a no-op now. */
	private init(): Promise<void> {
		return Promise.resolve();
	}


	async indexAvailable(): Promise<boolean> {
		return true;
	}

	async ensureDirs(): Promise<void> {
		await this.init();
	}

	private path(path: string): string {
		return checkL2Path(path);
	}

	async exists(path: string): Promise<boolean> {
		await this.init();
		const rel = this.path(path);
		const result = await this.pool.query<{ present: boolean }>(
			`SELECT EXISTS (SELECT 1 FROM l2_files WHERE tenant_id = $1 AND path = $2)
				OR EXISTS (SELECT 1 FROM l2_objects WHERE tenant_id = $1 AND path = $2) AS present`,
			[this.tenantId, rel],
		);
		return result.rows[0]?.present === true;
	}

	async readText(path: string): Promise<string> {
		await this.init();
		const result = await this.pool.query<{ content: string }>(
			"SELECT content FROM l2_files WHERE tenant_id = $1 AND path = $2",
			[this.tenantId, this.path(path)],
		);
		return result.rows[0]?.content ?? "";
	}

	private async storeText(rel: string, content: string): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const object = await client.query<{ object_key: string }>(
				"DELETE FROM l2_objects WHERE tenant_id = $1 AND path = $2 RETURNING object_key",
				[this.tenantId, rel],
			);
			await client.query(
				`INSERT INTO l2_files (tenant_id, path, content, updated_at)
				 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
				 ON CONFLICT (tenant_id, path) DO UPDATE SET
				   content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP`,
				[this.tenantId, rel, clean(content)],
			);
			await client.query("COMMIT");
			for (const row of object.rows) await this.objects.delete(row.object_key).catch(() => undefined);
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async writeText(path: string, content: string): Promise<void> {
		await this.init();
		await this.storeText(this.path(path), content);
	}

	async appendText(path: string, content: string): Promise<void> {
		await this.init();
		await this.pool.query(
			`INSERT INTO l2_files (tenant_id, path, content, updated_at)
			 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
			 ON CONFLICT (tenant_id, path) DO UPDATE SET
			   content = l2_files.content || EXCLUDED.content, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId, this.path(path), clean(content)],
		);
	}

	async delete(path: string): Promise<void> {
		await this.init();
		const rel = this.path(path);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("DELETE FROM l2_files WHERE tenant_id = $1 AND path = $2", [this.tenantId, rel]);
			const object = await client.query<{ object_key: string }>(
				"DELETE FROM l2_objects WHERE tenant_id = $1 AND path = $2 RETURNING object_key",
				[this.tenantId, rel],
			);
			await client.query("COMMIT");
			for (const row of object.rows) await this.objects.delete(row.object_key).catch(() => undefined);
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async listPaths(prefix = ""): Promise<string[]> {
		await this.init();
		const normalized = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
		if (normalized) checkL2Path(normalized);
		const like = normalized ? `${normalized}/%` : "%";
		const result = await this.pool.query<{ path: string }>(
			`SELECT path FROM l2_files WHERE tenant_id = $1 AND path LIKE $2
			 UNION
			 SELECT path FROM l2_objects WHERE tenant_id = $1 AND path LIKE $2
			 ORDER BY 1`,
			[this.tenantId, like],
		);
		return result.rows.map((row) => row.path);
	}

	async stat(path: string): Promise<L2FileStat | null> {
		await this.init();
		const rel = this.path(path);
		const text = await this.pool.query<{ size: number; updated_at: Date }>(
			"SELECT octet_length(content) AS size, updated_at FROM l2_files WHERE tenant_id = $1 AND path = $2",
			[this.tenantId, rel],
		);
		if (text.rows[0]) {
			return { size: Number(text.rows[0].size), mtimeMs: text.rows[0].updated_at.getTime() };
		}
		const object = await this.pool.query<{ bytes: number; created_at: Date }>(
			"SELECT bytes, created_at FROM l2_objects WHERE tenant_id = $1 AND path = $2",
			[this.tenantId, rel],
		);
		if (object.rows[0]) {
			return { size: Number(object.rows[0].bytes), mtimeMs: object.rows[0].created_at.getTime() };
		}
		return null;
	}

	private async storeBinary(rel: string, bytes: Uint8Array, contentType?: string): Promise<void> {
		const sha256 = sha256Hex(bytes);
		const key = objectKeyFor(this.tenantId, sha256, rel);
		const meta = await this.objects.put(key, bytes, contentType ? { contentType } : undefined);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const previous = await client.query<{ object_key: string }>(
				"DELETE FROM l2_objects WHERE tenant_id = $1 AND path = $2 RETURNING object_key",
				[this.tenantId, rel],
			);
			await client.query("DELETE FROM l2_files WHERE tenant_id = $1 AND path = $2", [this.tenantId, rel]);
			await client.query(
				`INSERT INTO l2_objects (tenant_id, path, object_key, sha256, bytes, content_type)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				[this.tenantId, rel, meta.key, meta.sha256, meta.size, contentType ?? null],
			);
			await client.query("COMMIT");
			for (const row of previous.rows) {
				if (row.object_key !== meta.key) await this.objects.delete(row.object_key).catch(() => undefined);
			}
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async putBinary(path: string, bytes: Uint8Array, contentType?: string): Promise<void> {
		await this.init();
		await this.storeBinary(this.path(path), bytes, contentType);
	}

	async readBinary(path: string): Promise<Uint8Array | null> {
		await this.init();
		const rel = this.path(path);
		const row = await this.pool.query<{ object_key: string }>(
			"SELECT object_key FROM l2_objects WHERE tenant_id = $1 AND path = $2",
			[this.tenantId, rel],
		);
		if (row.rows[0]) return this.objects.get(row.rows[0].object_key);
		const text = await this.readText(rel);
		return text ? new TextEncoder().encode(text) : null;
	}

	async readManifest(): Promise<ManifestEntry[]> {
		await this.init();
		const result = await this.pool.query<{ entry: ManifestEntry }>(
			"SELECT entry FROM l2_manifest WHERE tenant_id = $1 ORDER BY entry->>'createdAt', id",
			[this.tenantId],
		);
		return result.rows.map((row) => row.entry);
	}

	private async insertManifestEntry(entry: ManifestEntry): Promise<void> {
		await this.pool.query(
			`INSERT INTO l2_manifest (tenant_id, id, entry, updated_at)
			 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
			 ON CONFLICT (tenant_id, id) DO UPDATE SET
			   entry = EXCLUDED.entry, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId, entry.id, clean(JSON.stringify(entry))],
		);
	}

	async upsertManifestEntry(entry: ManifestEntry): Promise<void> {
		await this.init();
		await this.insertManifestEntry(entry);
	}

	async writeManifest(entries: ManifestEntry[]): Promise<void> {
		await this.init();
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("DELETE FROM l2_manifest WHERE tenant_id = $1", [this.tenantId]);
			for (const entry of entries) {
				await client.query(
					`INSERT INTO l2_manifest (tenant_id, id, entry) VALUES ($1, $2, $3)`,
					[this.tenantId, entry.id, clean(JSON.stringify(entry))],
				);
			}
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async upsertIndexPage(doc: L2PageDoc): Promise<void> {
		await this.init();
		const tokens = segmentForFts([doc.title, doc.tags.join(" "), doc.body].join(" "));
		await this.pool.query(
			`INSERT INTO l2_pages
			   (tenant_id, path, title, type, tags, source_ids, body, tokens, content_hash, mtime_ms)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (tenant_id, path) DO UPDATE SET
			   title = EXCLUDED.title, type = EXCLUDED.type, tags = EXCLUDED.tags,
			   source_ids = EXCLUDED.source_ids, body = EXCLUDED.body, tokens = EXCLUDED.tokens,
			   content_hash = EXCLUDED.content_hash, mtime_ms = EXCLUDED.mtime_ms,
			   version = l2_pages.version + 1, updated_at = CURRENT_TIMESTAMP`,
			[
				this.tenantId,
				doc.path,
				clean(doc.title),
				doc.type,
				JSON.stringify(doc.tags),
				JSON.stringify(doc.sourceIds),
				clean(doc.body),
				clean(tokens),
				doc.contentHash,
				doc.mtimeMs,
			],
		);
	}

	async deleteIndexPage(path: string): Promise<void> {
		await this.init();
		await this.pool.query("DELETE FROM l2_pages WHERE tenant_id = $1 AND path = $2", [this.tenantId, path]);
	}

	async searchLexical(query: string, limit = 30): Promise<L2LexHit[]> {
		await this.init();
		const tokens = segmentForFts(query);
		if (!tokens) return [];
		const result = await this.pool.query<{
			path: string; title: string; type: string; tags: unknown; source_ids: unknown; score: number;
		}>(
			`SELECT path, title, type, tags, source_ids, paradedb.score(rowid) AS score
			 FROM l2_pages
			 WHERE tokens ||| $2 AND tenant_id = $1
			 ORDER BY score DESC
			 LIMIT $3`,
			[this.tenantId, tokens, limit],
		);
		return result.rows.map((row) => ({
			path: row.path,
			title: row.title,
			type: row.type,
			tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
			sourceIds: Array.isArray(row.source_ids) ? row.source_ids.map(String) : [],
			// Keep the FTS5 contract: lower (more negative) is more relevant.
			bm25: -Number(row.score),
		}));
	}

	async getAllPages(): Promise<L2PageMeta[]> {
		await this.init();
		const result = await this.pool.query<{
			path: string; title: string; type: string; tags: unknown; source_ids: unknown; body: string;
		}>(
			"SELECT path, title, type, tags, source_ids, body FROM l2_pages WHERE tenant_id = $1",
			[this.tenantId],
		);
		return result.rows.map((row) => ({
			path: row.path,
			title: row.title,
			type: row.type,
			tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
			sourceIds: Array.isArray(row.source_ids) ? row.source_ids.map(String) : [],
			body: row.body,
		}));
	}

	async getIndexState(path: string): Promise<{ contentHash: string; mtimeMs: number } | null> {
		await this.init();
		const result = await this.pool.query<{ content_hash: string; mtime_ms: number }>(
			"SELECT content_hash, mtime_ms FROM l2_pages WHERE tenant_id = $1 AND path = $2",
			[this.tenantId, path],
		);
		const row = result.rows[0];
		return row ? { contentHash: row.content_hash, mtimeMs: Number(row.mtime_ms) } : null;
	}

	async setIndexState(path: string, contentHash: string, mtimeMs: number): Promise<void> {
		await this.init();
		await this.pool.query(
			"UPDATE l2_pages SET content_hash = $3, mtime_ms = $4 WHERE tenant_id = $1 AND path = $2",
			[this.tenantId, path, contentHash, mtimeMs],
		);
	}

	async listIndexedPaths(): Promise<string[]> {
		await this.init();
		const result = await this.pool.query<{ path: string }>(
			"SELECT path FROM l2_pages WHERE tenant_id = $1",
			[this.tenantId],
		);
		return result.rows.map((row) => row.path);
	}

	async pageCount(): Promise<number> {
		await this.init();
		const result = await this.pool.query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM l2_pages WHERE tenant_id = $1",
			[this.tenantId],
		);
		return Number(result.rows[0]?.n ?? 0);
	}

	close(): void {
		// The pool and object store belong to the server.
	}
}
