import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { sha256Hex, type ObjectMeta, type ObjectStore, type PutObjectOptions } from "./object-store.js";

export interface S3ObjectStoreConfig {
	bucket: string;
	/** Alibaba Cloud OSS: https://oss-cn-hangzhou.aliyuncs.com. MinIO: http://127.0.0.1:9000. AWS S3 when omitted. */
	endpoint?: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** MinIO needs path-style addressing; OSS and S3 use virtual-hosted style. */
	forcePathStyle: boolean;
}

const SHA256_METADATA = "sha256";

function isNotFound(err: unknown): boolean {
	const value = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return value?.name === "NotFound" || value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404;
}

export class S3ObjectStore implements ObjectStore {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(config: S3ObjectStoreConfig, client?: S3Client) {
		this.bucket = config.bucket;
		const options: S3ClientConfig = {
			region: config.region,
			...(config.endpoint ? { endpoint: config.endpoint } : {}),
			forcePathStyle: config.forcePathStyle,
			credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
			// OSS and MinIO do not implement the SDK's newer default checksum trailers.
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
		};
		this.client = client ?? new S3Client(options);
	}

	async put(key: string, body: Uint8Array, options?: PutObjectOptions): Promise<ObjectMeta> {
		const sha256 = sha256Hex(body);
		await this.client.send(new PutObjectCommand({
			Bucket: this.bucket,
			Key: key,
			Body: body,
			...(options?.contentType ? { ContentType: options.contentType } : {}),
			Metadata: { [SHA256_METADATA]: sha256 },
		}));
		return { key, size: body.byteLength, sha256, ...(options?.contentType ? { contentType: options.contentType } : {}) };
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
			return result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async head(key: string): Promise<ObjectMeta | null> {
		try {
			const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
			return {
				key,
				size: result.ContentLength ?? 0,
				sha256: result.Metadata?.[SHA256_METADATA] ?? "",
				...(result.ContentType ? { contentType: result.ContentType } : {}),
			};
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async delete(key: string): Promise<void> {
		await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
	}

	async deletePrefix(prefix: string): Promise<number> {
		let removed = 0;
		for (;;) {
			// Always re-list from the start: deleted keys drop out, so there is no cursor to carry.
			const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000 }));
			const keys = (page.Contents ?? []).flatMap((entry) => (entry.Key ? [entry.Key] : []));
			if (keys.length === 0) return removed;
			const result = await this.client.send(new DeleteObjectsCommand({
				Bucket: this.bucket,
				Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
			}));
			if (result.Errors?.length) throw new Error(`Failed to delete ${result.Errors.length} objects under ${prefix}: ${result.Errors[0]?.Message ?? ""}`);
			removed += keys.length;
		}
	}

	async list(prefix: string): Promise<ObjectMeta[]> {
		const found: ObjectMeta[] = [];
		let token: string | undefined;
		do {
			const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
			for (const entry of page.Contents ?? []) {
				if (entry.Key) found.push({ key: entry.Key, size: entry.Size ?? 0, sha256: "" });
			}
			token = page.IsTruncated ? page.NextContinuationToken : undefined;
		} while (token);
		return found.sort((a, b) => a.key.localeCompare(b.key));
	}
}
