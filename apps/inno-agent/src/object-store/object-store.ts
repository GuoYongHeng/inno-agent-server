import { createHash } from "node:crypto";

export interface ObjectMeta {
	key: string;
	size: number;
	/** Lower-case hex SHA-256 of the body. */
	sha256: string;
	contentType?: string;
}

export interface PutObjectOptions {
	contentType?: string;
}

/**
 * Blob storage for data too large or too opaque for PostgreSQL (uploaded PDFs,
 * Office files, images). Backed by S3-compatible storage: Alibaba Cloud OSS in
 * production, MinIO locally. Callers hold object keys only; they never see
 * provider details. Objects are immutable by convention (a changed file gets a
 * new key), which keeps a retried write after a crash harmless.
 */
export interface ObjectStore {
	put(key: string, body: Uint8Array, options?: PutObjectOptions): Promise<ObjectMeta>;
	/** The object's bytes, or null when it does not exist. */
	get(key: string): Promise<Uint8Array | null>;
	head(key: string): Promise<ObjectMeta | null>;
	/** Deleting a missing object succeeds. */
	delete(key: string): Promise<void>;
	/** Delete every object under a prefix; returns how many were removed. */
	deletePrefix(prefix: string): Promise<number>;
	list(prefix: string): Promise<ObjectMeta[]>;
}

export function sha256Hex(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Build a tenant-scoped object key. Every segment must be a plain name: no
 * separators, no `.` / `..`, so a tenant can never address another tenant's
 * prefix through a crafted file name.
 */
export function tenantObjectKey(tenantId: string, ...segments: string[]): string {
	const parts = [tenantId, ...segments];
	for (const part of parts) {
		if (!SEGMENT.test(part) || part === "." || part === "..") {
			throw new Error(`Invalid object key segment: ${JSON.stringify(part)}`);
		}
	}
	return `tenants/${parts.join("/")}`;
}

export function tenantObjectPrefix(tenantId: string, ...segments: string[]): string {
	return `${tenantObjectKey(tenantId, ...segments)}/`;
}

/** In-process store for tests and for deployments that have not configured object storage. */
export class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, { body: Uint8Array; meta: ObjectMeta }>();

	async put(key: string, body: Uint8Array, options?: PutObjectOptions): Promise<ObjectMeta> {
		const meta: ObjectMeta = { key, size: body.byteLength, sha256: sha256Hex(body), ...(options?.contentType ? { contentType: options.contentType } : {}) };
		this.objects.set(key, { body: Uint8Array.from(body), meta });
		return meta;
	}

	async get(key: string): Promise<Uint8Array | null> {
		const found = this.objects.get(key);
		return found ? Uint8Array.from(found.body) : null;
	}

	async head(key: string): Promise<ObjectMeta | null> {
		return this.objects.get(key)?.meta ?? null;
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async deletePrefix(prefix: string): Promise<number> {
		let removed = 0;
		for (const key of [...this.objects.keys()]) {
			if (key.startsWith(prefix) && this.objects.delete(key)) removed++;
		}
		return removed;
	}

	async list(prefix: string): Promise<ObjectMeta[]> {
		return [...this.objects.values()].map((entry) => entry.meta).filter((meta) => meta.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
	}
}
