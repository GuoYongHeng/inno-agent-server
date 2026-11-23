import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceFileAccess } from "./workspace-files.js";

export interface WorkspaceFileAccessFixture {
	access: WorkspaceFileAccess;
	/** The absolute path models see as the workspace root. */
	modelRoot: string;
	seedFile(relPath: string, content: string | Uint8Array): Promise<void>;
	seedDir(relPath: string): Promise<void>;
	/**
	 * Absolute path of the real backing file, when the implementation serves
	 * local paths directly (LocalWorkspaceFileAccess). Store-backed impls
	 * materialize into temp dirs and return undefined.
	 */
	realFilePath?(relPath: string): string | undefined;
}

/** Shared contract for every WorkspaceFileAccess implementation. */
export function runWorkspaceFileAccessContract(
	name: string,
	makeAccess: () => WorkspaceFileAccessFixture | Promise<WorkspaceFileAccessFixture>,
): void {
	describe(`${name} WorkspaceFileAccess contract`, () => {
		it("toRelative accepts relative and model-root absolute paths, rejects the rest", async () => {
			const { access, modelRoot } = await makeAccess();
			expect(access.toRelative("a/b.txt")).toBe("a/b.txt");
			expect(access.toRelative("./a//b.txt")).toBe("a/b.txt");
			expect(access.toRelative(join(modelRoot, "a", "b.txt"))).toBe("a/b.txt");
			expect(access.toRelative("/definitely/not/the/root/x.txt")).toBeNull();
			expect(access.toRelative("../escape.txt")).toBeNull();
			expect(access.toRelative("a\\b.txt")).toBeNull();
			expect(access.toRelative("a/b\0c.txt")).toBeNull();
			expect(access.toRelative("")).toBeNull();
			expect(access.toRelative(".")).toBe("");
		});

		it("stat and read files, directories and missing paths", async () => {
			const { access, seedFile, seedDir } = await makeAccess();
			await seedFile("dir/a.txt", "hello");
			await seedDir("empty");

			const file = await access.stat("dir/a.txt");
			expect(file).toMatchObject({ path: "dir/a.txt", name: "a.txt", kind: "file", size: 5 });
			const dir = await access.stat("dir");
			expect(dir?.kind).toBe("directory");
			expect(await access.stat("missing.txt")).toBeNull();

			expect(Buffer.from((await access.read("dir/a.txt"))!).toString()).toBe("hello");
			expect(await access.read("dir")).toBeNull();
			expect(await access.read("missing.txt")).toBeNull();
		});

		it("withLocalFile hands a readable path with the original base name", async () => {
			const fixture = await makeAccess();
			const { access, seedFile } = fixture;
			await seedFile("docs/报告.docx", "word-bytes");
			let captured: string | undefined;
			const result = await access.withLocalFile("docs/报告.docx", async (localPath) => {
				captured = localPath;
				expect(readFileSync(localPath, "utf-8")).toBe("word-bytes");
				return "ok";
			});
			expect(result).toBe("ok");
			expect(captured!.split(sep).pop()).toBe("报告.docx");
			const real = fixture.realFilePath?.("docs/报告.docx");
			if (real !== undefined) {
				// Local impl: no copy — the callback sees the real file and it must
				// NOT have been removed afterwards.
				expect(captured).toBe(real);
				expect(existsSync(captured!)).toBe(true);
			} else {
				// Store impl: materialized temp path is removed after the callback.
				expect(existsSync(captured!)).toBe(false);
			}
		});

		it("withLocalFile returns null for missing files without calling fn", async () => {
			const { access } = await makeAccess();
			let called = false;
			expect(await access.withLocalFile("missing.txt", async () => {
				called = true;
				return 1;
			})).toBeNull();
			expect(called).toBe(false);
		});

		it("withLocalDir materializes the subtree including empty dirs", async () => {
			const { access, seedFile, seedDir } = await makeAccess();
			await seedFile("tree/x.txt", "x");
			await seedFile("tree/sub/y.txt", "y");
			await seedDir("tree/empty-dir");
			const result = await access.withLocalDir("tree", async (localDir) => {
				expect(readFileSync(join(localDir, "x.txt"), "utf-8")).toBe("x");
				expect(readFileSync(join(localDir, "sub", "y.txt"), "utf-8")).toBe("y");
				expect(readdirSync(join(localDir, "empty-dir"))).toEqual([]);
				return "seen";
			});
			expect(result).toBe("seen");
		});

		it("withLocalDir returns null for missing dirs", async () => {
			const { access } = await makeAccess();
			let called = false;
			expect(await access.withLocalDir("nope", async () => {
				called = true;
				return "x";
			})).toBeNull();
			expect(called).toBe(false);
		});

		it("removes materialized temp dirs after success and after callback throw", async () => {
			const fixture = await makeAccess();
			const { access, seedFile, seedDir } = fixture;
			if (fixture.realFilePath) return; // Local impl passes real paths; covered above.
			await seedFile("f.txt", "data");
			await seedDir("d/sub");

			let filePath: string | undefined;
			await access.withLocalFile("f.txt", async (p) => {
				filePath = p;
				return 1;
			});
			expect(existsSync(filePath!)).toBe(false);

			let threwPath: string | undefined;
			await expect(access.withLocalFile("f.txt", async (p) => {
				threwPath = p;
				throw new Error("boom");
			})).rejects.toThrow("boom");
			expect(existsSync(threwPath!)).toBe(false);

			let dirPath: string | undefined;
			await access.withLocalDir("d", async (p) => {
				dirPath = p;
				return 1;
			});
			expect(existsSync(dirPath!)).toBe(false);

			let threwDir: string | undefined;
			await expect(access.withLocalDir("d", async (p) => {
				threwDir = p;
				throw new Error("boom");
			})).rejects.toThrow("boom");
			expect(existsSync(threwDir!)).toBe(false);
		});
	});
}
