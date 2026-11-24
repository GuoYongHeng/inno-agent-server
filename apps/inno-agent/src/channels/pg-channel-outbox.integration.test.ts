import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { TenantStore } from "../tenants/store.js";
import { type ChannelOutboxRecord } from "./channel-outbox.js";
import { MAX_OUTBOX_PAYLOAD_BYTES, PgChannelOutbox } from "./pg-channel-outbox.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let a = "";
let b = "";
const sessionA = "durable-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const sessionA2 = "durable-cccccccc-cccc-cccc-cccc-cccccccccccc";
const sessionB = "durable-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const scratch: string[] = [];

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-outbox-test-"));
	scratch.push(dir);
	return dir;
}

const record = (session: string, call: string, over: Partial<ChannelOutboxRecord> = {}): ChannelOutboxRecord => ({
	operationId: `send_file_to_channel:${session}:${call}`,
	channel: "feishu",
	chatId: "chat-1",
	filePath: "notes/中文 课件.pdf",
	...over,
});

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "outbox-integration-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	for (const id of ["user-a", "user-b"]) {
		await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $2, false, NOW(), NOW())`, [id, `${id}@example.com`]);
	}
	const tenants = new TenantStore(pool);
	a = (await tenants.ensurePersonalTenant("user-a")).tenantId;
	b = (await tenants.ensurePersonalTenant("user-b")).tenantId;
	for (const [tenant, id] of [[a, sessionA], [a, sessionA2], [b, sessionB]] as const) {
		await pool.query("INSERT INTO resource_ownership (tenant_id, resource_type, resource_id) VALUES ($1, 'session', $2)", [tenant, id]);
	}
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("PgChannelOutbox", () => {
	it("snapshots a file so another worker can resume the send after the original changes", async () => {
		const dir = workdir();
		const source = join(dir, "课件.pdf");
		const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
		writeFileSync(source, bytes);
		const sender = new PgChannelOutbox(pool, a);
		const intent = record(sessionA, "call-1", { fileName: "课件.pdf" });
		const first = await sender.prepare(intent, source);
		expect(readFileSync(first.path).equals(bytes)).toBe(true);
		first.cleanup();
		expect(existsSync(first.path)).toBe(false);

		writeFileSync(source, "changed after the intent was committed");
		const otherWorker = new PgChannelOutbox(pool, a);
		const loaded = await otherWorker.load(intent.operationId);
		expect(loaded).toEqual(intent);
		const resumed = await otherWorker.payload(loaded!);
		expect(readFileSync(resumed!.path).equals(bytes)).toBe(true);
		expect(resumed!.path.endsWith("课件.pdf")).toBe(true);
		resumed!.cleanup();
	});

	it("records completion so a replay returns it without a payload", async () => {
		const dir = workdir();
		const source = join(dir, "a.txt");
		writeFileSync(source, "x");
		const outbox = new PgChannelOutbox(pool, a);
		const intent = record(sessionA, "call-done");
		(await outbox.prepare(intent, source)).cleanup();
		await outbox.complete(intent, { text: "sent", details: { ok: true } });
		expect((await new PgChannelOutbox(pool, a).load(intent.operationId))?.completion).toEqual({ text: "sent", details: { ok: true } });
	});

	it("never shows one tenant's outbox to another", async () => {
		const outbox = new PgChannelOutbox(pool, a);
		expect(await new PgChannelOutbox(pool, b).load(record(sessionA, "call-1").operationId)).toBeUndefined();
		expect(await outbox.load(record(sessionA, "call-1").operationId)).toBeDefined();
	});

	it("prunes only this session's expired completions and their payloads", async () => {
		const dir = workdir();
		const source = join(dir, "a.txt");
		writeFileSync(source, "payload");
		const outbox = new PgChannelOutbox(pool, a);
		const done = record(sessionA2, "prune-done");
		const pending = record(sessionA2, "prune-pending");
		const otherSession = record(sessionA, "prune-other");
		for (const intent of [done, pending, otherSession]) (await outbox.prepare(intent, source)).cleanup();
		await outbox.complete(done, { text: "sent", details: {} });
		await outbox.complete(otherSession, { text: "sent", details: {} });

		expect(await outbox.pruneCompletedForIdleSession(sessionA2, Date.now() - 60_000)).toBe(0);
		expect(await outbox.pruneCompletedForIdleSession(sessionA2, Date.now() + 1_000)).toBe(1);
		expect(await outbox.load(done.operationId)).toBeUndefined();
		expect(await outbox.payload(done)).toBeUndefined();
		expect(await outbox.load(pending.operationId)).toBeDefined();
		expect(await outbox.payload(pending)).toBeDefined();
		expect(await outbox.load(otherSession.operationId)).toBeDefined();

		expect(await outbox.deleteSession(sessionA2)).toBe(1);
		expect(await outbox.load(pending.operationId)).toBeUndefined();
		expect(await outbox.payload(pending)).toBeUndefined();
		expect((await pool.query("SELECT COUNT(*)::int AS n FROM recovery_blobs WHERE tenant_id = $1 AND session_id = $2", [a, sessionA2])).rows[0].n).toBe(0);
	});

	it("refuses a payload over the size limit and leaves nothing behind", async () => {
		const dir = workdir();
		const source = join(dir, "big.bin");
		writeFileSync(source, "");
		// A sparse file avoids allocating the limit in the test.
		const fd = await import("node:fs").then((fs) => fs.openSync(source, "w"));
		(await import("node:fs")).ftruncateSync(fd, MAX_OUTBOX_PAYLOAD_BYTES + 1);
		(await import("node:fs")).closeSync(fd);
		const outbox = new PgChannelOutbox(pool, a);
		const intent = record(sessionA, "call-big");
		await expect(outbox.prepare(intent, source)).rejects.toThrow(/outbox limit/);
		expect(await outbox.load(intent.operationId)).toBeUndefined();
	});

});

describe("OCR checkpoints on PostgreSQL", () => {
});
