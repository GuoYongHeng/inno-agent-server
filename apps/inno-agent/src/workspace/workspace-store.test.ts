import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import type { TenantStore } from "../tenants/store.js";
import { FakeTenantStore, ctxA, ctxB } from "./fake-tenant-store.js";
import { LocalFsWorkspaceStore } from "./local-fs-workspace-store.js";
import { ObjectWorkspaceStore } from "./object-workspace-store.js";
import { workspaceObjectKey } from "./workspace-object-key.js";
import { runWorkspaceStoreContract } from "./workspace-store.contract.js";
import type { WorkspaceStore } from "./workspace-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-wsstore-"));
	roots.push(root);
	return root;
}

runWorkspaceStoreContract("LocalFsWorkspaceStore", () => {
	const dir = join(tempRoot(), "ws");
	mkdirSync(dir, { recursive: true });
	return { store: new LocalFsWorkspaceStore({ resolveRoot: () => dir }), workspaceId: "ws-1" };
});

runWorkspaceStoreContract("ObjectWorkspaceStore", () => {
	const tenants = new FakeTenantStore();
	const objects = new MemoryObjectStore();
	return {
		store: new ObjectWorkspaceStore({ objects, store: tenants as unknown as TenantStore, context: ctxA }),
		workspaceId: "ws-1",
	};
});

describe("LocalFsWorkspaceStore symlink safety", () => {
	it("does not read or list links that escape the workspace root", async () => {
		const root = tempRoot();
		const dir = join(root, "ws");
		mkdirSync(dir, { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(dir, "escape.txt"));
		symlinkSync(outside, join(dir, "escape-dir"));
		symlinkSync(join(dir, "missing-target"), join(dir, "broken.txt"));
		writeFileSync(join(dir, "normal.txt"), "ok");
		const store = new LocalFsWorkspaceStore({ resolveRoot: () => dir });

		expect((await store.list("ws", "")).entries.map((entry) => entry.name)).toEqual(["normal.txt"]);
		expect(await store.read("ws", "escape.txt")).toBeNull();
		expect(await store.stat("ws", "escape.txt")).toBeNull();
		expect(await store.stat("ws", "escape-dir/secret.txt")).toBeNull();
		// The broken symlink is skipped, not fatal.
		expect((await store.list("ws", "")).entries).toHaveLength(1);
	});
});

describe("ObjectWorkspaceStore manifest/object consistency", () => {
	function setup() {
		const tenants = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		const store = new ObjectWorkspaceStore({ objects, store: tenants as unknown as TenantStore, context: ctxA });
		return { tenants, objects, store };
	}

	it("keeps a manifest row and object bytes under workspaceObjectKey after write", async () => {
		const { tenants, objects, store } = setup();
		await store.write("ws-1", "dir/file.txt", new Uint8Array([1, 2]));
		expect(await tenants.getWorkspaceFile(ctxA, "ws-1", "dir/file.txt")).toMatchObject({ kind: "file", size: 2 });
		expect(await objects.get(workspaceObjectKey(ctxA.tenantId, "ws-1", "dir/file.txt"))).toEqual(new Uint8Array([1, 2]));
	});

	it("removes both the manifest row and the object on remove", async () => {
		const { tenants, objects, store } = setup();
		await store.write("ws-1", "file.txt", new Uint8Array([1]));
		await store.remove("ws-1", "file.txt");
		expect(await tenants.getWorkspaceFile(ctxA, "ws-1", "file.txt")).toBeNull();
		expect(await objects.get(workspaceObjectKey(ctxA.tenantId, "ws-1", "file.txt"))).toBeNull();
	});

	it("isolates tenants sharing one manifest and object store", async () => {
		const tenants = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		const storeA = new ObjectWorkspaceStore({ objects, store: tenants as unknown as TenantStore, context: ctxA });
		const storeB = new ObjectWorkspaceStore({ objects, store: tenants as unknown as TenantStore, context: ctxB });
		await storeA.write("shared-ws", "a-only.txt", new Uint8Array([1]));
		expect((await storeB.list("shared-ws", "")).entries).toEqual([]);
		expect(await storeB.stat("shared-ws", "a-only.txt")).toBeNull();
		expect(await storeB.read("shared-ws", "a-only.txt")).toBeNull();
		expect((await list(storeB, "shared-ws", ""))).toEqual([]);
	});
});

async function list(store: WorkspaceStore, ws: string, dir: string): Promise<string[]> {
	const out: string[] = [];
	for await (const entry of store.walk(ws, dir)) out.push(entry.path);
	return out;
}
