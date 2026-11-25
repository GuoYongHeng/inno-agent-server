import { describe, expect, it } from "vitest";
import { MemoryObjectStore, platformObjectKey, platformObjectPrefix, tenantObjectKey, tenantObjectPrefix } from "./object-store.js";
import { createObjectStore, normalizeObjectStorageConfig } from "./index.js";
import { S3ObjectStore } from "./s3-object-store.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("tenantObjectKey", () => {
	it("scopes keys to the tenant", () => {
		expect(tenantObjectKey("t1", "l2", "raw", "a.pdf")).toBe("tenants/t1/l2/raw/a.pdf");
		expect(tenantObjectPrefix("t1", "l2")).toBe("tenants/t1/l2/");
	});

	it("rejects separators and dot segments", () => {
		for (const bad of ["../x", "a/b", "..", ".", "", "a b"]) {
			expect(() => tenantObjectKey("t1", bad)).toThrow(/Invalid object key segment/);
		}
		expect(() => tenantObjectKey("t/1", "x")).toThrow(/Invalid object key segment/);
	});

	it("does not let one tenant's prefix match another's", () => {
		expect(tenantObjectKey("t10", "a").startsWith(tenantObjectPrefix("t1"))).toBe(false);
	});
});

describe("platformObjectKey", () => {
	it("builds keys under platform/ and rejects bad segments", () => {
		expect(platformObjectKey("skills", "demo", "abc123", "file")).toBe("platform/skills/demo/abc123/file");
		expect(platformObjectPrefix("skills", "demo")).toBe("platform/skills/demo/");
		expect(platformObjectKey("skills", "demo").startsWith("tenants/")).toBe(false);
		for (const bad of ["../x", "a/b", "..", ".", "", "a b"]) {
			expect(() => platformObjectKey("skills", bad)).toThrow(/Invalid object key segment/);
		}
		expect(() => platformObjectKey()).toThrow(/at least one segment/);
	});
});

describe("MemoryObjectStore", () => {
	it("stores, reads and describes objects", async () => {
		const store = new MemoryObjectStore();
		const meta = await store.put("tenants/t1/a.txt", bytes("hello"), { contentType: "text/plain" });
		expect(meta.size).toBe(5);
		expect(meta.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
		expect(new TextDecoder().decode((await store.get("tenants/t1/a.txt"))!)).toBe("hello");
		expect(await store.head("tenants/t1/a.txt")).toEqual(meta);
		expect(await store.get("missing")).toBeNull();
		expect(await store.head("missing")).toBeNull();
	});

	it("does not alias the caller's buffer", async () => {
		const store = new MemoryObjectStore();
		const body = bytes("abc");
		await store.put("k", body);
		body[0] = 0;
		expect(new TextDecoder().decode((await store.get("k"))!)).toBe("abc");
	});

	it("lists and deletes by prefix without touching siblings", async () => {
		const store = new MemoryObjectStore();
		await store.put("tenants/t1/a", bytes("1"));
		await store.put("tenants/t1/b", bytes("2"));
		await store.put("tenants/t10/a", bytes("3"));
		expect((await store.list(tenantObjectPrefix("t1"))).map((m) => m.key)).toEqual(["tenants/t1/a", "tenants/t1/b"]);
		expect(await store.deletePrefix(tenantObjectPrefix("t1"))).toBe(2);
		expect(await store.head("tenants/t10/a")).not.toBeNull();
		await store.delete("tenants/t10/a");
		await store.delete("tenants/t10/a");
		expect(await store.list("")).toEqual([]);
	});
});

describe("normalizeObjectStorageConfig", () => {
	it("defaults to the in-memory store", () => {
		expect(normalizeObjectStorageConfig(undefined, {}).provider).toBe("memory");
		expect(createObjectStore(normalizeObjectStorageConfig(undefined, {}))).toBeInstanceOf(MemoryObjectStore);
	});

	it("reads MinIO settings from the environment with path-style addressing", () => {
		const config = normalizeObjectStorageConfig(undefined, {
			INNO_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
			INNO_OBJECT_STORAGE_BUCKET: "inno",
			INNO_OBJECT_STORAGE_ACCESS_KEY_ID: "k",
			INNO_OBJECT_STORAGE_SECRET_ACCESS_KEY: "s",
		});
		expect(config).toMatchObject({ provider: "s3", bucket: "inno", forcePathStyle: true, region: "us-east-1" });
	});

	it("uses virtual-hosted addressing for Alibaba Cloud OSS", () => {
		const config = normalizeObjectStorageConfig({ endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "oss-cn-hangzhou", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }, {});
		expect(config).toMatchObject({ provider: "s3", forcePathStyle: false, region: "oss-cn-hangzhou" });
	});

	it("config values win over the environment and an explicit flag wins over the guess", () => {
		const config = normalizeObjectStorageConfig(
			{ bucket: "from-config", forcePathStyle: false, endpoint: "http://minio:9000", accessKeyId: "k", secretAccessKey: "s" },
			{ INNO_OBJECT_STORAGE_BUCKET: "from-env" },
		);
		expect(config.bucket).toBe("from-config");
		expect(config.forcePathStyle).toBe(false);
	});

	it("refuses an s3 provider without credentials", () => {
		expect(() => createObjectStore(normalizeObjectStorageConfig({ provider: "s3", bucket: "b" }, {}))).toThrow(/accessKeyId/);
	});
});

describe("S3ObjectStore presign (offline signing)", () => {
	const store = new S3ObjectStore({
		bucket: "inno", endpoint: "http://127.0.0.1:9000", region: "us-east-1",
		accessKeyId: "key", secretAccessKey: "secret", forcePathStyle: true,
	});

	it("signs a PUT URL containing the key and a signature", async () => {
		const url = await store.presignPut!("tenants/t1/workspaces/abc/x");
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/inno/tenants/t1/workspaces/abc/x");
		expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
		expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
	});

	it("signs a GET URL and carries response content-disposition", async () => {
		const url = await store.presignGet!("tenants/t1/workspaces/abc/x", {
			expiresInSeconds: 300,
			contentDisposition: 'attachment; filename="report.pdf"',
		});
		const parsed = new URL(url);
		expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(parsed.searchParams.get("response-content-disposition")).toBe('attachment; filename="report.pdf"');
	});
});
