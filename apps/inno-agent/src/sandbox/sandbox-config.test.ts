import { describe, expect, it } from "vitest";
import { normalizeSandboxConfig } from "../config.js";
import { createSandboxManager } from "./index.js";

describe("normalizeSandboxConfig", () => {
	it("is off by default and safe by default", () => {
		expect(normalizeSandboxConfig(undefined, {})).toEqual({
			enabled: false, provider: "e2b", timeoutMinutes: 30, commandTimeoutSeconds: 600, allowInternetAccess: true, requireApproval: "always",
		});
	});

	it("reads the key and switch from the environment, with config winning", () => {
		const env = { INNO_SANDBOX_ENABLED: "true", E2B_API_KEY: "env-key" } as NodeJS.ProcessEnv;
		expect(normalizeSandboxConfig(undefined, env)).toMatchObject({ enabled: true, apiKey: "env-key" });
		expect(normalizeSandboxConfig({ apiKey: " cfg-key ", enabled: false }, env)).toMatchObject({ enabled: false, apiKey: "cfg-key" });
	});

	it("rejects nonsense numbers and only relaxes approval on an explicit 'never'", () => {
		expect(normalizeSandboxConfig({ timeoutMinutes: -5, commandTimeoutSeconds: Number.NaN, requireApproval: "sometimes" as never }, {}))
			.toMatchObject({ timeoutMinutes: 30, commandTimeoutSeconds: 600, requireApproval: "always" });
		expect(normalizeSandboxConfig({ requireApproval: "never", allowInternetAccess: false }, {}))
			.toMatchObject({ requireApproval: "never", allowInternetAccess: false });
	});

	it("refuses to build a manager without credentials", () => {
		expect(() => createSandboxManager(normalizeSandboxConfig({ enabled: true }, {}))).toThrow(/API key/);
	});
});
