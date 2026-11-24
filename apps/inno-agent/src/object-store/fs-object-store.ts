import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex, type ObjectMeta, type ObjectStore, type PutObjectOptions } from "./object-store.js";

/**
 * Filesystem-backed ObjectStore for single-host deployments and tests: keys map
 * to files under `root` (segments must already be safe names, which
 * `tenantObjectKey` enforces). Unlike `memory` this survives restarts and, more
 * importantly, is shared by every process pointed at the same directory — which
 * is what makes cross-worker replication testable without MinIO.
 */
export class FsObjectStore implements ObjectStore {
	constructor(private readonly root: string) {}

	private path(key: string): string {
		return join(this.root, ...key.split("/"));
	}

	async put(key: string, body: Uint8Array, options?: PutObjectOptions): Promise<ObjectMeta> {
		const target = this.path(key);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, body);
		const meta: ObjectMeta = { key, size: body.byteLength, sha256: sha256Hex(body), ...(options?.contentType ? { contentType: options.contentType } : {}), mtimeMs: Date.now() };
		await writeFile(`${target}.meta`, JSON.stringify(meta));
		return meta;
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.path(key)));
		} catch {
			return null;
		}
	}

	async head(key: string): Promise<ObjectMeta | null> {
		try {
			const meta = JSON.parse(await readFile(`${this.path(key)}.meta`, "utf8")) as ObjectMeta;
			const stats = await stat(this.path(key));
			return { ...meta, size: stats.size, mtimeMs: meta.mtimeMs ?? stats.mtimeMs };
		} catch {
			return null;
		}
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
		await rm(`${this.path(key)}.meta`, { force: true });
	}

	async deletePrefix(prefix: string): Promise<number> {
		const metas = await this.list(prefix);
		for (const meta of metas) await this.delete(meta.key);
		return metas.length;
	}

	async list(prefix: string): Promise<ObjectMeta[]> {
		const out: ObjectMeta[] = [];
		const walk = async (dir: string) => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) await walk(full);
				else if (entry.isFile() && entry.name.endsWith(".meta")) {
					try {
						const meta = JSON.parse(await readFile(full, "utf8")) as ObjectMeta;
						if (!meta.key.startsWith(prefix)) continue;
						const stats = await stat(this.path(meta.key)).catch(() => null);
						out.push(stats ? { ...meta, mtimeMs: meta.mtimeMs ?? stats.mtimeMs } : meta);
					} catch { /* ignore corrupt meta */ }
				}
			}
		};
		await walk(this.root);
		return out.sort((a, b) => a.key.localeCompare(b.key));
	}
}
