import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { normalizeSandboxConfig } from "../config.js";
import { LocalDirSandboxProvider } from "./local-backend.js";
import { GuardedSandboxBackend, InMemorySandboxQuotaStore, SANDBOX_LEASE_STALE_MS, type SandboxLimits } from "./sandbox-quota.js";
import { SandboxManager } from "./sandbox-session.js";

const limits = (over: Partial<SandboxLimits> = {}): SandboxLimits => ({ maxConcurrent: 2, maxSandboxes: 5, maxActiveMinutesPerDay: 60, ...over });
const MIN = 60_000;

describe("InMemorySandboxQuotaStore", () => {
	it("caps concurrent leases per tenant, not across tenants, and is idempotent per session", async () => {
		const store = new InMemorySandboxQuotaStore();
		expect((await store.acquire("t1", "s1", limits())).ok).toBe(true);
		expect((await store.acquire("t1", "s1", limits())).ok).toBe(true);
		expect((await store.acquire("t1", "s2", limits())).ok).toBe(true);
		const denied = await store.acquire("t1", "s3", limits());
		expect(denied).toMatchObject({ ok: false, reason: "concurrent" });
		expect((await store.acquire("t2", "s9", limits())).ok).toBe(true);
		await store.release("t1", "s1");
		expect((await store.acquire("t1", "s3", limits())).ok).toBe(true);
	});

	it("meters running time per UTC day, including leases still running", async () => {
		let now = Date.parse("2026-06-01T10:00:00Z");
		const store = new InMemorySandboxQuotaStore(() => now);
		await store.acquire("t", "s1", limits());
		now += 30 * MIN;
		expect(await store.usedMinutesToday("t")).toBe(30);
		await store.release("t", "s1");
		now += 5 * MIN;
		expect(await store.usedMinutesToday("t")).toBe(30);
		await store.acquire("t", "s1", limits());
		now += 31 * MIN;
		expect(await store.heartbeat("t", "s1", limits())).toMatchObject({ ok: false, reason: "time" });
		await store.release("t", "s1");
		expect(await store.acquire("t", "s1", limits())).toMatchObject({ ok: false, reason: "time" });
		now = Date.parse("2026-06-02T00:00:01Z");
		expect((await store.acquire("t", "s1", limits())).ok).toBe(true);
	});

	it("reaps a lease whose owner stopped heartbeating and counts it up to its last sign of life", async () => {
		let now = Date.parse("2026-06-01T10:00:00Z");
		const store = new InMemorySandboxQuotaStore(() => now);
		await store.acquire("t", "dead", limits({ maxConcurrent: 1 }));
		now += 20 * MIN;
		await store.heartbeat("t", "dead", limits());
		now += SANDBOX_LEASE_STALE_MS + MIN;
		expect((await store.acquire("t", "live", limits({ maxConcurrent: 1 }))).ok).toBe(true);
		// Up to the last heartbeat (20 min); the silent 11 minutes are not billed to the dead owner.
		expect(await store.usedMinutesToday("t")).toBe(20);
	});

	it("treats 0 as unlimited", async () => {
		const store = new InMemorySandboxQuotaStore();
		const open = limits({ maxConcurrent: 0, maxActiveMinutesPerDay: 0 });
		for (let i = 0; i < 20; i++) expect((await store.acquire("t", `s${i}`, open)).ok).toBe(true);
	});
});

describe("GuardedSandboxBackend", () => {
	it("fails every operation with the reason while blocked and works once attached and unblocked", async () => {
		const provider = new LocalDirSandboxProvider();
		try {
			const guarded = new GuardedSandboxBackend(undefined, "g");
			guarded.block("over the limit");
			await expect(guarded.readFile("/x")).rejects.toMatchObject({ code: "permission_denied", message: "over the limit" });
			await expect(guarded.run("echo hi")).rejects.toMatchObject({ code: "unavailable", message: "over the limit" });
			guarded.attach(await provider.create());
			guarded.unblock();
			await guarded.writeFile("/x", "ok");
			expect(new TextDecoder().decode(await guarded.readFile("/x"))).toBe("ok");
			guarded.block("again");
			await expect(guarded.stat("/x")).rejects.toMatchObject({ message: "again" });
		} finally {
			provider.dispose();
		}
	});
});

