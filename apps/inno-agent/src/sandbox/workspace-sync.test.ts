import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { LocalDirSandboxProvider } from "./local-backend.js";
import { WorkspaceSync } from "./workspace-sync.js";

const provider = new LocalDirSandboxProvider();
const dirs: string[] = [];
afterAll(() => provider.dispose());
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function setup() {
	const base = mkdtempSync(join(tmpdir(), "inno-sync-"));
	dirs.push(base);
	const host = join(base, "host");
	mkdirSync(host);
	const backend = await provider.create();
	const sync = new WorkspaceSync(backend, host, "/home/user/workspace", join(base, "sync.json"));
	return { base, host, backend, sync, remote: (rel: string) => backend.readFile(`/home/user/workspace/${rel}`).then((b) => new TextDecoder().decode(b)) };
}

describe("WorkspaceSync", () => {
	it("seeds the sandbox from the host workspace and skips ignored directories", async () => {
		const { host, sync, remote, backend } = await setup();
		writeFileSync(join(host, "a.txt"), "alpha");
		mkdirSync(join(host, "dir", "sub"), { recursive: true });
		writeFileSync(join(host, "dir", "sub", "b.txt"), "beta");
		mkdirSync(join(host, "node_modules", "x"), { recursive: true });
		writeFileSync(join(host, "node_modules", "x", "i.js"), "ignored");
		expect(await sync.pushHost()).toMatchObject({ uploaded: 2 });
		expect(await remote("a.txt")).toBe("alpha");
		expect(await remote("dir/sub/b.txt")).toBe("beta");
		await expect(backend.stat("/home/user/workspace/node_modules")).rejects.toMatchObject({ code: "not_found" });
	});

	it("uploads only what changed since the last sync", async () => {
		const { host, sync, remote } = await setup();
		writeFileSync(join(host, "a.txt"), "one");
		writeFileSync(join(host, "b.txt"), "two");
		await sync.pushHost();
		expect(await sync.pushHost()).toMatchObject({ uploaded: 0 });
		writeFileSync(join(host, "a.txt"), "ONE!");
		expect(await sync.pushHost()).toMatchObject({ uploaded: 1 });
		expect(await remote("a.txt")).toBe("ONE!");
	});

	it("brings files the agent created or edited in the sandbox to the host", async () => {
		const { host, sync, backend } = await setup();
		writeFileSync(join(host, "keep.txt"), "kept");
		await sync.pushHost();
		await backend.writeFile("/home/user/workspace/out/result.md", "# done");
		await backend.writeFile("/home/user/workspace/keep.txt", "edited in sandbox!");
		expect(await sync.pullRemote()).toMatchObject({ downloaded: 2 });
		expect(readFileSync(join(host, "out", "result.md"), "utf-8")).toBe("# done");
		expect(readFileSync(join(host, "keep.txt"), "utf-8")).toBe("edited in sandbox!");
		expect(await sync.pullRemote()).toMatchObject({ downloaded: 0 });
	});

	it("deletes on the host what the agent deleted, unless the user changed it meanwhile", async () => {
		const { host, sync, backend } = await setup();
		writeFileSync(join(host, "gone.txt"), "x");
		writeFileSync(join(host, "touched.txt"), "x");
		await sync.pushHost();
		await backend.remove("/home/user/workspace/gone.txt");
		await backend.remove("/home/user/workspace/touched.txt");
		writeFileSync(join(host, "touched.txt"), "user edit");
		utimesSync(join(host, "touched.txt"), new Date(), new Date(Date.now() + 5_000));
		const report = await sync.pullRemote();
		expect(report.deletedHost).toBe(1);
		expect(existsSync(join(host, "gone.txt"))).toBe(false);
		expect(readFileSync(join(host, "touched.txt"), "utf-8")).toBe("user edit");
	});

	it("does not re-upload everything after a restart because the manifest persists", async () => {
		const { base, host, backend, sync } = await setup();
		writeFileSync(join(host, "a.txt"), "a");
		await sync.pushHost();
		const reopened = new WorkspaceSync(backend, host, "/home/user/workspace", join(base, "sync.json"));
		expect(await reopened.pushHost()).toMatchObject({ uploaded: 0 });
	});

	it("serialises overlapping syncs", async () => {
		const { host, sync } = await setup();
		for (let i = 0; i < 10; i++) writeFileSync(join(host, `f${i}.txt`), `v${i}`);
		const reports = await Promise.all([sync.pushHost(), sync.pushHost(), sync.pullRemote()]);
		expect(reports[0]!.uploaded).toBe(10);
		expect(reports[1]!.uploaded).toBe(0);
	});
});
