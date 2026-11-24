import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig, normalizeSandboxConfig } from "../config.js";
import { LocalDirSandboxProvider } from "../sandbox/local-backend.js";
import { SandboxManager, SANDBOX_WORKSPACE_ROOT } from "../sandbox/sandbox-session.js";
import { runWithoutTenantContext } from "../tenants/current.js";
import { setRequestTenant } from "../tenants/http.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import type { Pool } from "pg";
import { resolveRequestTenantDataRoot } from "../tenants/paths.js";
import { DurableSessionService } from "./durable-session-service.js";
import { FileSessionCatalog } from "./session-catalog.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const roots: string[] = [];
const services: DurableSessionService[] = [];
const providers: LocalDirSandboxProvider[] = [];
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

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const provider of providers.splice(0)) provider.dispose();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(approval: "always" | "never", responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const base = mkdtempSync(join(tmpdir(), "inno-sandbox-svc-"));
	roots.push(base);
	const workspace = join(base, "workspace");
	const skills = join(base, "skills");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(skills, "demo"), { recursive: true });
	writeFileSync(join(skills, "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\nbody");
	const provider = new LocalDirSandboxProvider();
	providers.push(provider);
	const sandboxConfig = normalizeSandboxConfig({ enabled: true, requireApproval: approval }, {});
	const manager = new SandboxManager(provider, sandboxConfig);
	const faux = fauxProvider();
	faux.setResponses(responses);
	const instructions: string[] = [];
	const cfg = normalizeConfig({
		defaultProvider: "p", defaultModel: "m",
		providers: { p: { baseUrl: "http://x.invalid/v1", apiKey: "k", models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000 }] } },
	});
	const service = new DurableSessionService({
		dataDir: base,
		getLocalConfig: () => cfg,
		enabled: true,
		resolveWorkspaceDir: () => workspace,
		skillsDir: skills,
		getSandboxManager: () => manager,
		pgCatalog: new FileSessionCatalog((r) => join(resolveRequestTenantDataRoot(r, base), "durable", "sessions.json")),
		recoveryPool: fakePool,
		tenantStore,
		openRuntime: async ({ openStorage: _pg, ...options }) => {
			instructions.push(options.instructions ?? "");
			const models = createModels();
			models.setProvider(faux.provider);
			return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
		},
	});
	services.push(service);
	const req = { headers: {} } as IncomingMessage;
	setRequestTenant(req, ctxT, tenantStore);
	const turn = async (sessionId: string, prompt: string, requestId: string, noUi = false) => {
		const lease = await service.lease(req, sessionId);
		try {
			if (noUi) lease.runtime.bindPermissionTurn({ turnId: requestId, noUi: true });
			const submission = await lease.runtime.submit(prompt, requestId);
			return await lease.runtime.waitForSubmission(submission.id);
		} finally {
			await lease.release();
		}
	};
	return { base, workspace, skills, provider, service, req, turn, faux, instructions };
}

let callCounter = 0;
const bash = (command: string) => fauxAssistantMessage(fauxToolCall("bash", { command }, { id: `bash-${++callCounter}` }), { stopReason: "toolUse" });

describe("durable session with a remote sandbox", () => {
	it("runs bash in the sandbox, syncs both ways, and reconnects the same sandbox on reopen", async () => {
		await runWithoutTenantContext(async () => {
			const t = setup("never", [
				bash("echo from-sandbox > made.txt && cat user.txt"),
				fauxAssistantMessage("first done"),
				bash("cat user.txt && pwd"),
				fauxAssistantMessage("second done"),
			]);
			writeFileSync(join(t.workspace, "user.txt"), "v1");
			const session = await t.service.create(t.req, { workspaceId: "w" });

			await t.turn(session.id, "go", "r1");
			const record = await t.service.get(t.req, session.id);
			expect(record?.sandboxId).toMatch(/^local-/);
			expect(t.provider.sandboxes.size).toBe(1);
			// The command ran in the sandbox: its file reached the host only through sync.
			expect(readFileSync(join(t.workspace, "made.txt"), "utf-8")).toBe("from-sandbox\n");
			const sandbox = t.provider.sandboxes.get(record!.sandboxId!)!;
			expect(sandbox.paused).toBe(true);

			// A host edit between turns is visible to the next command.
			writeFileSync(join(t.workspace, "user.txt"), "v2-edited-on-host");
			await t.turn(session.id, "again", "r2");
			expect(t.provider.sandboxes.size).toBe(1);
			const messages = JSON.stringify((await t.service.snapshot(t.req, session.id)).messages);
			expect(messages).toContain("v2-edited-on-host");
			expect(messages).toContain(SANDBOX_WORKSPACE_ROOT);
			expect(t.faux.state.callCount).toBe(4);
		});
	});

	it("describes the sandbox in the instructions and rebases skill and workspace paths", async () => {
		await runWithoutTenantContext(async () => {
			const t = setup("never", [fauxAssistantMessage("hi")]);
			const session = await t.service.create(t.req, { workspaceId: "w" });
			await t.turn(session.id, "hello", "r1");
			const text = t.instructions[0]!;
			expect(text).toContain("沙箱执行环境");
			expect(text).toContain("/home/user/.inno/skills/demo/SKILL.md");
			expect(text).not.toContain(t.skills);
		});
	});

	it("denies a shell command that needs approval when no one can be asked", async () => {
		await runWithoutTenantContext(async () => {
			const t = setup("always", [bash("echo nope > forbidden.txt"), fauxAssistantMessage("could not")]);
			const session = await t.service.create(t.req, { workspaceId: "w" });
			await t.turn(session.id, "go", "r1", true);
			expect(existsSync(join(t.workspace, "forbidden.txt"))).toBe(false);
			const sandbox = [...t.provider.sandboxes.values()][0]!;
			await expect(sandbox.stat(`${SANDBOX_WORKSPACE_ROOT}/forbidden.txt`)).rejects.toMatchObject({ code: "not_found" });
		});
	});

	it("destroys the sandbox when the session is deleted", async () => {
		await runWithoutTenantContext(async () => {
			const t = setup("never", [fauxAssistantMessage("hi")]);
			const session = await t.service.create(t.req, { workspaceId: "w" });
			await t.turn(session.id, "hello", "r1");
			const sandbox = [...t.provider.sandboxes.values()][0]!;
			await t.service.delete(t.req, session.id);
			expect(sandbox.killed).toBe(true);
			expect(await t.service.get(t.req, session.id)).toBeUndefined();
		});
	});

	it("creates a fresh sandbox and re-seeds it when the recorded one no longer exists", async () => {
		await runWithoutTenantContext(async () => {
			const t = setup("never", [bash("cat user.txt"), fauxAssistantMessage("a"), bash("cat user.txt"), fauxAssistantMessage("b")]);
			writeFileSync(join(t.workspace, "user.txt"), "seed");
			const session = await t.service.create(t.req, { workspaceId: "w" });
			await t.turn(session.id, "one", "r1");
			const first = (await t.service.get(t.req, session.id))!.sandboxId!;
			await t.provider.destroy(first);
			await t.turn(session.id, "two", "r2");
			const second = (await t.service.get(t.req, session.id))!.sandboxId!;
			expect(second).not.toBe(first);
			expect(JSON.stringify((await t.service.snapshot(t.req, session.id)).messages)).toContain("seed");
		});
	});
});
