/**
 * L2 storage backend.
 *
 * Every L2 read/write goes through {@link L2Backend}, a virtual filesystem
 * rooted at one tenant's L2 area plus the manifest and the retrieval index.
 * Local/desktop mode uses {@link FileL2Backend} (real files under
 * `<data>/l2` + `node:sqlite` index); authenticated mode mounts a
 * `PgL2Backend` per tenant (see l2-backend-pg wiring in server.ts), so the
 * same pipeline code works on both without knowing where bytes live.
 *
 * Paths are always L2-relative POSIX paths (`wiki/sources/x.md`,
 * `raw/uploads/y.pdf`). Backends reject `..` and absolute paths.
 */

import { dirname, join, resolve, sep } from "node:path";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import {
	appendText,
	ensureDir,
	fileExists,
	readJsonl,
	readText,
	writeJsonl,
	writeText,
} from "../../storage/file-store.js";
import { logger } from "../../logger.js";
import { openL2IndexStore, type L2IndexStore, type L2LexHit, type L2PageDoc, type L2PageMeta } from "./l2-index-store.js";
import type { ManifestEntry } from "./types.js";

export interface L2FileStat {
	size: number;
	mtimeMs: number;
}

export interface L2Backend {
	/** False when the local sqlite index could not be opened (PG is always true). */
	indexAvailable(): Promise<boolean>;
	/** Create the directory layout / seed nothing. No-op for PG. */
	ensureDirs(): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** File content; "" when missing or when the path holds a binary object. */
	readText(path: string): Promise<string>;
	writeText(path: string, content: string): Promise<void>;
	appendText(path: string, content: string): Promise<void>;
	delete(path: string): Promise<void>;
	/** All file paths under `prefix` (or every path), sorted. */
	listPaths(prefix?: string): Promise<string[]>;
	stat(path: string): Promise<L2FileStat | null>;
	/** Store opaque bytes (uploaded PDFs, Office docs, images). */
	putBinary(path: string, bytes: Uint8Array, contentType?: string): Promise<void>;
	readBinary(path: string): Promise<Uint8Array | null>;
	readManifest(): Promise<ManifestEntry[]>;
	/** Insert an entry or replace the record with the same id. */
	upsertManifestEntry(entry: ManifestEntry): Promise<void>;
	/** Replace the whole manifest (same semantics as rewriting manifest.jsonl). */
	writeManifest(entries: ManifestEntry[]): Promise<void>;
	upsertIndexPage(doc: L2PageDoc): Promise<void>;
	deleteIndexPage(path: string): Promise<void>;
	searchLexical(query: string, limit?: number): Promise<L2LexHit[]>;
	getAllPages(): Promise<L2PageMeta[]>;
	getIndexState(path: string): Promise<{ contentHash: string; mtimeMs: number } | null>;
	setIndexState(path: string, contentHash: string, mtimeMs: number): Promise<void>;
	listIndexedPaths(): Promise<string[]>;
	pageCount(): Promise<number>;
	close(): void;
}

/** A call target: an L2 data dir (resolved through the registry) or a backend. */
export type L2Target = string | L2Backend;

/**
 * Validate and normalize an L2-relative path. Returns the POSIX form or
 * throws on `..`, absolute paths, and empty segments — the store boundary
 * must never address anything outside its own root.
 */
export function checkL2Path(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
	if (!normalized || normalized === ".") throw new Error(`Invalid L2 path: ${JSON.stringify(path)}`);
	for (const segment of normalized.split("/")) {
		if (!segment || segment === "." || segment === "..") {
			throw new Error(`Invalid L2 path segment in ${JSON.stringify(path)}`);
		}
	}
	return normalized;
}

// ---------------------------------------------------------------------------
// Registry: a dir key → backend. PG mode mounts backends per tenant dir; the
// default is a FileL2Backend over that dir.
// ---------------------------------------------------------------------------

type L2BackendResolver = (resolvedDir: string) => L2Backend | null;

let resolver: L2BackendResolver | null = null;

/**
 * Install the process-wide backend resolver. The server registers one that
 * maps `<dataDir>/tenants/<tenantId>/l2` to the tenant's PG backend when (and
 * only when) multi-user auth is active. Local mode leaves this unset.
 */
export function setL2BackendResolver(fn: L2BackendResolver | null): void {
	resolver = fn;
}

const backends = new Map<string, L2Backend>();

/** Resolve the backend mounted for an L2 data dir (file backend by default). */
export function l2BackendFor(l2DataDir: string): L2Backend {
	const key = resolve(l2DataDir);
	let backend = backends.get(key);
	if (backend) return backend;
	try {
		backend = resolver?.(key) ?? undefined!;
	} catch (err) {
		logger.warn({ err }, "[L2] backend resolver failed; falling back to file storage");
	}
	if (!backend) backend = new FileL2Backend(key);
	backends.set(key, backend);
	return backend;
}

/** `target` may be a dir or an already-resolved backend. */
export function l2Store(target: L2Target): L2Backend {
	return typeof target === "string" ? l2BackendFor(target) : target;
}

/** Drop the registry entry for a dir. Tests call this before deleting temp dirs. */
export function closeL2Backend(l2DataDir: string): void {
	const key = resolve(l2DataDir);
	backends.get(key)?.close();
	backends.delete(key);
}

// ---------------------------------------------------------------------------
// Small JSONL conveniences over the text interface (reviews, ingest logs).
// ---------------------------------------------------------------------------

export async function readJsonLines<T>(store: L2Backend, path: string): Promise<T[]> {
	const content = await store.readText(path);
	const records: T[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as T);
		} catch {
			// Skip malformed tail lines exactly like storage/file-store's parser.
		}
	}
	return records;
}

