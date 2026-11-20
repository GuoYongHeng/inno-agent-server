import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { S3ObjectStore } from "./s3-object-store.js";
import { tenantObjectKey, tenantObjectPrefix } from "./object-store.js";

// Needs an S3-compatible endpoint, e.g. a local MinIO:
//   INNO_TEST_S3_ENDPOINT=http://127.0.0.1:59000 INNO_TEST_S3_ACCESS_KEY=... INNO_TEST_S3_SECRET_KEY=...
const endpoint = process.env.INNO_TEST_S3_ENDPOINT;
const accessKeyId = process.env.INNO_TEST_S3_ACCESS_KEY ?? "";
const secretAccessKey = process.env.INNO_TEST_S3_SECRET_KEY ?? "";
const bucket = `inno-test-${randomUUID().slice(0, 8)}`;
const bytes = (text: string) => new TextEncoder().encode(text);

describe.skipIf(!endpoint)("S3ObjectStore against an S3-compatible endpoint", () => {
	let store: S3ObjectStore;

	beforeAll(async () => {
		const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
		store = new S3ObjectStore({ bucket, endpoint, region: "us-east-1", accessKeyId, secretAccessKey, forcePathStyle: true });
	});

	afterAll(async () => {
		await store?.deletePrefix("");
	});

	it("round-trips an object with its checksum and content type", async () => {
		const key = tenantObjectKey("t1", "l2", "raw", "a.pdf");
		const meta = await store.put(key, bytes("%PDF-1.7 中文"), { contentType: "application/pdf" });
		const head = await store.head(key);
		expect(head).toMatchObject({ key, size: meta.size, sha256: meta.sha256, contentType: "application/pdf" });
		expect(new TextDecoder().decode((await store.get(key))!)).toBe("%PDF-1.7 中文");
	});

	it("returns null for missing objects and tolerates deleting them", async () => {
		expect(await store.get("tenants/t1/none")).toBeNull();
		expect(await store.head("tenants/t1/none")).toBeNull();
		await store.delete("tenants/t1/none");
	});

	it("lists and deletes by tenant prefix across more than one page", async () => {
		for (let i = 0; i < 1005; i += 1) await store.put(tenantObjectKey("bulk", "f", `${String(i).padStart(4, "0")}.txt`), bytes("x"));
		await store.put(tenantObjectKey("bulk2", "f", "keep.txt"), bytes("y"));
		expect((await store.list(tenantObjectPrefix("bulk"))).length).toBe(1005);
		expect(await store.deletePrefix(tenantObjectPrefix("bulk"))).toBe(1005);
		expect(await store.list(tenantObjectPrefix("bulk"))).toEqual([]);
		expect(await store.head(tenantObjectKey("bulk2", "f", "keep.txt"))).not.toBeNull();
	}, 120_000);
});
