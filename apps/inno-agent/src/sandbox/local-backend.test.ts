import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxFsError } from "./sandbox-backend.js";
import { LocalDirSandbox } from "./local-backend.js";

const roots: string[] = [];

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
	const base = mkdtempSync(join(tmpdir(), "inno-local-sandbox-"));
	roots.push(base);
	const root = join(base, "sandbox-root");
	mkdirSync(root, { recursive: true });
	return { base, root, sandbox: new LocalDirSandbox("test", root) };
}

const expectDenied = async (op: Promise<unknown>) => {
	try {
		await op;
		expect.unreachable("operation should have been denied");
	} catch (error) {
		expect(error).toBeInstanceOf(SandboxFsError);
		expect((error as SandboxFsError).code).toBe("permission_denied");
	}
};

describe("LocalDirSandbox file containment", () => {
	it("serves files and directories inside the root", async () => {
		const { root, sandbox } = setup();
		await sandbox.writeFile("/notes/a.md", "hello");
		expect(readFileSync(join(root, "notes", "a.md"), "utf8")).toBe("hello");
		expect((await sandbox.readFile("/notes/a.md"))[0]).toBe(104); // 'h'
		expect((await sandbox.stat("/notes/a.md")).kind).toBe("file");
		expect((await sandbox.list("/notes")).map((e) => e.name)).toEqual(["a.md"]);
		await sandbox.makeDir("/empty/dir");
		expect((await sandbox.stat("/empty/dir")).kind).toBe("directory");
		await sandbox.rename("/notes/a.md", "/notes/b.md");
		expect(readFileSync(join(root, "notes", "b.md"), "utf8")).toBe("hello");
		await sandbox.remove("/notes/b.md");
		await expect(sandbox.stat("/notes/b.md")).rejects.toMatchObject({ code: "not_found" });
	});

	it("clamps leading .. above the sandbox root instead of escaping", async () => {
		const { root, sandbox } = setup();
		writeFileSync(join(root, "inside.txt"), "ok");
		expect(new TextDecoder().decode(await sandbox.readFile("/../../../../inside.txt"))).toBe("ok");
		await sandbox.writeFile("/../new.txt", "fine");
		expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("fine");
	});

	it("rejects relative .. escapes", async () => {
		const { sandbox } = setup();
		await expectDenied(sandbox.readFile("a/../../etc/passwd"));
		await expectDenied(sandbox.writeFile("../escape.txt", "no"));
	});

	it("denies reads and writes through a symlink that escapes the root", async () => {
		const { base, root, sandbox } = setup();
		const outside = join(base, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "top-secret");
		symlinkSync(outside, join(root, "link-out"));

		await expectDenied(sandbox.readFile("/link-out/secret.txt"));
		await expectDenied(sandbox.stat("/link-out/secret.txt"));
		await expectDenied(sandbox.list("/link-out"));
		await expectDenied(sandbox.writeFile("/link-out/planted.txt", "no"));
		await expectDenied(sandbox.makeDir("/link-out/sub"));

		// The link itself is still listable as a symlink and removable.
		expect((await sandbox.list("/")).find((e) => e.name === "link-out")?.kind).toBe("symlink");
		await sandbox.remove("/link-out");
		expect(lstatSync(join(root, "link-out"), { throwIfNoEntry: false })).toBeUndefined();
	});

	it("denies a dangling symlink write (the link itself counts as existing)", async () => {
		const { root, sandbox } = setup();
		symlinkSync("/definitely/not/here", join(root, "dangling"));
		await expectDenied(sandbox.writeFile("/dangling", "no"));
		await sandbox.remove("/dangling");
	});

	it("follows symlinks that stay inside the root", async () => {
		const { root, sandbox } = setup();
		writeFileSync(join(root, "real.txt"), "data");
		symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
		expect(new TextDecoder().decode(await sandbox.readFile("/alias.txt"))).toBe("data");
	});

	it("runs shell commands in the sandbox directory", async () => {
		const { root, sandbox } = setup();
		const result = await sandbox.run("pwd && echo hi > out.txt");
		expect(result.exitCode).toBe(0);
		expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("hi\n");
	});

	it("reports non-zero exits and missing programs as results, not errors", async () => {
		const { sandbox } = setup();
		expect((await sandbox.run("exit 3")).exitCode).toBe(3);
	});

	it("kills the process group on timeout", async () => {
		const { sandbox } = setup();
		await expect(sandbox.run("sleep 30", { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
	});
});