export async function writeJsonLines<T>(store: L2Backend, path: string, records: T[]): Promise<void> {
	const lines = records.map((record) => JSON.stringify(record)).join("\n");
	await store.writeText(path, lines ? `${lines}\n` : "");
}

export async function appendJsonLine<T>(store: L2Backend, path: string, record: T): Promise<void> {
	await store.appendText(path, `${JSON.stringify(record)}\n`);
}

// ---------------------------------------------------------------------------
// File backend — the historical layout on local disk.
// ---------------------------------------------------------------------------

const MANIFEST_FILE = "manifest.jsonl";

export class FileL2Backend implements L2Backend {
	private indexStore: L2IndexStore | null = null;
	private indexOpened: Promise<L2IndexStore | null> | null = null;

	constructor(readonly rootDir: string) {}

	private abs(path: string): string {
		const rel = checkL2Path(path);
		const resolved = resolve(this.rootDir, rel);
		if (resolved !== this.rootDir && !resolved.startsWith(this.rootDir + sep)) {
			throw new Error(`L2 path escapes root: ${JSON.stringify(path)}`);
		}
		return resolved;
	}

	private index(): Promise<L2IndexStore | null> {
		if (!this.indexOpened) {
			this.indexOpened = openL2IndexStore(this.rootDir).then((store) => {
				this.indexStore = store;
				if (!store) {
					logger.warn("[L2] node:sqlite unavailable — index-backed retrieval disabled (falling back to substring).");
				}
				return store;
			});
		}
		return this.indexOpened;
	}

	async indexAvailable(): Promise<boolean> {
		return (await this.index()) !== null;
	}

	async ensureDirs(): Promise<void> {
		for (const dir of [
			"raw/uploads",
			"raw/web",
			"raw/conversations",
			"raw/research",
			"extracted",
			"wiki/sources",
			"wiki/entities",
			"wiki/concepts",
			"wiki/queries",
			"wiki/comparisons",
			"wiki/synthesis",
			"wiki/analysis",
		]) {
			ensureDir(join(this.rootDir, dir));
		}
	}

	async exists(path: string): Promise<boolean> {
		return fileExists(this.abs(path));
	}

	async readText(path: string): Promise<string> {
		return readText(this.abs(path));
	}

	async writeText(path: string, content: string): Promise<void> {
		writeText(this.abs(path), content);
	}

	async appendText(path: string, content: string): Promise<void> {
		appendText(this.abs(path), content);
	}

	async delete(path: string): Promise<void> {
		rmSync(this.abs(path), { force: true });
	}

	async listPaths(prefix = ""): Promise<string[]> {
		const normalized = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
		if (normalized) checkL2Path(normalized);
		const root = normalized ? join(this.rootDir, normalized) : this.rootDir;
		const paths: string[] = [];
		const visit = (absoluteDir: string, relativeDir: string): void => {
			let entries: Dirent[];
			try {
				entries = readdirSync(absoluteDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					// ingest-progress holds transient crash checkpoints — not wiki data.
					if (relativePath === "ingest-progress") continue;
					visit(join(absoluteDir, entry.name), relativePath);
				}
				// index.db* is the local sqlite index — derived state hidden from
				// the path listing so it matches the PG backend's view.
				else if (entry.isFile() && !entry.name.startsWith("index.db")) paths.push(relativePath);
			}
		};
		visit(root, normalized);
		return paths.map((p) => p.replaceAll("\\", "/")).sort();
	}

	async stat(path: string): Promise<L2FileStat | null> {
		try {
			const stats = statSync(this.abs(path));
			return { size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) };
		} catch {
			return null;
		}
	}

	async putBinary(path: string, bytes: Uint8Array): Promise<void> {
		const abs = this.abs(path);
		ensureDir(dirname(abs));
		writeFileSync(abs, bytes);
	}

	async readBinary(path: string): Promise<Uint8Array | null> {
		try {
			return readFileSync(this.abs(path));
		} catch {
			return null;
		}
	}

	async readManifest(): Promise<ManifestEntry[]> {
		return readJsonl<ManifestEntry>(join(this.rootDir, MANIFEST_FILE));
	}

	async upsertManifestEntry(entry: ManifestEntry): Promise<void> {
		const entries = await this.readManifest();
		const index = entries.findIndex((candidate) => candidate.id === entry.id);
		if (index >= 0) entries[index] = entry;
		else entries.push(entry);
		await this.writeManifest(entries);
	}

	async writeManifest(entries: ManifestEntry[]): Promise<void> {
		writeJsonl(join(this.rootDir, MANIFEST_FILE), entries);
	}

	async upsertIndexPage(doc: L2PageDoc): Promise<void> {
		(await this.index())?.upsertPage(doc);
	}

	async deleteIndexPage(path: string): Promise<void> {
		(await this.index())?.deletePage(path);
	}

	async searchLexical(query: string, limit = 30): Promise<L2LexHit[]> {
		return (await this.index())?.searchLexical(query, limit) ?? [];
	}

	async getAllPages(): Promise<L2PageMeta[]> {
		return (await this.index())?.getAllPages() ?? [];
	}

	async getIndexState(path: string): Promise<{ contentHash: string; mtimeMs: number } | null> {
		return (await this.index())?.getIndexState(path) ?? null;
	}

	async setIndexState(path: string, contentHash: string, mtimeMs: number): Promise<void> {
		(await this.index())?.setIndexState(path, contentHash, mtimeMs);
	}

	async listIndexedPaths(): Promise<string[]> {
		return (await this.index())?.listIndexedPaths() ?? [];
	}

	async pageCount(): Promise<number> {
		return (await this.index())?.pageCount() ?? 0;
	}

	close(): void {
		this.indexStore?.close();
		this.indexStore = null;
		this.indexOpened = null;
	}
}
