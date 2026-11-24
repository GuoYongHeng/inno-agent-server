import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { DurableSessionService } from "../agent/durable-session-service.js";
import { DurableSessionRuntime } from "../agent/durable-runtime.js";
import { normalizeConfig } from "../config.js";
import { saveTenantConfig } from "../tenants/config.js";
import { runWithoutTenantContext } from "../tenants/current.js";
import { setRequestTenant } from "../tenants/http.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import type { Pool } from "pg";
import { resolveRequestTenantDataRoot } from "../tenants/paths.js";
import { FileSessionCatalog } from "../agent/session-catalog.js";
import { LocalExecManager } from "./local-exec-manager.js";

const roots: string[] = [];
const services: DurableSessionService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const ctxT = { tenantId: "t", userId: "u", role: "owner" } as TenantContext;
const tenantStore = {
	acquireDurableStorageLock: async () => undefined,
	claimDurableStorage: async () => 1,
	renewDurableStorage: async () => true,
	releaseDurableStorage: async () => {},
} as unknown as TenantStore;
const fakePool = {
	query: async () => ({ rows: [], rowCount: 0 }),
	connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
} as unknown as Pool;

function setup() {
	const base = mkdtempSync(join(tmpdir(), "inno-local-exec-"));
	roots.push(base);
	const workspace = join(base, "workspace");
	mkdirSync(workspace, { recursive: true });
	return { base, workspace };
}

const input = (over: Record<string, unknown> = {}) => ({
	sessionId: "s1",
	hostWorkspaceDir: "",
	stateDir: "",
	persistSandboxId: async () => {},
	...over,
});

