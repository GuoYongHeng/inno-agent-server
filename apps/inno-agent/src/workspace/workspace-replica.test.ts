import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import type { TenantContext } from "../tenants/store.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { workspaceObjectKey } from "./workspace-object-key.js";
import { WorkspaceReplica } from "./workspace-replica.js";

/** In-memory stand-in for the TenantStore methods the replica uses. */
class FakeStore {
	workspaces = new Map<string, { workspaceId: string; relPath: string; name: string; isTemp: boolean; createdAt: string; updatedAt: string }>();
	bindings = new Map<string, string>();
	files = new Map<string, { relPath: string; size: number; mtimeMs: number; kind: "file" | "directory" }>();

	async upsertWorkspaceRow(_ctx: TenantContext, ws: { workspaceId: string; relPath: string; name: string; isTemp: boolean }) {
		this.workspaces.set(ws.workspaceId, { ...ws, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
	}
	async getWorkspaceRow(_ctx: TenantContext, workspaceId: string) {
		return this.workspaces.get(workspaceId) ?? null;
	}
	async deleteWorkspaceRow(_ctx: TenantContext, workspaceId: string) {
		this.workspaces.delete(workspaceId);
		for (const key of [...this.files.keys()]) if (key.startsWith(`${workspaceId}/`)) this.files.delete(key);
		for (const [sid, wsId] of [...this.bindings]) if (wsId === workspaceId) this.bindings.delete(sid);
	}
	async setSessionWorkspace(_ctx: TenantContext, sessionId: string, workspaceId: string) {
		this.bindings.set(sessionId, workspaceId);
	}
	async getSessionWorkspace(_ctx: TenantContext, sessionId: string) {
		return this.bindings.get(sessionId) ?? null;
	}
	async deleteSessionWorkspace(_ctx: TenantContext, sessionId: string) {
		this.bindings.delete(sessionId);
	}
	async getWorkspaceFile(_ctx: TenantContext, workspaceId: string, relPath: string) {
		return this.files.get(`${workspaceId}/${relPath}`) ?? null;
	}
	async listWorkspaceFiles(_ctx: TenantContext, workspaceId: string) {
		const prefix = `${workspaceId}/`;
		return [...this.files.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, { relPath, size, mtimeMs, kind }]) => ({ relPath, size, mtimeMs, kind }));
	}
	async syncWorkspaceFiles(_ctx: TenantContext, workspaceId: string, upserts: Array<{ relPath: string; size: number; mtimeMs: number; kind?: "file" | "directory" }>, deletes: string[]) {
		for (const up of upserts) this.files.set(`${workspaceId}/${up.relPath}`, { relPath: up.relPath, size: up.size, mtimeMs: up.mtimeMs, kind: up.kind ?? "file" });
		for (const del of deletes) this.files.delete(`${workspaceId}/${del}`);
	}
}

const ctx = { tenantId: "tenant-1" } as TenantContext;

