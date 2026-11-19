import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	created: [] as unknown[],
	connectError: undefined as Error | undefined,
	instance: undefined as unknown,
	killed: [] as string[],
}));

vi.mock("e2b", async (importOriginal) => {
	const actual = await importOriginal<typeof import("e2b")>();
	class FakeSandbox {
		static async create(...args: unknown[]) {
			fake.created.push(args);
			return fake.instance;
		}
		static async connect(_id: string) {
			if (fake.connectError) throw fake.connectError;
			return fake.instance;
		}
		static listCalls: unknown[] = [];
		static list(opts: unknown) {
			FakeSandbox.listCalls.push(opts);
			const pages = [[{ sandboxId: "a", startedAt: new Date(1000), metadata: { app: "inno-agent" }, state: "running" }], [{ sandboxId: "b", startedAt: new Date(2000), metadata: { app: "inno-agent", sessionId: "s" }, state: "paused" }]];
			let index = 0;
			return { get hasNext() { return index < pages.length; }, async nextItems() { return pages[index++]!; } };
		}
		static async kill(id: string) {
			fake.killed.push(id);
			if (fake.connectError) throw fake.connectError;
			return true;
		}
	}
	return { ...actual, Sandbox: FakeSandbox };
});

import { CommandExitError, FileType, NotFoundError, SandboxNotFoundError } from "e2b";
import { E2BSandboxBackend, E2BSandboxProvider } from "./e2b-backend.js";

function handle(result: { exitCode: number } | Error, killed: { n: number }) {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	return {
		kill: async () => { killed.n++; release?.(); return true; },
		wait: async () => {
			if (result instanceof Error) throw result;
			if (result.exitCode === -1) await gate;
			return { exitCode: result.exitCode, stdout: "", stderr: "" };
		},
	};
}

function fakeSandbox(over: Record<string, unknown> = {}) {
	return { sandboxId: "sbx-1", setTimeout: vi.fn(), pause: vi.fn(), kill: vi.fn(), ...over };
}

