import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { migrateAuthDatabase } from "../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { MemoryObjectStore } from "../object-store/object-store.js";
import { TenantStore, type TenantContext } from "../tenants/store.js";
import { ObjectWorkspaceStore } from "./object-workspace-store.js";
import { workspaceObjectKey } from "./workspace-object-key.js";
import { runWorkspaceStoreContract } from "./workspace-store.contract.js";
import { WorkspaceStoreError } from "./workspace-store.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
const objects = new MemoryObjectStore();
const contexts = new Map<string, TenantContext>();

async function createUser(id: string): Promise<void> {
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, false, NOW(), NOW())`,
		[id, `User ${id}`, `${id}@example.com`],
	);
}

async function contextFor(userId: string): Promise<TenantContext> {
	const cached = contexts.get(userId);
	if (cached) return cached;
	const context = await store.ensurePersonalTenant(userId);
	contexts.set(userId, context);
	return context;
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "workspace-store-integration-secret-32c",
		BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	await Promise.all(["contract-user", "iso-user-a", "iso-user-b", "move-user", "adopt-user"].map(createUser));
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
});

let seq = 0;
runWorkspaceStoreContract("ObjectWorkspaceStore (real PostgreSQL)", async () => {
	const context = await contextFor("contract-user");
	return {
		store: new ObjectWorkspaceStore({ objects, store, context }),
		workspaceId: `ws-contract-${seq++}`,
	};
});

describe("ObjectWorkspaceStore cross-tenant isolation", () => {
	it("tenant A's entries are invisible to tenant B for list/stat/walk/move", async () => {
		const ctxA = await contextFor("iso-user-a");
		const ctxB = await contextFor("iso-user-b");
		const wsA = new ObjectWorkspaceStore({ objects, store, context: ctxA });
		const wsB = new ObjectWorkspaceStore({ objects, store, context: ctxB });
		await wsA.write("iso-ws", "private/note.txt", new Uint8Array([1]));

		expect((await wsB.list("iso-ws", "")).entries).toEqual([]);
		expect(await wsB.stat("iso-ws", "private/note.txt")).toBeNull();
		expect(await wsB.read("iso-ws", "private/note.txt")).toBeNull();
		const walked: string[] = [];
		for await (const entry of wsB.walk("iso-ws", "")) walked.push(entry.path);
		expect(walked).toEqual([]);
		// Tenant B cannot move tenant A's row even though the workspace id matches.
		try {
			await wsB.move("iso-ws", "private/note.txt", "stolen.txt");
			expect.unreachable();
		} catch (error) {
			expect((error as WorkspaceStoreError).code).toBe("not_found");
		}
	});

	it("identical workspace ids in two tenants stay fully isolated", async () => {
		const ctxA = await contextFor("iso-user-a");
		const ctxB = await contextFor("iso-user-b");
		const wsA = new ObjectWorkspaceStore({ objects, store, context: ctxA });
		const wsB = new ObjectWorkspaceStore({ objects, store, context: ctxB });
		await wsA.write("shared-ws", "note.txt", new Uint8Array([65]));
		await wsB.write("shared-ws", "note.txt", new Uint8Array([66]));

		// Manifest rows and object bytes are keyed by tenant, so each side sees
		// exactly its own content under the same workspace id and path.
		expect([...(await wsA.read("shared-ws", "note.txt"))!.body]).toEqual([65]);
		expect([...(await wsB.read("shared-ws", "note.txt"))!.body]).toEqual([66]);
		expect((await wsA.list("shared-ws", "")).entries.map((entry) => entry.name)).toEqual(["note.txt"]);
		expect((await wsB.list("shared-ws", "")).entries.map((entry) => entry.name)).toEqual(["note.txt"]);
		await wsA.remove("shared-ws", "note.txt");
		expect(await wsA.read("shared-ws", "note.txt")).toBeNull();
		expect([...(await wsB.read("shared-ws", "note.txt"))!.body]).toEqual([66]);
	});
});

describe("ObjectWorkspaceStore move failure", () => {
	it("a destination collision leaves the manifest unchanged", async () => {
		const ctx = await contextFor("move-user");
		const ws = new ObjectWorkspaceStore({ objects, store, context: ctx });
		await ws.write("move-ws", "src/f.txt", new Uint8Array([9]));
		await ws.write("move-ws", "dst/exists.txt", new Uint8Array([8]));
		const before = await store.listWorkspaceFiles(ctx, "move-ws");
		try {
			// "dst" exists as an implied directory (it has a descendant row).
			await ws.move("move-ws", "src", "dst");
			expect.unreachable();
		} catch (error) {
			expect((error as WorkspaceStoreError).code).toBe("exists");
		}
		const after = await store.listWorkspaceFiles(ctx, "move-ws");
		expect(after.map((row) => row.relPath).sort()).toEqual(before.map((row) => row.relPath).sort());
		// Source bytes are still intact and readable.
		expect([...(await ws.read("move-ws", "src/f.txt"))!.body]).toEqual([9]);
	});
});

describe("ObjectWorkspaceStore adopt (T1.5 direct upload)", () => {
	it("registers a manifest row for bytes already in the object store", async () => {
		const ctx = await contextFor("adopt-user");
		const ws = new ObjectWorkspaceStore({ objects, store, context: ctx });
		const key = workspaceObjectKey(ctx.tenantId, "adopt-ws", "docs/big.pdf");
		await objects.put(key, new Uint8Array([1, 2, 3]));

		const entry = await ws.adopt("adopt-ws", "docs/big.pdf", 3);
		expect(entry).toMatchObject({ path: "docs/big.pdf", name: "big.pdf", kind: "file", size: 3 });
		const read = await ws.read("adopt-ws", "docs/big.pdf");
		expect([...read!.body]).toEqual([1, 2, 3]);
		expect((await ws.list("adopt-ws", "docs")).entries.map((item) => item.name)).toEqual(["big.pdf"]);
	});

	it("rejects adopt over a directory or above the size cap", async () => {
		const ctx = await contextFor("adopt-user");
		const ws = new ObjectWorkspaceStore({ objects, store, context: ctx });
		await ws.write("adopt-ws", "dir/file.txt", new Uint8Array([0]));
		try {
			await ws.adopt("adopt-ws", "dir", 10);
			expect.unreachable();
		} catch (error) {
			expect((error as WorkspaceStoreError).code).toBe("is_directory");
		}
		try {
			await ws.adopt("adopt-ws", "huge.bin", 200 * 1024 * 1024);
			expect.unreachable();
		} catch (error) {
			expect((error as WorkspaceStoreError).code).toBe("too_large");
		}
	});
});
