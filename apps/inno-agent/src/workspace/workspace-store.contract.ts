import { describe, expect, it } from "vitest";
import {
	normalizeWorkspacePath,
	WorkspaceStoreError,
	type WorkspaceEntry,
	type WorkspaceStore,
} from "./workspace-store.js";

export interface WorkspaceStoreFixture {
	store: WorkspaceStore;
	workspaceId: string;
}

async function drain(iterable: AsyncIterable<WorkspaceEntry>): Promise<WorkspaceEntry[]> {
	const out: WorkspaceEntry[] = [];
	for await (const entry of iterable) out.push(entry);
	return out;
}

function code(error: unknown): string | undefined {
	return error instanceof WorkspaceStoreError ? error.code : undefined;
}

async function expectError(promise: Promise<unknown>, expected: string): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect(code(error), `expected ${expected}, got ${String(error)}`).toBe(expected);
		return;
	}
	expect.unreachable(`expected ${expected}, no error thrown`);
}

/**
 * Behavioural contract every `WorkspaceStore` implementation must satisfy.
 * `makeStore` returns a fresh, empty workspace (and store) per call.
 */
export function runWorkspaceStoreContract(name: string, makeStore: () => Promise<WorkspaceStoreFixture> | WorkspaceStoreFixture): void {
	describe(`${name}: WorkspaceStore contract`, () => {
		it("normalizes workspace paths", async () => {
			expect(normalizeWorkspacePath("")).toBe("");
			expect(normalizeWorkspacePath("./a//b/")).toBe("a/b");
			expect(normalizeWorkspacePath("a/./b")).toBe("a/b");
			for (const bad of ["..", "a/../b", "/abs", "C:/x", "a\\b", "a\0b"]) {
				expect(() => normalizeWorkspacePath(bad), bad).toThrowError(WorkspaceStoreError);
			}
		});

		it("writes and reads files, including binary bytes and unicode names", async () => {
			const { store, workspaceId } = await makeStore();
			const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);
			await store.write(workspaceId, "bin.dat", bytes);
			const read = await store.read(workspaceId, "bin.dat");
			expect([...read!.body]).toEqual([...bytes]);
			await store.write(workspaceId, "文档/笔记.md", new TextEncoder().encode("你好"));
			const readCn = await store.read(workspaceId, "文档/笔记.md");
			expect(new TextDecoder().decode(readCn!.body)).toBe("你好");
			expect(readCn!.entry.size).toBe("你好".length * 3);
		});

		it("creates implied parents on write and lists them", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "a/b/c.txt", new Uint8Array([1]));
			const root = await store.list(workspaceId, "");
			expect(root.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(["directory:a"]);
			const a = await store.list(workspaceId, "a");
			expect(a.entries.map((entry) => entry.name)).toEqual(["b"]);
		});

		it("mkdir is idempotent and empty directories survive", async () => {
			const { store, workspaceId } = await makeStore();
			await store.mkdir(workspaceId, "empty/nested");
			await store.mkdir(workspaceId, "empty/nested");
			const stat = await store.stat(workspaceId, "empty/nested");
			expect(stat).toMatchObject({ kind: "directory", size: 0 });
			expect((await store.list(workspaceId, "")).entries.map((entry) => entry.name)).toEqual(["empty"]);
			expect((await store.list(workspaceId, "empty")).entries.map((entry) => entry.name)).toEqual(["nested"]);
			expect((await store.list(workspaceId, "empty/nested")).entries).toEqual([]);
		});

		it("lists directories first in zh-CN order and hides ignored names", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "zeta.txt", new Uint8Array([1]));
			await store.write(workspaceId, "alpha.txt", new Uint8Array([1]));
			await store.mkdir(workspaceId, "beta");
			await store.write(workspaceId, "node_modules/pkg.js", new Uint8Array([1]));
			await store.write(workspaceId, ".git/config", new Uint8Array([1]));
			const page = await store.list(workspaceId, "");
			expect(page.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
				"directory:beta", "file:alpha.txt", "file:zeta.txt",
			]);
		});

		it("paginates through all entries exactly once", async () => {
			const { store, workspaceId } = await makeStore();
			for (const name of ["a", "b", "c", "d", "e"]) {
				await store.write(workspaceId, `${name}.txt`, new Uint8Array([1]));
			}
			const seen: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await store.list(workspaceId, "", { limit: 2, cursor });
				seen.push(...page.entries.map((entry) => entry.name));
				cursor = page.nextCursor;
			} while (cursor);
			expect(seen.sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
		});

		it("stats root, file, directory and missing paths", async () => {
			const { store, workspaceId } = await makeStore();
			expect(await store.stat(workspaceId, "")).toMatchObject({ kind: "directory", path: "" });
			await store.write(workspaceId, "d/f.txt", new Uint8Array([1, 2, 3]));
			expect(await store.stat(workspaceId, "d/f.txt")).toMatchObject({ kind: "file", size: 3 });
			expect(await store.stat(workspaceId, "d")).toMatchObject({ kind: "directory", size: 0 });
			expect(await store.stat(workspaceId, "missing")).toBeNull();
		});

		it("removes files and directories with the right guards", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "d/f.txt", new Uint8Array([1]));
			await expectError(store.remove(workspaceId, "d"), "exists");
			await store.remove(workspaceId, "d", { recursive: true });
			expect(await store.stat(workspaceId, "d")).toBeNull();
			await store.write(workspaceId, "gone.txt", new Uint8Array([1]));
			await store.remove(workspaceId, "gone.txt");
			expect(await store.stat(workspaceId, "gone.txt")).toBeNull();
			await expectError(store.remove(workspaceId, "missing"), "not_found");
			await expectError(store.remove(workspaceId, ""), "invalid_path");
		});

		it("moves files and directory subtrees", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "src/sub/f.txt", new Uint8Array([7]));
			await store.mkdir(workspaceId, "src/emptydir");
			await store.move(workspaceId, "src", "dst");
			expect(await store.stat(workspaceId, "src")).toBeNull();
			expect(await store.stat(workspaceId, "dst/sub/f.txt")).toMatchObject({ kind: "file", size: 1 });
			expect(await store.stat(workspaceId, "dst/emptydir")).toMatchObject({ kind: "directory" });
			const read = await store.read(workspaceId, "dst/sub/f.txt");
			expect([...read!.body]).toEqual([7]);
			await store.write(workspaceId, "one.txt", new Uint8Array([1]));
			await store.move(workspaceId, "one.txt", "renamed.txt");
			expect(await store.stat(workspaceId, "one.txt")).toBeNull();
			expect(await store.stat(workspaceId, "renamed.txt")).toMatchObject({ kind: "file" });
		});

		it("rejects moves onto existing paths and into itself", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "a.txt", new Uint8Array([1]));
			await store.write(workspaceId, "b.txt", new Uint8Array([2]));
			await expectError(store.move(workspaceId, "a.txt", "b.txt"), "exists");
			await store.mkdir(workspaceId, "dir");
			await expectError(store.move(workspaceId, "dir", "dir/inner"), "invalid_path");
			await expectError(store.move(workspaceId, "missing", "x"), "not_found");
			await expectError(store.move(workspaceId, "", "x"), "invalid_path");
		});

		it("walks files and directories under a subdir in path order", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "root/inner/f1.txt", new Uint8Array([1]));
			await store.mkdir(workspaceId, "root/empty");
			await store.write(workspaceId, "root/f2.txt", new Uint8Array([1]));
			const entries = await drain(store.walk(workspaceId, "root"));
			expect(entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
				"directory:root/empty", "file:root/f2.txt", "directory:root/inner", "file:root/inner/f1.txt",
			]);
			await expectError(drain(store.walk(workspaceId, "root", { maxEntries: 2 })), "limit_exceeded");
		});

		it("rejects oversized writes with too_large", async () => {
			const { store, workspaceId } = await makeStore();
			const big = new Uint8Array(200 * 1024 * 1024);
			await expectError(store.write(workspaceId, "big.bin", big), "too_large");
		});

		it("distinguishes file and directory errors", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "plain.txt", new Uint8Array([1]));
			await expectError(store.write(workspaceId, "plain.txt/child.txt", new Uint8Array([1])), "not_directory");
			await store.mkdir(workspaceId, "real-dir");
			await expectError(store.write(workspaceId, "real-dir", new Uint8Array([1])), "is_directory");
			await expectError(store.mkdir(workspaceId, "plain.txt"), "not_directory");
			await expectError(store.list(workspaceId, "plain.txt"), "not_directory");
			await expectError(store.list(workspaceId, "missing-dir"), "not_found");
			expect(await store.read(workspaceId, "real-dir")).toBeNull();
		});

		it("deleteAll drops every entry", async () => {
			const { store, workspaceId } = await makeStore();
			await store.write(workspaceId, "a/b.txt", new Uint8Array([1]));
			await store.mkdir(workspaceId, "empty");
			await store.deleteAll(workspaceId);
			expect((await store.list(workspaceId, "")).entries).toEqual([]);
			expect(await store.stat(workspaceId, "a/b.txt")).toBeNull();
			expect(await store.stat(workspaceId, "empty")).toBeNull();
		});
	});
}
