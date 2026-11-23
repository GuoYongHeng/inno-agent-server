import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import type { TenantContext, TenantStore, WorkspaceFileRow } from "../tenants/store.js";
import { LocalFsWorkspaceStore } from "./local-fs-workspace-store.js";
import { ObjectWorkspaceStore } from "./object-workspace-store.js";
import { workspaceObjectKey } from "./workspace-object-key.js";
import { runWorkspaceStoreContract } from "./workspace-store.contract.js";
import { WorkspaceStoreError, type WorkspaceStore } from "./workspace-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-wsstore-"));
	roots.push(root);
	return root;
}

/** In-memory TenantStore: the exact workspace_files surface the stores use. */
class FakeTenantStore {
	readonly rows = new Map<string, WorkspaceFileRow>();

	private key(context: TenantContext, workspaceId: string, relPath: string): string {
		return `${context.tenantId}/${workspaceId}/${relPath}`;
	}

	async getWorkspaceFile(context: TenantContext, workspaceId: string, relPath: string): Promise<WorkspaceFileRow | null> {
		return this.rows.get(this.key(context, workspaceId, relPath)) ?? null;
	}

	async listWorkspaceFilesUnder(context: TenantContext, workspaceId: string, prefix: string, limit: number): Promise<WorkspaceFileRow[]> {
		const base = `${context.tenantId}/${workspaceId}/`;
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(base) && key.slice(base.length).startsWith(prefix))
			.map(([, row]) => row)
			.sort((a, b) => a.relPath.localeCompare(b.relPath))
			.slice(0, limit);
	}

	async summarizeWorkspacePrefix(context: TenantContext, workspaceId: string, prefix: string): Promise<{ count: number; maxMtimeMs: number }> {
		const base = `${context.tenantId}/${workspaceId}/`;
		let count = 0;
		let maxMtimeMs = 0;
		for (const [key, row] of this.rows.entries()) {
			if (!key.startsWith(base) || !key.slice(base.length).startsWith(prefix)) continue;
			count++;
			maxMtimeMs = Math.max(maxMtimeMs, row.mtimeMs);
		}
		return { count, maxMtimeMs };
	}

	async putWorkspaceFile(context: TenantContext, workspaceId: string, row: WorkspaceFileRow): Promise<void> {
		this.rows.set(this.key(context, workspaceId, row.relPath), { ...row });
	}

	async deleteWorkspaceFiles(context: TenantContext, workspaceId: string, path: string, descendants: boolean): Promise<WorkspaceFileRow[]> {
		const removed: WorkspaceFileRow[] = [];
		const base = `${context.tenantId}/${workspaceId}/`;
		for (const [key, row] of [...this.rows.entries()]) {
			if (!key.startsWith(base)) continue;
			const rel = key.slice(base.length);
			if (rel === path || (descendants && rel.startsWith(`${path}/`))) {
				this.rows.delete(key);
				removed.push(row);
			}
		}
		return removed;
	}

	async moveWorkspaceFiles(context: TenantContext, workspaceId: string, from: string, to: string): Promise<WorkspaceFileRow[]> {
		const base = `${context.tenantId}/${workspaceId}/`;
		const conflict = [...this.rows.keys()].some((key) => {
			if (!key.startsWith(base)) return false;
			const rel = key.slice(base.length);
			return rel === to || rel.startsWith(`${to}/`);
		});
		if (conflict) throw new WorkspaceStoreError("exists", `destination exists: ${to}`, to);
		const moved: WorkspaceFileRow[] = [];
		for (const [key, row] of [...this.rows.entries()]) {
			if (!key.startsWith(base)) continue;
			const rel = key.slice(base.length);
			if (rel === from || rel.startsWith(`${from}/`)) {
				this.rows.delete(key);
				moved.push(row);
			}
		}
		for (const row of moved) {
			this.rows.set(this.key(context, workspaceId, to + row.relPath.slice(from.length)), row);
		}
		return moved;
	}

	async deleteAllWorkspaceFiles(context: TenantContext, workspaceId: string): Promise<void> {
		const base = `${context.tenantId}/${workspaceId}/`;
		for (const key of [...this.rows.keys()]) if (key.startsWith(base)) this.rows.delete(key);
	}
}

const ctxA = { tenantId: "tenant-a", userId: "user-a", role: "owner" } as TenantContext;
const ctxB = { tenantId: "tenant-b", userId: "user-b", role: "owner" } as TenantContext;

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
