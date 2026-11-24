import { FsObjectStore } from "./fs-object-store.js";
import { MemoryObjectStore, type ObjectStore } from "./object-store.js";
import { S3ObjectStore, type S3ObjectStoreConfig } from "./s3-object-store.js";

export * from "./object-store.js";
export { FsObjectStore } from "./fs-object-store.js";
export { S3ObjectStore, type S3ObjectStoreConfig } from "./s3-object-store.js";

/**
 * Platform-level object storage. Read from the server's own config and
 * environment, never from a tenant's config.
 */
export interface InnoObjectStorageConfig {
	/** "memory" keeps objects in process; "fs" mirrors keys under `fsRoot` (single-host or tests); "s3" targets OSS, MinIO or S3. */
	provider: "memory" | "fs" | "s3";
	fsRoot?: string;
	bucket?: string;
	endpoint?: string;
	/** Browser-facing endpoint for presigned URLs when it differs from `endpoint`. */
	publicEndpoint?: string;
	region: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	forcePathStyle: boolean;
}

export type RawObjectStorageConfig = Partial<InnoObjectStorageConfig>;

export function normalizeObjectStorageConfig(raw: RawObjectStorageConfig | undefined, env: NodeJS.ProcessEnv = process.env): InnoObjectStorageConfig {
	const text = (value: unknown, fallback?: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback?.trim() || undefined);
	const endpoint = text(raw?.endpoint, env.INNO_OBJECT_STORAGE_ENDPOINT);
	const publicEndpoint = text(raw?.publicEndpoint, env.INNO_OBJECT_STORAGE_PUBLIC_ENDPOINT);
	const bucket = text(raw?.bucket, env.INNO_OBJECT_STORAGE_BUCKET);
	const accessKeyId = text(raw?.accessKeyId, env.INNO_OBJECT_STORAGE_ACCESS_KEY_ID);
	const secretAccessKey = text(raw?.secretAccessKey, env.INNO_OBJECT_STORAGE_SECRET_ACCESS_KEY);
	const rawProvider = raw?.provider ?? text(env.INNO_OBJECT_STORAGE_PROVIDER);
	const provider = rawProvider === "s3" || rawProvider === "fs" || rawProvider === "memory"
		? rawProvider
		: (bucket && accessKeyId) ? "s3" : "memory";
	const fsRoot = text(raw?.fsRoot, env.INNO_OBJECT_STORAGE_DIR);
	const pathStyleEnv = env.INNO_OBJECT_STORAGE_FORCE_PATH_STYLE;
	return {
		provider,
		...(fsRoot ? { fsRoot } : {}),
		...(bucket ? { bucket } : {}),
		...(endpoint ? { endpoint } : {}),
		...(publicEndpoint ? { publicEndpoint } : {}),
		region: text(raw?.region, env.INNO_OBJECT_STORAGE_REGION) ?? "us-east-1",
		...(accessKeyId ? { accessKeyId } : {}),
		...(secretAccessKey ? { secretAccessKey } : {}),
		// A custom endpoint that is not OSS (MinIO and friends) needs path-style addressing.
		forcePathStyle: typeof raw?.forcePathStyle === "boolean"
			? raw.forcePathStyle
			: pathStyleEnv !== undefined ? pathStyleEnv === "true" : Boolean(endpoint && !/aliyuncs\.com/i.test(endpoint)),
	};
}

/**
 * Whether the provider keeps bytes beyond this process. The `memory` store
 * loses objects on restart — manifests must not treat it as the source of
 * truth for reads (the local workspace dir is, with the replica as mirror).
 */
export function isDurableObjectStorageProvider(provider: InnoObjectStorageConfig["provider"]): boolean {
	return provider !== "memory";
}

export function createObjectStore(config: InnoObjectStorageConfig): ObjectStore {
	if (config.provider === "memory") return new MemoryObjectStore();
	if (config.provider === "fs") {
		if (!config.fsRoot) throw new Error("Filesystem object storage needs INNO_OBJECT_STORAGE_DIR");
		return new FsObjectStore(config.fsRoot);
	}
	if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
		throw new Error("Object storage needs bucket, accessKeyId and secretAccessKey (INNO_OBJECT_STORAGE_BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY)");
	}
	const s3: S3ObjectStoreConfig = {
		bucket: config.bucket,
		...(config.endpoint ? { endpoint: config.endpoint } : {}),
		...(config.publicEndpoint ? { publicEndpoint: config.publicEndpoint } : {}),
		region: config.region,
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		forcePathStyle: config.forcePathStyle,
	};
	return new S3ObjectStore(s3);
}
