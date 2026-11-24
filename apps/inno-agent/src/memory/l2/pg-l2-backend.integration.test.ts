import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../../auth/config.js";
import { migrateAuthDatabase } from "../../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../../db/test-postgres.js";
import { MemoryObjectStore } from "../../object-store/index.js";
import { TenantStore, type TenantContext } from "../../tenants/store.js";
import { PgL2Backend } from "./pg-l2-backend.js";
import type { ManifestEntry } from "./types.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let tenantA: TenantContext;
let tenantB: TenantContext;
let objects: MemoryObjectStore;
let dataDir: string;

function entry(id: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		id,
		title: `Source ${id}`,
		sourceType: "markdown",
		rawPath: `raw/uploads/${id}.md`,
		extractedPath: `extracted/${id}.md`,
		wikiPages: [`wiki/sources/${id}.md`],
		tags: ["demo"],
		contentHash: `hash-${id}`,
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "l2-pg-integration-secret-at-least-32-characters",
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	const store = new TenantStore(pool);
	for (const id of ["l2-user-a", "l2-user-b"]) {
		await pool.query(
			`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, false, NOW(), NOW())`,
			[id, `${id}@example.com`],
		);
	}
	tenantA = await store.ensurePersonalTenant("l2-user-a");
	tenantB = await store.ensurePersonalTenant("l2-user-b");
	objects = new MemoryObjectStore();
	dataDir = mkdtempSync(join(tmpdir(), "inno-l2-pg-"));
});

afterAll(async () => {
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	await pool?.end();
	await postgres?.close();
});

