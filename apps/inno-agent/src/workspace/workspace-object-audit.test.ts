import { describe, expect, it } from "vitest";
import { MemoryObjectStore, tenantObjectKey } from "../object-store/object-store.js";
import { ctxA, ctxB, FakeTenantStore } from "./fake-tenant-store.js";
import { workspaceObjectKey } from "./workspace-object-key.js";
import { auditAllWorkspaceObjects, auditWorkspaceObjects } from "./workspace-object-audit.js";

const HOUR = 3_600_000;
const NOW = 10_000_000_000;

async function seed(manifest: FakeTenantStore, objects: MemoryObjectStore, ctx = ctxA, ws = "ws-1") {
	await manifest.putWorkspaceFile(ctx, ws, { relPath: "a.txt", kind: "file", size: 3, mtimeMs: NOW });
	await objects.put(workspaceObjectKey(ctx.tenantId, ws, "a.txt"), new Uint8Array([1, 2, 3]));
}

describe("auditWorkspaceObjects", () => {
	it("reports a clean workspace", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		await seed(manifest, objects);
		const audit = await auditWorkspaceObjects({ objects, store: manifest, context: ctxA, workspaceId: "ws-1", graceMs: HOUR, now: NOW });
		expect(audit.orphans).toEqual([]);
		expect(audit.missing).toEqual([]);
		expect(audit.repaired).toEqual([]);
	});

	it("reports orphans and, with repair, deletes only those past the grace window", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		await seed(manifest, objects);
		const old = await objects.put(workspaceObjectKey(ctxA.tenantId, "ws-1", "stale.bin"), new Uint8Array([9]));
		const young = await objects.put(workspaceObjectKey(ctxA.tenantId, "ws-1", "inflight.bin"), new Uint8Array([8]));
		// Backdate the orphan beyond the grace window; inflight stays young.
		(objects as any).objects.get(old.key).meta.mtimeMs = NOW - 2 * HOUR;
		(objects as any).objects.get(young.key).meta.mtimeMs = NOW - 60_000;

		const audit = await auditWorkspaceObjects({
			objects, store: manifest, context: ctxA, workspaceId: "ws-1",
			graceMs: HOUR, repair: true, now: NOW,
		});
		expect(audit.orphans.map((o) => o.key).sort()).toEqual([old.key, young.key].sort());
		expect(audit.deferred.map((o) => o.key)).toEqual([young.key]);
		expect(audit.repaired).toEqual([old.key]);
		expect(await objects.head(old.key)).toBeNull();
		expect(await objects.head(young.key)).not.toBeNull();
	});

	it("defers orphans without mtimeMs even in repair mode", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		const orphan = await objects.put(workspaceObjectKey(ctxA.tenantId, "ws-1", "ancient.bin"), new Uint8Array([1]));
		delete (objects as any).objects.get(orphan.key).meta.mtimeMs;
		const audit = await auditWorkspaceObjects({
			objects, store: manifest, context: ctxA, workspaceId: "ws-1",
			graceMs: 0, repair: true, now: NOW,
		});
		expect(audit.deferred.map((o) => o.key)).toEqual([orphan.key]);
		expect(audit.repaired).toEqual([]);
	});

	it("reports manifest rows whose object is missing", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		await seed(manifest, objects);
		await manifest.putWorkspaceFile(ctxA, "ws-1", { relPath: "gone.txt", kind: "file", size: 1, mtimeMs: NOW });
		const audit = await auditWorkspaceObjects({ objects, store: manifest, context: ctxA, workspaceId: "ws-1", graceMs: HOUR, now: NOW });
		expect(audit.missing).toEqual([{ relPath: "gone.txt", size: 1 }]);
	});
});

describe("auditAllWorkspaceObjects", () => {
	it("groups objects by tenant and workspace and ignores non-workspace keys", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		await seed(manifest, objects, ctxA, "ws-1");
		await seed(manifest, objects, ctxB, "ws-1");
		// Orphan in tenant B's workspace, an l2-raw object, and a stray key.
		await objects.put(workspaceObjectKey(ctxB.tenantId, "ws-1", "orphan.bin"), new Uint8Array([1]));
		await objects.put(tenantObjectKey(ctxB.tenantId, "l2-raw", "doc.pdf"), new Uint8Array([1]));
		await objects.put("unrelated/key", new Uint8Array([1]));

		const audits = await auditAllWorkspaceObjects({ objects, store: manifest, graceMs: HOUR, now: NOW });
		expect(audits.map((a) => `${a.tenantId}/${a.workspaceId}`)).toEqual(["tenant-a/ws-1", "tenant-b/ws-1"]);
		const a = audits[0]!;
		const b = audits[1]!;
		expect(a.orphans).toEqual([]);
		expect(b.orphans.map((o) => o.key)).toEqual([workspaceObjectKey(ctxB.tenantId, "ws-1", "orphan.bin")]);
	});

	it("treats a workspace deleted from the manifest as all-orphan", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		await seed(manifest, objects, ctxA, "deleted-ws");
		await manifest.deleteAllWorkspaceFiles(ctxA, "deleted-ws");
		const audits = await auditAllWorkspaceObjects({ objects, store: manifest, graceMs: 0, repair: true, now: Date.now() + HOUR });
		expect(audits).toHaveLength(1);
		expect(audits[0]!.orphans).toHaveLength(1);
		expect(audits[0]!.repaired).toHaveLength(1);
	});

	it("narrowing by tenantId leaves other tenants alone", async () => {
		const manifest = new FakeTenantStore();
		const objects = new MemoryObjectStore();
		await objects.put(workspaceObjectKey(ctxA.tenantId, "ws-1", "o.bin"), new Uint8Array([1]));
		await objects.put(workspaceObjectKey(ctxB.tenantId, "ws-1", "o.bin"), new Uint8Array([1]));
		const audits = await auditAllWorkspaceObjects({ objects, store: manifest, graceMs: HOUR, now: NOW, tenantId: ctxA.tenantId });
		expect(audits).toHaveLength(1);
		expect(audits[0]!.tenantId).toBe("tenant-a");
	});
});