describe("LocalExecManager", () => {
	it("binds the workspace directory as the sandbox root", async () => {
		const { workspace } = setup();
		const binding = await new LocalExecManager().bind(input({ hostWorkspaceDir: workspace }));
		expect(binding.remoteRoot).toBe("/");
		expect(binding.requireApproval).toBe(false);
		await binding.backend.writeFile("/made.txt", "hi");
		expect(readFileSync(join(workspace, "made.txt"), "utf8")).toBe("hi");
	});

	it("rebases host workspace paths to the sandbox root", async () => {
		const { workspace } = setup();
		const binding = await new LocalExecManager().bind(input({ hostWorkspaceDir: workspace }));
		expect(binding.rebasePaths(`see ${workspace}/notes/a.md and root ${workspace}`)).toBe("see /notes/a.md and root /");
	});

	it("pulls before each turn and pushes on release when a replica is bound", async () => {
		const { workspace } = setup();
		const calls: string[] = [];
		const replica = {
			pull: async (tenant: TenantContext, workspaceId: string, dir: string) => {
				calls.push(`pull:${tenant.tenantId}:${workspaceId}:${dir}`);
			},
			push: async (_tenant: TenantContext, _workspaceId: string, _dir: string) => {
				calls.push("push");
			},
		};
		const tenant = { tenantId: "t1", userId: "u1", role: "owner" as const };
		const binding = await new LocalExecManager({ replica: replica as never }).bind(input({
			hostWorkspaceDir: workspace, workspaceId: "ws1", tenantContext: tenant,
		}));
		await binding.beforeTurn();
		await binding.pullToHost();
		await binding.release();
		expect(calls).toEqual([`pull:t1:ws1:${workspace}`, "push", "push"]);
	});

	it("skips replica sync without a tenant context", async () => {
		const { workspace } = setup();
		const calls: string[] = [];
		const replica = { pull: async () => calls.push("pull"), push: async () => calls.push("push") };
		const binding = await new LocalExecManager({ replica: replica as never }).bind(input({ hostWorkspaceDir: workspace }));
		await binding.beforeTurn();
		await binding.release();
		expect(calls).toEqual([]);
	});

	it("enforces maxConcurrent lazily and frees the slot on release", async () => {
		const { workspace } = setup();
		const manager = new LocalExecManager({ maxConcurrent: 1 });
		const first = await manager.bind(input({ sessionId: "s1", hostWorkspaceDir: workspace }));
		const second = await manager.bind(input({ sessionId: "s2", hostWorkspaceDir: workspace }));

		// A session that never touches files holds no slot.
		await first.backend.stat("/").catch(() => undefined);
		const denial = await second.backend.stat("/").then(() => null, (error: unknown) => error);
		expect(denial).toMatchObject({ name: "SandboxRunError", code: "unavailable" });

		// After release, the next binding can activate again.
		await first.release();
		await expect(second.backend.stat("/")).resolves.toBeDefined();
		await second.release();
	});

	it("pushes incrementally after mutations, coalescing bursts", async () => {
		const { workspace } = setup();
		const pushes: number[] = [];
		const replica = {
			pull: async () => {},
			push: async () => { pushes.push(Date.now()); await new Promise((resolve) => setTimeout(resolve, 20)); },
		};
		const binding = await new LocalExecManager({ replica: replica as never })
			.bind(input({
				hostWorkspaceDir: workspace, workspaceId: "ws1",
				tenantContext: { tenantId: "t", userId: "u", role: "owner" as const },
			}));

		await binding.backend.writeFile("/a.txt", "x");
		await binding.backend.writeFile("/b.txt", "y");
		await binding.backend.writeFile("/c.txt", "z");
		await new Promise((resolve) => setTimeout(resolve, 100));
		// Three writes coalesce into at most two pushes.
		expect(pushes.length).toBeGreaterThanOrEqual(1);
		expect(pushes.length).toBeLessThanOrEqual(2);

		// A read does not trigger a push.
		const count = pushes.length;
		await binding.backend.readFile("/a.txt");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(pushes.length).toBe(count);
		await binding.release();
	});

	it("never fails the turn on replica errors", async () => {
		const { workspace } = setup();
		const replica = {
			pull: async () => { throw new Error("down"); },
			push: async () => { throw new Error("down"); },
		};
		const binding = await new LocalExecManager({ replica: replica as never }).bind(input({
			hostWorkspaceDir: workspace,
			workspaceId: "ws1",
			tenantContext: { tenantId: "t", userId: "u", role: "owner" as const },
		}));
		await expect(binding.beforeTurn()).resolves.toBeUndefined();
		await expect(binding.release()).resolves.toBeUndefined();
	});
});

describe("durable session with local execution", () => {
	it("runs bash on the worker inside the workspace directory", async () => {
		await runWithoutTenantContext(async () => {
			const { base, workspace } = setup();
			const faux = fauxProvider();
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo from-bash > made.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const cfg = normalizeConfig({
				defaultProvider: "p", defaultModel: "m",
				providers: { p: { baseUrl: "http://x.invalid/v1", apiKey: "k", models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 4000 }] } },
			});
			saveTenantConfig(base, ctxT.tenantId, cfg);
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => cfg,
				enabled: true,
				resolveWorkspaceDir: () => workspace,
				getSandboxManager: () => new LocalExecManager(),
				pgCatalog: new FileSessionCatalog((r) => join(resolveRequestTenantDataRoot(r, base), "durable", "sessions.json")),
				recoveryPool: fakePool,
				tenantStore,
				openRuntime: async ({ openStorage: _pg, ...options }) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			setRequestTenant(req, ctxT, tenantStore);
			const session = await service.create(req, { workspaceId: "w" });
			const lease = await service.lease(req, session.id);
			try {
				const submission = await lease.runtime.submit("make a file", "r1");
				await lease.runtime.waitForSubmission(submission.id);
			} finally {
				await lease.release();
			}
			expect(existsSync(join(workspace, "made.txt"))).toBe(true);
			expect(readFileSync(join(workspace, "made.txt"), "utf8")).toBe("from-bash\n");
		});
	});
});
