import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, normalizeConfig, type InnoConfig } from "../../config.js";
import { runWithoutTenantContext } from "../../tenants/current.js";
import { setRequestTenant } from "../../tenants/http.js";
import type { TenantStore } from "../../tenants/store.js";
import { handleSettingsRoutes, type SettingsRouteContext } from "./settings.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fakeReq(body?: unknown): HttpReq {
	const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as HttpReq;
	req.headers = { "content-type": "application/json" };
	return req;
}

function fakeRes(): ServerResponse & { statusCode: number; payload: any } {
	const res = {
		statusCode: 0,
		payload: undefined as unknown,
		writeHead(status: number) { res.statusCode = status; return res; },
		end(body?: string) { res.payload = body ? JSON.parse(body) : undefined; return res; },
	};
	return res as never;
}

function setup(initial: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "inno-settings-"));
	dirs.push(dir);
	const configPath = join(dir, "config.json");
	let config: InnoConfig = normalizeConfig({
		defaultProvider: "p", defaultModel: "m",
		providers: { p: { baseUrl: "http://x.invalid/v1", apiKey: "k", models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000 }] } },
		...initial,
	});
	writeFileSync(configPath, JSON.stringify(config));
	const invalidateSandbox = vi.fn();
	const ctx = {
		paths: { configPath, dataDir: dir },
		getConfig: () => config,
		setConfig: (next: InnoConfig) => { config = next; },
		invalidateSandbox,
	} as unknown as SettingsRouteContext;
	const call = async (method: string, url: string, body?: unknown, req = fakeReq(body)) => {
		const res = fakeRes();
		await handleSettingsRoutes(req, res, method, url, ctx);
		return res;
	};
	return { call, configPath, invalidateSandbox };
}

describe("sandbox settings", () => {
	it("never returns the API key, only a masked form", async () => {
		await runWithoutTenantContext(async () => {
			const { call } = setup({ sandbox: { enabled: true, apiKey: "e2b_secret_abcd" } });
			const res = await call("GET", "/api/settings");
			expect(res.payload.sandbox.apiKey).toBe("****abcd");
			expect(JSON.stringify(res.payload)).not.toContain("e2b_secret_abcd");
			expect(res.payload.sandboxEditable).toBe(true);
		});
	});

	it("saves valid settings, keeps a masked key, and tells the server to rebuild the sandbox", async () => {
		await runWithoutTenantContext(async () => {
			const { call, configPath, invalidateSandbox } = setup({ sandbox: { apiKey: "e2b_secret_abcd" } });
			const res = await call("PUT", "/api/settings/sandbox", {
				enabled: true, apiKey: "****abcd", requireApproval: "never", timeoutMinutes: 15,
				allowedDomains: ["pypi.org"], limits: { maxConcurrent: 2, maxActiveMinutesPerDay: 0 },
			});
			expect(res.statusCode).toBe(200);
			const saved = loadConfig(configPath).sandbox!;
			expect(saved).toMatchObject({ enabled: true, apiKey: "e2b_secret_abcd", requireApproval: "never", timeoutMinutes: 15, allowedDomains: ["pypi.org"] });
			expect(saved.limits).toEqual({ maxConcurrent: 2, maxActiveMinutesPerDay: 0 });
			expect(readFileSync(configPath, "utf-8")).toContain("e2b_secret_abcd");
			expect(invalidateSandbox).toHaveBeenCalledTimes(1);
			expect(res.payload.sandbox.apiKey).toBe("****abcd");
		});
	});

	it.each([
		[{ enabled: "yes" }, /enabled/],
		[{ timeoutMinutes: -1 }, /timeoutMinutes/],
		[{ requireApproval: "sometimes" }, /requireApproval/],
		[{ allowedDomains: "pypi.org" }, /allowedDomains/],
		[{ limits: { maxConcurrent: -2 } }, /maxConcurrent/],
		[{ enabled: true }, /API key/],
	])("rejects %j", async (body, message) => {
		await runWithoutTenantContext(async () => {
			const { call, invalidateSandbox } = setup();
			const res = await call("PUT", "/api/settings/sandbox", body);
			expect(res.statusCode).toBe(400);
			expect(res.payload.error).toMatch(message);
			expect(invalidateSandbox).not.toHaveBeenCalled();
		});
	});

	it("hides the sandbox from tenants and refuses their edits", async () => {
		await runWithoutTenantContext(async () => {
			const { call } = setup({ sandbox: { enabled: true, apiKey: "e2b_secret_abcd" } });
			const req = fakeReq({ enabled: false });
			setRequestTenant(req, { tenantId: "t1", userId: "u1", role: "owner" }, {} as TenantStore);
			const put = await call("PUT", "/api/settings/sandbox", undefined, req);
			expect(put.statusCode).toBe(403);
			const getReq = fakeReq();
			setRequestTenant(getReq, { tenantId: "t1", userId: "u1", role: "owner" }, {} as TenantStore);
			const get = await call("GET", "/api/settings", undefined, getReq);
			expect(get.payload.sandbox).toBeUndefined();
			expect(get.payload.sandboxEditable).toBe(false);
			expect(JSON.stringify(get.payload)).not.toContain("e2b_secret_abcd");
		});
	});
});
