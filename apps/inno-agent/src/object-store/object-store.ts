import { createHash } from "node:crypto";

export interface ObjectMeta {
	key: string;
	size: number;
	/** Lower-case hex SHA-256 of the body. */
	sha256: string;
	contentType?: string;
	/** Object creation/modification time; used by the orphan sweep's grace window. */
	mtimeMs?: number;
}

export interface PutObjectOptions {
	contentType?: string;
}

export interface PresignOptions {
	/** Seconds until the URL stops working. Callers pick per use (upload: minutes). */
	expiresInSeconds?: number;
	contentType?: string;
	/** presignGet only: Content-Disposition header the storage returns to the browser. */
	contentDisposition?: string;
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
	/**
	 * Optional (T1.5): a short-lived URL a browser can PUT bytes to directly.
	 * Providers that cannot vend signed URLs (fs, memory) leave this undefined
	 * and callers fall back to proxying through the API.
	 */
	presignPut?(key: string, options?: PresignOptions): Promise<string>;
	/** Optional (T1.5): a short-lived URL a browser can GET bytes from directly. */
	presignGet?(key: string, options?: PresignOptions): Promise<string>;
}

export function sha256Hex(body: Uint8Array): string {
	return createHash("sha256").update(body).digest("hex");
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertKeySegments(parts: string[]): void {
	for (const part of parts) {
		if (!SEGMENT.test(part) || part === "." || part === "..") {
			throw new Error(`Invalid object key segment: ${JSON.stringify(part)}`);
		}
	}
}

/**
 * Build a tenant-scoped object key. Every segment must be a plain name: no
 * separators, no `.` / `..`, so a tenant can never address another tenant's
 * prefix through a crafted file name.
 */
export function tenantObjectKey(tenantId: string, ...segments: string[]): string {
	const parts = [tenantId, ...segments];
	assertKeySegments(parts);
	return `tenants/${parts.join("/")}`;
}

export function tenantObjectPrefix(tenantId: string, ...segments: string[]): string {
	return `${tenantObjectKey(tenantId, ...segments)}/`;
}

/**
 * Platform-scoped object key (not under `tenants/`). Used for shared assets
 * such as the published skill catalog.
 */
export function platformObjectKey(...segments: string[]): string {
	if (segments.length === 0) throw new Error("platformObjectKey needs at least one segment");
	assertKeySegments(segments);
	return `platform/${segments.join("/")}`;
}

export function platformObjectPrefix(...segments: string[]): string {
	return `${platformObjectKey(...segments)}/`;
}

/** In-process store for tests and for deployments that have not configured object storage. */
export class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, { body: Uint8Array; meta: ObjectMeta }>();

	async put(key: string, body: Uint8Array, options?: PutObjectOptions): Promise<ObjectMeta> {
		const meta: ObjectMeta = { key, size: body.byteLength, sha256: sha256Hex(body), ...(options?.contentType ? { contentType: options.contentType } : {}), mtimeMs: Date.now() };
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