describe("WorkspaceReplica", () => {
	let root: string;
	let registry: WorkspaceRegistry;
	let objects: MemoryObjectStore;
	let store: FakeStore;
	let replica: WorkspaceReplica;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "inno-replica-"));
		registry = new WorkspaceRegistry(join(root, "ws"), join(root, "data"));
		registry.ensureBootstrapped();
		objects = new MemoryObjectStore();
		store = new FakeStore();
		replica = new WorkspaceReplica(objects, store as never, registry, join(root, "state"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function makeWorkspace(files: Record<string, string>) {
		const ws = registry.createWorkspace({ name: "测试工作区" });
		const dir = registry.resolveWorkspaceDir(ws.id)!;
		for (const [rel, content] of Object.entries(files)) {
			const target = join(dir, rel);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, content);
		}
		return { ws, dir };
	}

	it("pushes files to object storage and the listing table, then restores them on another worker", async () => {
		const { ws, dir } = makeWorkspace({ "notes/想法.md": "hello 世界", "readme.txt": "plain" });
		await replica.replicateWorkspace(ctx, ws);
		const report = await replica.push(ctx, ws.id, dir);
		expect(report.uploaded).toBe(2);
		expect((await store.listWorkspaceFiles(ctx, ws.id)).filter((f) => f.kind === "file").map((f) => f.relPath).sort()).toEqual(["notes/想法.md", "readme.txt"]);
		expect((await store.listWorkspaceFiles(ctx, ws.id)).find((f) => f.relPath === "notes")?.kind).toBe("directory");

		// Simulate takeover on a fresh worker: new registry/state, same store+objects.
		const freshRoot = mkdtempSync(join(tmpdir(), "inno-replica-b-"));
		try {
			const registryB = new WorkspaceRegistry(join(freshRoot, "ws"), join(freshRoot, "data"));
			registryB.ensureBootstrapped();
			const replicaB = new WorkspaceReplica(objects, store as never, registryB, join(freshRoot, "state"));

			const meta = await replicaB.materializeWorkspace(ctx, ws.id);
			expect(meta?.relPath).toBe(ws.relPath);
			const dirB = registryB.resolveWorkspaceDir(ws.id)!;
			expect(readFileSync(join(dirB, "notes", "想法.md"), "utf8")).toBe("hello 世界");
			expect(readFileSync(join(dirB, "readme.txt"), "utf8")).toBe("plain");
		} finally {
			rmSync(freshRoot, { recursive: true, force: true });
		}
	});

	it("propagates deletions on push and keeps local extras on pull", async () => {
		const { ws, dir } = makeWorkspace({ "a.txt": "a", "b.txt": "b" });
		await replica.replicateWorkspace(ctx, ws);
		await replica.push(ctx, ws.id, dir);

		rmSync(join(dir, "a.txt"));
		const second = await replica.push(ctx, ws.id, dir);
		expect(second.deleted).toBe(1);
		expect(await store.listWorkspaceFiles(ctx, ws.id)).toEqual([
			expect.objectContaining({ relPath: "b.txt" }),
		]);

		// A local file the replica does not know is never deleted by pull.
		writeFileSync(join(dir, "local-only.txt"), "local");
		const pull = await replica.pull(ctx, ws.id, dir);
		expect(pull.downloaded).toBe(0);
		expect(existsSync(join(dir, "local-only.txt"))).toBe(true);
	});

	it("skips ignored directories when pushing", async () => {
		const { ws, dir } = makeWorkspace({ "node_modules/pkg/index.js": "x", "keep.js": "y" });
		await replica.replicateWorkspace(ctx, ws);
		const report = await replica.push(ctx, ws.id, dir);
		expect(report.uploaded).toBe(1);
		expect((await store.listWorkspaceFiles(ctx, ws.id)).map((f) => f.relPath)).toEqual(["keep.js"]);
	});

	it("round-trips an empty directory push -> pull on a fresh worker", async () => {
		const ws = registry.createWorkspace({ name: "空目录工作区" });
		const dir = registry.resolveWorkspaceDir(ws.id)!;
		mkdirSync(join(dir, "empty", "nested"), { recursive: true });
		await replica.replicateWorkspace(ctx, ws);
		await replica.push(ctx, ws.id, dir);

		const rows = await store.listWorkspaceFiles(ctx, ws.id);
		expect(rows.map((row) => `${row.kind}:${row.relPath}`).sort()).toEqual(["directory:empty", "directory:empty/nested"]);
		// Directories have manifest rows only — no objects.
		expect(await objects.list("tenants/")).toEqual([]);

		const freshRoot = mkdtempSync(join(tmpdir(), "inno-replica-d-"));
		try {
			const registryB = new WorkspaceRegistry(join(freshRoot, "ws"), join(freshRoot, "data"));
			registryB.ensureBootstrapped();
			const replicaB = new WorkspaceReplica(objects, store as never, registryB, join(freshRoot, "state"));
			await replicaB.materializeWorkspace(ctx, ws.id);
			const dirB = registryB.resolveWorkspaceDir(ws.id)!;
			expect(existsSync(join(dirB, "empty", "nested"))).toBe(true);
		} finally {
			rmSync(freshRoot, { recursive: true, force: true });
		}
	});

	it("propagates removal of an empty directory", async () => {
		const ws = registry.createWorkspace({ name: "删除目录工作区" });
		const dir = registry.resolveWorkspaceDir(ws.id)!;
		mkdirSync(join(dir, "soon-gone"), { recursive: true });
		await replica.replicateWorkspace(ctx, ws);
		await replica.push(ctx, ws.id, dir);
		expect((await store.listWorkspaceFiles(ctx, ws.id)).map((row) => row.relPath)).toEqual(["soon-gone"]);

		rmSync(join(dir, "soon-gone"), { recursive: true });
		const report = await replica.push(ctx, ws.id, dir);
		expect(report.deleted).toBe(1);
		expect(await store.listWorkspaceFiles(ctx, ws.id)).toEqual([]);
	});

	it("materializes a session's workspace from the replicated binding", async () => {
		const { ws } = makeWorkspace({});
		await replica.replicateWorkspace(ctx, ws);
		await replica.setSessionBinding(ctx, "sess-1", ws.id);

		const freshRoot = mkdtempSync(join(tmpdir(), "inno-replica-c-"));
		try {
			const registryB = new WorkspaceRegistry(join(freshRoot, "ws"), join(freshRoot, "data"));
			registryB.ensureBootstrapped();
			const replicaB = new WorkspaceReplica(objects, store as never, registryB, join(freshRoot, "state"));
			const wsId = await replicaB.materializeSessionWorkspace(ctx, "sess-1", null);
			expect(wsId).toBe(ws.id);
			expect(registryB.getSessionWorkspaceId("sess-1")).toBe(ws.id);
		} finally {
			rmSync(freshRoot, { recursive: true, force: true });
		}
	});

	it("pull with a download filter defers bodies but still materializes directories", async () => {
		const { ws, dir } = makeWorkspace({ "agent.md": "agent", "big/data.bin": "blob", "docs/note.txt": "note" });
		await replica.replicateWorkspace(ctx, ws);
		await replica.push(ctx, ws.id, dir);

		const freshRoot = mkdtempSync(join(tmpdir(), "inno-replica-lazy-"));
		try {
			const registryB = new WorkspaceRegistry(join(freshRoot, "ws"), join(freshRoot, "data"));
			registryB.ensureBootstrapped();
			const replicaB = new WorkspaceReplica(objects, store as never, registryB, join(freshRoot, "state"));
			const dirB = join(freshRoot, "out");
			const report = await replicaB.pull(ctx, ws.id, dirB, { download: (rel) => rel === "agent.md" });
			expect(report.downloaded).toBe(1);
			expect(readFileSync(join(dirB, "agent.md"), "utf8")).toBe("agent");
			expect(existsSync(join(dirB, "big", "data.bin"))).toBe(false);
			expect(existsSync(join(dirB, "docs", "note.txt"))).toBe(false);
			// Directory rows still materialize — the tree shape is visible.
			expect(existsSync(join(dirB, "big"))).toBe(true);
			expect(existsSync(join(dirB, "docs"))).toBe(true);

			// A push on this worker must NOT delete deferred manifest rows:
			// they were never recorded as local state, so their absence on
			// disk cannot be read back as a local deletion.
			await replicaB.push(ctx, ws.id, dirB);
			const rows = (await store.listWorkspaceFiles(ctx, ws.id)).map((row) => row.relPath).sort();
			expect(rows).toContain("big/data.bin");
			expect(rows).toContain("docs/note.txt");
			expect(await objects.head(workspaceObjectKey(ctx.tenantId, ws.id, "big/data.bin"))).not.toBeNull();
		} finally {
			rmSync(freshRoot, { recursive: true, force: true });
		}
	});

	it("materializeFile downloads on miss, refreshes on drift, and reports unknown paths", async () => {
		const { ws, dir } = makeWorkspace({ "notes/a.txt": "v1" });
		await replica.replicateWorkspace(ctx, ws);
		await replica.push(ctx, ws.id, dir);

		const freshRoot = mkdtempSync(join(tmpdir(), "inno-replica-mat-"));
		try {
			const registryB = new WorkspaceRegistry(join(freshRoot, "ws"), join(freshRoot, "data"));
			registryB.ensureBootstrapped();
			const replicaB = new WorkspaceReplica(objects, store as never, registryB, join(freshRoot, "state"));
			const dirB = join(freshRoot, "out");

			expect(await replicaB.materializeFile(ctx, ws.id, dirB, "missing.txt")).toBe(false);
			expect(await replicaB.materializeFile(ctx, ws.id, dirB, "notes/a.txt")).toBe(true);
			expect(readFileSync(join(dirB, "notes", "a.txt"), "utf8")).toBe("v1");

			// Remote drift: manifest bump → re-download replaces local bytes.
			const objectsKey = workspaceObjectKey(ctx.tenantId, ws.id, "notes/a.txt");
			await objects.put(objectsKey, new Uint8Array(Buffer.from("v2-remote")));
			store.files.set(`${ws.id}/notes/a.txt`, { relPath: "notes/a.txt", size: 9, mtimeMs: Date.now() + 5_000, kind: "file" });
			expect(await replicaB.materializeFile(ctx, ws.id, dirB, "notes/a.txt")).toBe(true);
			expect(readFileSync(join(dirB, "notes", "a.txt"), "utf8")).toBe("v2-remote");

			// The materialized file is recorded in pull state like a pull.
			const pushReport = await replicaB.push(ctx, ws.id, dirB);
			expect(pushReport.deleted).toBe(0);
		} finally {
			rmSync(freshRoot, { recursive: true, force: true });
		}
	});

	it("deleteWorkspace removes rows, bindings, objects and local state", async () => {
		const { ws, dir } = makeWorkspace({ "a.txt": "a" });
		await replica.replicateWorkspace(ctx, ws);
		await replica.setSessionBinding(ctx, "sess-1", ws.id);
		await replica.push(ctx, ws.id, dir);

		await replica.deleteWorkspace(ctx, ws.id);
		expect(await store.getWorkspaceRow(ctx, ws.id)).toBeNull();
		expect(await store.listWorkspaceFiles(ctx, ws.id)).toEqual([]);
		expect(await store.getSessionWorkspace(ctx, "sess-1")).toBeNull();
		expect(await objects.list("tenants/")).toEqual([]);
	});
});
