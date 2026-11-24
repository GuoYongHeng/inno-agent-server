import { mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";

import type { ConversationId, ConversationRecord, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { TenantStore, type TenantContext } from "../tenants/store.js";
import { setRequestTenant } from "../tenants/http.js";
import type { IncomingMessage } from "node:http";
import { PgSessionCatalog } from "./pg-session-catalog.js";
import { DurableStorageFencedError, PgDurableStorage } from "./pg-durable-storage.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
let catalog: PgSessionCatalog;
let dir: string;
const tenant = { tenantId: "", userId: "user-a", role: "owner" } as TenantContext;
let reqA: IncomingMessage;

async function createUser(id: string) {
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, NOW(), NOW())`,
		[id, id, `${id}@example.com`]);
}

async function createSession(): Promise<string> {
	const id = randomUUID();
	await catalog.insert(reqA, {
		id, workspaceId: "w", name: "会话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		messageCount: 0, preview: "", provider: "p", modelId: "m", origin: "web", archived: false,
	});
	return id;
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "durable-storage-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	await createUser("user-a");
	tenant.tenantId = (await store.ensurePersonalTenant("user-a")).tenantId;
	reqA = { headers: {} } as IncomingMessage;
	setRequestTenant(reqA, tenant, store);
	dir = mkdtempSync(join(tmpdir(), "inno-pgdurable-"));
	catalog = new PgSessionCatalog(pool);
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	rmSync(dir, { recursive: true, force: true });
});

const assertions: StorageConformanceAssertions = {
	ok: (value, message) => expect(value, message).toBeTruthy(),
	strictEqual: (actual, expected) => expect(actual).toBe(expected),
	deepEqual: (actual, expected) => expect(actual).toEqual(expected),
	partialDeepEqual: (actual, expected) => expect(actual).toMatchObject(expected as object),
	greaterThan: (actual, expected) => expect(actual).toBeGreaterThan(expected),
	rejects: async (operation, messageIncludes) => {
		await expect(operation).rejects.toThrow(messageIncludes);
	},
};

describe("PgDurableStorage conformance", () => {
	for (const conformanceCase of createStorageConformance({
		assertions,
		withStorage: async (use) => {
			const sessionId = await createSession();
			const storage = await PgDurableStorage.open(pool, sessionId);
			try {
				await use(storage);
			} finally {
				await storage.close(BACKGROUND_CONTEXT);
			}
		},
	})) {
		it(conformanceCase.name, async () => {
			await conformanceCase.run();
		}, 30_000);
	}
});

describe("PgDurableStorage lease and fencing", () => {
	it("claims, renews and releases a storage lease", async () => {
		const sessionId = await createSession();
		// A live owner holds the advisory lock alongside the lease; without it
		// the recorded owner is treated as provably dead and claimable.
		const lock = await store.acquireDurableStorageLock(tenant, sessionId);
		expect(lock).not.toBeNull();
		try {
			const epoch = await store.claimDurableStorage(tenant, sessionId, "worker-1", 10_000, lock!.backendPid);
			expect(epoch).not.toBeNull();
			// A competing worker cannot claim while the lease is live.
			expect(await store.claimDurableStorage(tenant, sessionId, "worker-2", 10_000)).toBeNull();
			expect(await store.renewDurableStorage(sessionId, "worker-1", epoch!, 10_000)).toBe(true);
			// A stale epoch cannot renew.
			expect(await store.renewDurableStorage(sessionId, "worker-1", epoch! + 99, 10_000)).toBe(false);
			await store.releaseDurableStorage(sessionId, epoch!);
			expect(await store.claimDurableStorage(tenant, sessionId, "worker-2", 10_000)).not.toBeNull();
		} finally {
			await lock!.release();
		}
	});

	it("fences commits and mints once the lease epoch was taken over", async () => {
		const sessionId = await createSession();
		const epoch = await store.claimDurableStorage(tenant, sessionId, "worker-1", 60_000);
		expect(epoch).not.toBeNull();
		const storage = await PgDurableStorage.open(pool, sessionId, { leaseEpoch: epoch! });
		const conversationId = await storage.mintId<ConversationId>();
		const seq = await storage.commit([{
			type: "conversation",
			value: { id: conversationId } as ConversationRecord,
		}], BACKGROUND_CONTEXT);
		expect(seq).toBeGreaterThanOrEqual(1);
		// The owner dies without releasing; the lease expires and worker-2 steals it.
		await pool.query("UPDATE ds_metadata SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1", [sessionId]);
		const stolen = await store.claimDurableStorage(tenant, sessionId, "worker-2", 60_000);
		expect(stolen).not.toBeNull();
		expect(stolen).not.toBe(epoch);
		// The fenced-out owner's writes and mints now fail fatally.
		const entryId = (Number(conversationId) + 1) as EntryId;
		await expect(storage.commit([{
			type: "entry",
			value: { id: entryId, conversationId, kind: "note" } as EntryRecord,
		}], BACKGROUND_CONTEXT)).rejects.toThrow(DurableStorageFencedError);
		await expect(storage.mintId()).rejects.toThrow(DurableStorageFencedError);
		// The new owner writes normally under its own epoch.
		const successor = await PgDurableStorage.open(pool, sessionId, { leaseEpoch: stolen! });
		const nextId = await successor.mintId();
		expect(Number(nextId)).toBeGreaterThan(Number(conversationId));
		await storage.close(BACKGROUND_CONTEXT);
		await successor.close(BACKGROUND_CONTEXT);
	});

	it("isolates records and counters between sessions", async () => {
		const first = await createSession();
		const second = await createSession();
		const a = await PgDurableStorage.open(pool, first);
		const b = await PgDurableStorage.open(pool, second);
		try {
			// IDs mint in a per-session namespace, exactly like one SQLite file each.
			const idA = await a.mintId();
			const idB = await b.mintId();
			expect(Number(idA)).toBe(Number(idB));
			await a.commit([{ type: "conversation", value: { id: idA } as ConversationRecord }], BACKGROUND_CONTEXT);
			// The other session's scan stays empty and its rows stay invisible.
			expect((await b.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items).toHaveLength(0);
			expect(await b.conversation(idA as never, BACKGROUND_CONTEXT)).toBeUndefined();
		} finally {
			await a.close(BACKGROUND_CONTEXT);
			await b.close(BACKGROUND_CONTEXT);
		}
	});
});

describe("PgDurableStorage legacy import", () => {
});