describe("PgL2Backend", () => {
	it("round-trips wiki text files with path listing and stat", async () => {
		const backend = new PgL2Backend(pool, tenantA.tenantId, objects);
		await backend.writeText("wiki/concepts/topic.md", "---\ntitle: Topic\n---\n# Topic\n");
		await backend.writeText("wiki/index.md", "# Index\n");
		expect(await backend.exists("wiki/concepts/topic.md")).toBe(true);
		expect(await backend.exists("wiki/concepts/missing.md")).toBe(false);
		expect(await backend.readText("wiki/concepts/topic.md")).toContain("# Topic");
		expect(await backend.readText("wiki/concepts/missing.md")).toBe("");
		expect(await backend.listPaths("wiki")).toEqual(["wiki/concepts/topic.md", "wiki/index.md"]);
		expect((await backend.stat("wiki/index.md"))?.size).toBe("# Index\n".length);
		await backend.delete("wiki/index.md");
		expect(await backend.exists("wiki/index.md")).toBe(false);
	});

	it("upserts and reads manifest entries, and replaces the whole manifest", async () => {
		const backend = new PgL2Backend(pool, tenantA.tenantId, objects);
		await backend.upsertManifestEntry(entry("l2src_a1"));
		await backend.upsertManifestEntry(entry("l2src_a2", { title: "Second" }));
		expect((await backend.readManifest()).map((e) => e.id).sort()).toEqual(["l2src_a1", "l2src_a2"]);
		await backend.upsertManifestEntry(entry("l2src_a1", { title: "Renamed" }));
		expect((await backend.readManifest()).find((e) => e.id === "l2src_a1")?.title).toBe("Renamed");
		await backend.writeManifest([entry("l2src_a3")]);
		expect((await backend.readManifest()).map((e) => e.id)).toEqual(["l2src_a3"]);
	});

	it("stores binaries in the object store with metadata and replaces them cleanly", async () => {
		const backend = new PgL2Backend(pool, tenantA.tenantId, objects);
		const bytes = new TextEncoder().encode("%PDF-1.4 fake");
		await backend.putBinary("raw/uploads/doc.pdf", bytes, "application/pdf");
		expect(await backend.exists("raw/uploads/doc.pdf")).toBe(true);
		expect(new TextDecoder().decode((await backend.readBinary("raw/uploads/doc.pdf"))!)).toBe("%PDF-1.4 fake");
		const meta = await pool.query(
			"SELECT object_key, sha256, bytes, content_type FROM l2_objects WHERE tenant_id = $1 AND path = $2",
			[tenantA.tenantId, "raw/uploads/doc.pdf"],
		);
		expect(meta.rows[0].content_type).toBe("application/pdf");
		expect(Number(meta.rows[0].bytes)).toBe(bytes.length);
		const firstKey = meta.rows[0].object_key as string;
		expect(await objects.get(firstKey)).not.toBeNull();

		// Replacement swaps the object and deletes the previous blob.
		await backend.putBinary("raw/uploads/doc.pdf", new TextEncoder().encode("%PDF-1.5 newer"), "application/pdf");
		const second = await pool.query(
			"SELECT object_key FROM l2_objects WHERE tenant_id = $1 AND path = $2",
			[tenantA.tenantId, "raw/uploads/doc.pdf"],
		);
		expect(second.rows[0].object_key).not.toBe(firstKey);
		expect(await objects.get(firstKey)).toBeNull();

		await backend.delete("raw/uploads/doc.pdf");
		expect(await backend.exists("raw/uploads/doc.pdf")).toBe(false);
	});

	it("indexes pages and ranks BM25 hits like the SQLite backend", async () => {
		const backend = new PgL2Backend(pool, tenantA.tenantId, objects);
		await backend.upsertIndexPage({
			path: "wiki/concepts/gradient.md",
			title: "梯度下降",
			type: "concept",
			tags: ["ml"],
			sourceIds: ["l2src_a1"],
			body: "梯度下降是机器学习的优化方法",
			contentHash: "h1",
			mtimeMs: 100,
		});
		await backend.upsertIndexPage({
			path: "wiki/entities/rust.md",
			title: "Rust",
			type: "entity",
			tags: [],
			sourceIds: [],
			body: "Rust 是一门系统编程语言",
			contentHash: "h2",
			mtimeMs: 100,
		});
		const hits = await backend.searchLexical("梯度下降", 10);
		expect(hits.map((hit) => hit.path)).toEqual(["wiki/concepts/gradient.md"]);
		expect(hits[0].sourceIds).toEqual(["l2src_a1"]);
		expect(await backend.getIndexState("wiki/concepts/gradient.md")).toEqual({ contentHash: "h1", mtimeMs: 100 });
		await backend.setIndexState("wiki/concepts/gradient.md", "h1b", 200);
		expect((await backend.getIndexState("wiki/concepts/gradient.md"))?.contentHash).toBe("h1b");
		expect((await backend.getAllPages()).map((p) => p.path).sort())
			.toEqual(["wiki/concepts/gradient.md", "wiki/entities/rust.md"]);
		expect(await backend.pageCount()).toBe(2);
		await backend.deleteIndexPage("wiki/entities/rust.md");
		expect(await backend.listIndexedPaths()).toEqual(["wiki/concepts/gradient.md"]);
	});

	it("isolates files, manifest, index, and objects per tenant", async () => {
		const a = new PgL2Backend(pool, tenantA.tenantId, objects);
		const b = new PgL2Backend(pool, tenantB.tenantId, objects);
		await a.writeText("wiki/concepts/shared.md", "tenant A page");
		await a.upsertManifestEntry(entry("l2src_ta"));
		await a.upsertIndexPage({
			path: "wiki/concepts/shared.md", title: "A concept", type: "concept",
			tags: [], sourceIds: [], body: "只属于甲的知识", contentHash: "ha", mtimeMs: 1,
		});
		await a.putBinary("raw/uploads/a.pdf", new TextEncoder().encode("A"), "application/pdf");
		await b.putBinary("raw/uploads/b.pdf", new TextEncoder().encode("B"), "application/pdf");

		expect(await b.readText("wiki/concepts/shared.md")).toBe("");
		expect(await b.readManifest()).toEqual([]);
		expect(await b.searchLexical("只属于甲的知识", 10)).toEqual([]);
		expect(await b.readBinary("raw/uploads/a.pdf")).toBeNull();
		// Objects are keyed under their owning tenant prefix.
		expect(await objects.list(`tenants/${tenantB.tenantId}/`)).toHaveLength(1);
	});

	it("rejects traversal paths before touching storage", async () => {
		const backend = new PgL2Backend(pool, tenantB.tenantId, objects);
		await expect(backend.writeText("../escape.md", "x")).rejects.toThrow();
		await expect(backend.readText("wiki/../../etc/passwd")).rejects.toThrow();
		await expect(backend.putBinary("raw/../x.bin", new Uint8Array([1]))).rejects.toThrow();
	});

});