describe("SandboxManager limits", () => {
	const dirs: string[] = [];
	const providers: LocalDirSandboxProvider[] = [];
	afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
	afterAll(() => { for (const p of providers) p.dispose(); });

	function make(over: Parameters<typeof normalizeSandboxConfig>[0] = {}, now?: () => number) {
		const provider = new LocalDirSandboxProvider();
		providers.push(provider);
		const config = normalizeSandboxConfig({ enabled: true, ...over }, {});
		const quota = new InMemorySandboxQuotaStore(now);
		const manager = new SandboxManager(provider, config, quota);
		const input = (session: string, tenant = "t1", extra: Record<string, unknown> = {}) => {
			const base = mkdtempSync(join(tmpdir(), "inno-quota-"));
			dirs.push(base);
			const host = join(base, "ws");
			mkdirSync(host);
			writeFileSync(join(host, "f.txt"), "hello");
			let persisted: string | undefined;
			return {
				persisted: () => persisted,
				input: { sessionId: session, tenantId: tenant, hostWorkspaceDir: host, stateDir: base, persistSandboxId: async (id: string) => { persisted = id; }, ...extra },
			};
		};
		return { provider, manager, quota, input, host: (i: ReturnType<typeof input>) => i.input.hostWorkspaceDir };
	}

	it("switches a session's sandbox off when the tenant is at its concurrency limit, and recovers on a later turn", async () => {
		const { manager, provider, input } = make({ limits: { maxConcurrent: 1 } });
		const a = input("sa");
		const b = input("sb");
		const first = await manager.bind(a.input);
		const second = await manager.bind(b.input);
		expect(provider.sandboxes.size).toBe(1);
		await expect(second.backend.run("echo hi")).rejects.toMatchObject({ message: expect.stringContaining("同时运行的沙箱数量上限") });
		await second.beforeTurn();
		await expect(second.backend.run("echo hi")).rejects.toMatchObject({ code: "unavailable" });

		await first.release();
		await second.beforeTurn();
		expect(provider.sandboxes.size).toBe(2);
		expect((await second.backend.run("echo hi")).exitCode).toBe(0);
		expect(b.persisted()).toMatch(/^local-/);
	});

	it("does not count other tenants against the limit", async () => {
		const { manager, input } = make({ limits: { maxConcurrent: 1 } });
		await manager.bind(input("sa", "t1").input);
		const other = await manager.bind(input("sb", "t2").input);
		expect((await other.backend.run("echo hi")).exitCode).toBe(0);
	});

	it("refuses to create more sandboxes than the tenant may own but still reconnects existing ones", async () => {
		const { manager, provider, input } = make({ limits: { maxSandboxes: 2 } });
		const blocked = await manager.bind(input("s1", "t1", { countTenantSandboxes: async () => 2 }).input);
		await expect(blocked.backend.run("echo hi")).rejects.toMatchObject({ message: expect.stringContaining("沙箱总数上限") });
		expect(provider.sandboxes.size).toBe(0);
		const existing = await provider.create();
		const reconnect = await manager.bind(input("s2", "t1", { sandboxId: existing.id, countTenantSandboxes: async () => 2 }).input);
		expect((await reconnect.backend.run("echo hi")).exitCode).toBe(0);
	});

	it("stops a session that runs out of daily time: pulls its work home, pauses, and reports why", async () => {
		let now = Date.parse("2026-06-01T10:00:00Z");
		const { manager, provider, input } = make({ limits: { maxActiveMinutesPerDay: 10 } }, () => now);
		const s = input("s1");
		const binding = await manager.bind(s.input);
		await binding.backend.writeFile("/home/user/workspace/made.txt", "agent output");
		now += 11 * MIN;
		await binding.beforeTurn();
		expect([...provider.sandboxes.values()][0]!.paused).toBe(true);
		await expect(binding.backend.run("echo hi")).rejects.toMatchObject({ message: expect.stringContaining("今日沙箱使用时长已达上限") });
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(join(s.input.hostWorkspaceDir, "made.txt"), "utf-8")).toBe("agent output");
		// The next UTC day it comes back by itself.
		now = Date.parse("2026-06-02T00:05:00Z");
		await binding.beforeTurn();
		expect((await binding.backend.run("echo hi")).exitCode).toBe(0);
	});

	it("releases the lease when connecting fails, so a failed open does not hold a slot", async () => {
		const { manager, provider, quota, input } = make({ limits: { maxConcurrent: 1 } });
		provider.create = async () => { throw new Error("cloud down"); };
		await expect(manager.bind(input("s1").input)).rejects.toThrow("cloud down");
		expect((await quota.acquire("t1", "other", limits({ maxConcurrent: 1 }))).ok).toBe(true);
	});
});
