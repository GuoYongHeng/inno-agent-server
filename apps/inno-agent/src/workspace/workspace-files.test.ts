import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import type { TenantStore } from "../tenants/store.js";
import { LocalFsWorkspaceStore } from "./local-fs-workspace-store.js";
import { ObjectWorkspaceStore } from "./object-workspace-store.js";
import { LocalWorkspaceFileAccess } from "./local-workspace-file-access.js";
import { StoreWorkspaceFileAccess } from "./store-workspace-file-access.js";
import { runWorkspaceFileAccessContract, type WorkspaceFileAccessFixture } from "./workspace-files.contract.js";
import { FakeTenantStore, ctxA } from "./fake-tenant-store.js";
import type { WorkspaceStore } from "./workspace-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-wfa-"));
	roots.push(root);
	return root;
}

function localFixture(): WorkspaceFileAccessFixture {
	const root = join(tempRoot(), "ws");
	mkdirSync(root, { recursive: true });
	return {
		access: new LocalWorkspaceFileAccess({ root }),
		modelRoot: root,
		seedFile: async (rel, content) => {
			const p = join(root, ...rel.split("/"));
			mkdirSync(join(p, ".."), { recursive: true });
			writeFileSync(p, content);
		},
		seedDir: async (rel) => {
			mkdirSync(join(root, ...rel.split("/")), { recursive: true });
		},
		realFilePath: (rel) => join(root, ...rel.split("/")),
	};
}

function storeFixture(store: WorkspaceStore, modelRoot: string): WorkspaceFileAccessFixture {
	return {
		access: new StoreWorkspaceFileAccess({ store, workspaceId: "ws-1", modelRoot }),
		modelRoot,
		seedFile: async (rel, content) => {
			const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
			await store.write("ws-1", rel, body);
		},
		seedDir: async (rel) => {
			await store.mkdir("ws-1", rel);
		},
	};
}

runWorkspaceFileAccessContract("LocalWorkspaceFileAccess", localFixture);

runWorkspaceFileAccessContract("StoreWorkspaceFileAccess(LocalFsWorkspaceStore)", () => {
	const root = join(tempRoot(), "ws");
	mkdirSync(root, { recursive: true });
	return storeFixture(new LocalFsWorkspaceStore({ resolveRoot: () => root }), root);
});

runWorkspaceFileAccessContract("StoreWorkspaceFileAccess(ObjectWorkspaceStore)", () => {
	const tenants = new FakeTenantStore();
	const objects = new MemoryObjectStore();
	const store = new ObjectWorkspaceStore({ objects, store: tenants as unknown as TenantStore, context: ctxA });
	return storeFixture(store, "/model/workspace");
});

describe("LocalWorkspaceFileAccess symlink semantics", () => {
	it("denies symlinks escaping the root like checkWorkspaceMutationPath", async () => {
		const root = join(tempRoot(), "ws");
		mkdirSync(root, { recursive: true });
		const outside = join(tempRoot(), "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));

		const access = new LocalWorkspaceFileAccess({ root });
		expect(access.toRelative("escape.txt")).toBeNull();
		expect(await access.read("escape.txt")).toBeNull();
		expect(await access.stat("escape.txt")).toBeNull();
	});

	it("allows symlinks resolving inside the root like checkWorkspaceMutationPath", async () => {
		const root = join(tempRoot(), "ws");
		mkdirSync(join(root, "real"), { recursive: true });
		writeFileSync(join(root, "real", "in.txt"), "inside");
		symlinkSync(join(root, "real", "in.txt"), join(root, "link.txt"));
		symlinkSync(join(root, "real"), join(root, "link-dir"));

		const access = new LocalWorkspaceFileAccess({ root });
		expect(access.toRelative("link.txt")).toBe("link.txt");
		expect(Buffer.from((await access.read("link.txt"))!).toString()).toBe("inside");
		expect(access.toRelative("link-dir/in.txt")).toBe("link-dir/in.txt");
		const result = await access.withLocalDir("link-dir", async (p) => readFileSync(join(p, "in.txt"), "utf-8"));
		expect(result).toBe("inside");
	});
});