describe("E2BSandboxBackend", () => {
	it("maps a non-zero exit to a result and forwards cwd, envs and output callbacks", async () => {
		const killed = { n: 0 };
		const run = vi.fn(async () => handle(new CommandExitError({ exitCode: 3, stdout: "", stderr: "bad", error: "x" }), killed));
		const backend = new E2BSandboxBackend(fakeSandbox({ commands: { run } }) as never, {});
		const onStdout = vi.fn();
		expect(await backend.run("false", { cwd: "/w", envs: { A: "1" }, onStdout })).toEqual({ exitCode: 3 });
		expect(run).toHaveBeenCalledWith("false", expect.objectContaining({ background: true, cwd: "/w", envs: { A: "1" }, onStdout, timeoutMs: 0 }));
	});

	it("kills the process and reports a timeout or an abort", async () => {
		const killed = { n: 0 };
		const run = vi.fn(async () => handle({ exitCode: -1 }, killed));
		const backend = new E2BSandboxBackend(fakeSandbox({ commands: { run } }) as never, {});
		await expect(backend.run("sleep 99", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
		expect(killed.n).toBe(1);
		const abort = new AbortController();
		const pending = backend.run("sleep 99", { signal: abort.signal });
		setTimeout(() => abort.abort(), 10);
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(killed.n).toBe(2);
		await expect(backend.run("x", { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "aborted" });
	});

	it("applies the default command limit when the caller gives none", async () => {
		const killed = { n: 0 };
		const run = vi.fn(async () => handle({ exitCode: -1 }, killed));
		const backend = new E2BSandboxBackend(fakeSandbox({ commands: { run } }) as never, { defaultCommandTimeoutMs: 15 });
		await expect(backend.run("sleep 99")).rejects.toMatchObject({ code: "timeout" });
	});

	it("reads bytes, lists with depth, maps entries and translates errors", async () => {
		const files = {
			read: vi.fn(async (path: string) => { if (path === "/missing") throw new NotFoundError("no"); return new Uint8Array([1, 2]); }),
			write: vi.fn(),
			list: vi.fn(async () => [
				{ name: "b", path: "/d/b", type: FileType.FILE, size: 2, modifiedTime: new Date(2000) },
				{ name: "a", path: "/d/a", type: FileType.DIR, size: 0 },
			]),
			getInfo: vi.fn(async () => ({ name: "f", path: "/f", type: FileType.SYMLINK, size: 1, modifiedTime: new Date(5) })),
			makeDir: vi.fn(), remove: vi.fn(), rename: vi.fn(),
		};
		const backend = new E2BSandboxBackend(fakeSandbox({ files }) as never, {});
		expect(await backend.readFile("/f")).toEqual(new Uint8Array([1, 2]));
		expect(files.read).toHaveBeenCalledWith("/f", expect.objectContaining({ format: "bytes" }));
		await expect(backend.readFile("/missing")).rejects.toMatchObject({ code: "not_found" });
		expect((await backend.list("/d")).map((e) => [e.name, e.kind])).toEqual([["a", "directory"], ["b", "file"]]);
		expect(files.list).toHaveBeenCalledWith("/d", expect.objectContaining({ depth: 1 }));
		await backend.listTree("/d", 7);
		expect(files.list).toHaveBeenLastCalledWith("/d", expect.objectContaining({ depth: 7 }));
		expect(await backend.stat("/f")).toMatchObject({ kind: "symlink", mtimeMs: 5 });
	});
});

describe("E2BSandboxProvider", () => {
	it("creates with the template, lifetime, metadata and network policy", async () => {
		fake.created.length = 0;
		fake.instance = fakeSandbox();
		const provider = new E2BSandboxProvider({ apiKey: "k", template: "tpl", timeoutMs: 1234, allowInternetAccess: false });
		const backend = await provider.create({ metadata: { sessionId: "s" } });
		expect(backend.id).toBe("sbx-1");
		expect(fake.created[0]).toEqual(["tpl", expect.objectContaining({ apiKey: "k", timeoutMs: 1234, metadata: { sessionId: "s" }, allowInternetAccess: false })]);
	});

	it("lists every sandbox this application created, across pages, filtered by metadata", async () => {
		const provider = new E2BSandboxProvider({ apiKey: "k" });
		expect(await provider.listManaged()).toEqual([
			{ id: "a", createdAt: 1000, metadata: { app: "inno-agent" }, state: "running" },
			{ id: "b", createdAt: 2000, metadata: { app: "inno-agent", sessionId: "s" }, state: "paused" },
		]);
	});

	it("restricts egress to the allowlist and leaves it open without one", async () => {
		fake.created.length = 0;
		fake.instance = fakeSandbox();
		await new E2BSandboxProvider({ apiKey: "k", allowedDomains: ["pypi.org", "*.github.com"] }).create();
		expect(fake.created[0]).toEqual([expect.objectContaining({ network: { denyOut: ["0.0.0.0/0"], allowOut: ["pypi.org", "*.github.com"] } })]);
		await new E2BSandboxProvider({ apiKey: "k" }).create();
		expect((fake.created[1] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("network");
		await new E2BSandboxProvider({ apiKey: "k", allowInternetAccess: false, allowedDomains: ["pypi.org"] }).create();
		expect((fake.created[2] as Array<Record<string, unknown>>)[0]).toMatchObject({ allowInternetAccess: false });
		expect((fake.created[2] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("network");
	});

	it("connect returns null for a sandbox that is gone and rethrows other failures", async () => {
		fake.instance = fakeSandbox();
		const provider = new E2BSandboxProvider({ apiKey: "k" });
		expect((await provider.connect("sbx-1"))?.id).toBe("sbx-1");
		fake.connectError = new SandboxNotFoundError("gone");
		expect(await provider.connect("sbx-1")).toBeNull();
		await provider.destroy("sbx-1");
		fake.connectError = new Error("network down");
		await expect(provider.connect("sbx-1")).rejects.toThrow("network down");
		fake.connectError = undefined;
	});
});
