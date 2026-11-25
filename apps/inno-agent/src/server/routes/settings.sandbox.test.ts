import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeConfig, type InnoConfig } from "../../config.js";
import { setRequestTenant } from "../../tenants/http.js";
import type { TenantStore } from "../../tenants/store.js";
import { FakeTenantStore, ctxA } from "../../workspace/fake-tenant-store.js";
import { handleSettingsRoutes, type SettingsRouteContext } from "./settings.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tenantStore = new FakeTenantStore();
function fakeReq(body?: unknown): HttpReq {
	const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as HttpReq;
	req.headers = { "content-type": "application/json" };
	setRequestTenant(req, ctxA, tenantStore as unknown as TenantStore);
	return req;
}

function fakeRes(): ServerResponse & { statusCode: number; payload: any } {
	const res = {
		statusCode: 0,
		payload: undefined as unknown,
		writeHead(status: number) { res.statusCode = status; return res; },
		end(body?: string) { res.payload = body ? JSON.parse(body) : undefined; return res; },
	};
	return res as unknown as ServerResponse & { statusCode: number; payload: any };
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "inno-settings-"));
	dirs.push(dir);
	const configPath = join(dir, "config.json");
	const config: InnoConfig = normalizeConfig({
		defaultProvider: "p", defaultModel: "m",
		providers: { p: { baseUrl: "http://x.invalid/v1", apiKey: "k", models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000 }] } },
		sandbox: { enabled: true, apiKey: "e2b_secret_abcd" },
	});
	writeFileSync(configPath, JSON.stringify(config));
	const ctx = {
		paths: { configPath, dataDir: dir },
		getConfig: () => config,
		setConfig: () => {},
		invalidateSandbox: vi.fn(),
	} as unknown as SettingsRouteContext;
	const call = async (method: string, url: string, body?: unknown) => {
		const res = fakeRes();
		await handleSettingsRoutes(fakeReq(body), res, method, url, ctx);
		return res;
	};
	return { call };
}

describe("sandbox settings (tenant view)", () => {
	it("hides the platform sandbox entirely from tenant settings", async () => {
		const { call } = setup();
		const res = await call("GET", "/api/settings");
		expect(res.statusCode).toBe(200);
		expect(res.payload.sandbox).toBeUndefined();
		expect(res.payload.sandboxEditable).toBe(false);
		expect(JSON.stringify(res.payload)).not.toContain("e2b_secret_abcd");
	});

	it.each([
		{ enabled: true },
		{ enabled: false },
		{ apiKey: "new-key" },
	])("rejects sandbox writes from a tenant: %o", async (body) => {
		const { call } = setup();
		const res = await call("PUT", "/api/settings/sandbox", body);
		expect(res.statusCode).toBe(403);
	});
});
