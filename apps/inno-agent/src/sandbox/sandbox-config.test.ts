import { describe, expect, it } from "vitest";
import { normalizeSandboxConfig } from "../config.js";
import { createSandboxManager } from "./index.js";

describe("normalizeSandboxConfig", () => {
	it("is off by default and safe by default", () => {
		expect(normalizeSandboxConfig(undefined, {})).toEqual({
			enabled: false, provider: "e2b", timeoutMinutes: 30, commandTimeoutSeconds: 600, allowInternetAccess: true, requireApproval: "always",
			limits: { maxConcurrent: 3, maxSandboxes: 20, maxActiveMinutesPerDay: 480 },
			allowedDomains: [],
		});
	});

	it("reads the key and switch from the environment, with config winning", () => {
		const env = { INNO_SANDBOX_ENABLED: "true", E2B_API_KEY: "env-key" } as NodeJS.ProcessEnv;
		expect(normalizeSandboxConfig(undefined, env)).toMatchObject({ enabled: true, apiKey: "env-key" });
		expect(normalizeSandboxConfig({ apiKey: " cfg-key ", enabled: false }, env)).toMatchObject({ enabled: false, apiKey: "cfg-key" });
	});

	it("reads the self-hosted domain and template from the environment, with config winning", () => {
		const env = { E2B_DOMAIN: " env-sandbox.example.com ", E2B_TEMPLATE: "env-tpl" } as NodeJS.ProcessEnv;
		expect(normalizeSandboxConfig(undefined, env)).toMatchObject({ domain: "env-sandbox.example.com", template: "env-tpl" });
		expect(normalizeSandboxConfig({ domain: "cfg.example.com", template: " cfg-tpl " }, env))
			.toMatchObject({ domain: "cfg.example.com", template: "cfg-tpl" });
	});

	it("rejects nonsense numbers and only relaxes approval on an explicit 'never'", () => {
		expect(normalizeSandboxConfig({ timeoutMinutes: -5, commandTimeoutSeconds: Number.NaN, requireApproval: "sometimes" as never }, {}))
			.toMatchObject({ timeoutMinutes: 30, commandTimeoutSeconds: 600, requireApproval: "always" });
		expect(normalizeSandboxConfig({ requireApproval: "never", allowInternetAccess: false }, {}))
			.toMatchObject({ requireApproval: "never", allowInternetAccess: false });
	});

	it("reads per-tenant limits, treating 0 as unlimited and ignoring invalid values", () => {
		expect(normalizeSandboxConfig({ limits: { maxConcurrent: 0, maxSandboxes: 5, maxActiveMinutesPerDay: -1 } }, {}).limits)
			.toEqual({ maxConcurrent: 0, maxSandboxes: 5, maxActiveMinutesPerDay: 480 });
	});

	it("normalizes the egress allowlist: trims, drops blanks and non-strings, removes duplicates", () => {
		expect(normalizeSandboxConfig({ allowedDomains: [" pypi.org ", "", "pypi.org", 3 as never, "*.github.com"] }, {}).allowedDomains)
			.toEqual(["pypi.org", "*.github.com"]);
	});

	it("refuses to build a manager without credentials", () => {
		expect(() => createSandboxManager(normalizeSandboxConfig({ enabled: true }, {}))).toThrow(/API key/);
	});
});
