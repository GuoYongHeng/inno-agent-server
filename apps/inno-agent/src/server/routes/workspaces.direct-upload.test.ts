import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimePaths } from "../../runtime.js";
import { WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import { FileStateKv } from "../../tenants/state-store.js";
import { MemoryObjectStore, sha256Hex } from "../../object-store/object-store.js";
import { FakeTenantStore, ctxA } from "../../workspace/fake-tenant-store.js";
import { ObjectWorkspaceStore } from "../../workspace/object-workspace-store.js";
import { workspaceObjectKey } from "../../workspace/workspace-object-key.js";
import { setRequestTenant } from "../../tenants/http.js";
import type { TenantContext, TenantStore } from "../../tenants/store.js";
import { handleWorkspacesRoutes, type WorkspacesRouteContext } from "./workspaces.js";

function fakeReq(payload: unknown): HttpReq & PassThrough {
	const stream = new PassThrough() as HttpReq & PassThrough;
	stream.headers = {};
	stream.end(JSON.stringify(payload));
	return stream;
}

function fakeRes(): ServerResponse & { statusCode: number; body: () => unknown } {
	let body = "";
	const res = {
		statusCode: 0,
		writeHead(status: number) {
			res.statusCode = status;
			return res;
		},
		end(chunk?: string) {
			body = chunk ?? "";
			return res;
		},
		body: () => (body ? JSON.parse(body) : undefined),
	} as unknown as ServerResponse & { statusCode: number; body: () => unknown };
	return res;
}

/** FakeTenantStore plus the ownership/row surface `resolveRequestWorkspaceForRead` needs. */
class RouteTenantStore extends FakeTenantStore {
	constructor(private readonly workspace: { id: string; name: string }) { super(); }
	async ownsResource(_context: TenantContext, _kind: string, resourceId: string) { return resourceId === this.workspace.id; }
	async getWorkspaceRow(_context: TenantContext, workspaceId: string) {
		return workspaceId === this.workspace.id
			? { workspaceId, relPath: "", name: this.workspace.name, isTemp: false, createdAt: "", updatedAt: "" }
			: null;
	}
	async claimResource() { /* no-op */ }
}

let dir: string;
let objects: MemoryObjectStore;
let tenantStore: RouteTenantStore;
let ctx: WorkspacesRouteContext;
const WS_ID = "direct-ws";

beforeEach(() => {
	dir = mkdtempSync(`${tmpdir()}/workspace-direct-`);
	const registry = new WorkspaceRegistry(`${dir}/workspaces`);
	registry.ensureBootstrapped();
	objects = new MemoryObjectStore();
	tenantStore = new RouteTenantStore({ id: WS_ID, name: "ws" });
	ctx = {
		workspaceRegistry: registry,
		stateKv: new FileStateKv(`${dir}/data`),
		paths: {} as RuntimePaths,
		tenantStore: tenantStore as unknown as TenantStore,
		installSkillZip: () => { throw new Error("not used"); },
		installSkillMarkdown: () => { throw new Error("not used"); },
		importWorkspaceZip: () => { throw new Error("not used"); },
		scheduleSkillsReload: () => undefined,
		durableSessions: { get: () => undefined } as never,
		workspaceStoreFor: () => new ObjectWorkspaceStore({ objects, store: tenantStore as unknown as TenantStore, context: ctxA }),
		objects: () => objects,
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function completeReq(payload: unknown): HttpReq {
	const req = fakeReq(payload);
	setRequestTenant(req, ctxA, tenantStore as unknown as TenantStore);
	return req;
}

describe("workspace upload/complete integrity check", () => {
	it("adopts the row when the client-provided sha256 matches", async () => {
		const key = workspaceObjectKey(ctxA.tenantId, WS_ID, "report.txt");
		const body = new Uint8Array([1, 2, 3]);
		await objects.put(key, body);
		const res = fakeRes();
		await handleWorkspacesRoutes(completeReq({ workspaceId: WS_ID, path: "report.txt", sha256: sha256Hex(body) }), res, "POST", "/api/workspace/upload/complete", ctx);
		expect(res.statusCode).toBe(201);
		expect((res.body() as { size: number }).size).toBe(3);
		expect(await tenantStore.getWorkspaceFile(ctxA, WS_ID, "report.txt")).not.toBeNull();
	});

	it("adopts the row when no sha256 is provided (non-secure context)", async () => {
		const key = workspaceObjectKey(ctxA.tenantId, WS_ID, "plain.txt");
		await objects.put(key, new Uint8Array([4]));
		const res = fakeRes();
		await handleWorkspacesRoutes(completeReq({ workspaceId: WS_ID, path: "plain.txt" }), res, "POST", "/api/workspace/upload/complete", ctx);
		expect(res.statusCode).toBe(201);
	});

	it("rejects a sha256 mismatch, deletes the object, and writes no manifest row", async () => {
		const key = workspaceObjectKey(ctxA.tenantId, WS_ID, "corrupt.bin");
		await objects.put(key, new Uint8Array([9, 9]));
		const wrong = "0".repeat(64);
		const res = fakeRes();
		await handleWorkspacesRoutes(completeReq({ workspaceId: WS_ID, path: "corrupt.bin", sha256: wrong }), res, "POST", "/api/workspace/upload/complete", ctx);
		expect(res.statusCode).toBe(422);
		expect(await objects.head(key)).toBeNull();
		expect(await tenantStore.getWorkspaceFile(ctxA, WS_ID, "corrupt.bin")).toBeNull();
	});

	it("404s when nothing was uploaded", async () => {
		const res = fakeRes();
		await handleWorkspacesRoutes(completeReq({ workspaceId: WS_ID, path: "nope.bin" }), res, "POST", "/api/workspace/upload/complete", ctx);
		expect(res.statusCode).toBe(404);
	});
});

