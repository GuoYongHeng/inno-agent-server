import type { InnoSandboxConfig } from "../config.js";
import { E2BSandboxProvider } from "./e2b-backend.js";
import type { SandboxQuotaStore } from "./sandbox-quota.js";
import { SandboxManager } from "./sandbox-session.js";

/** Build the sandbox manager for the server's platform config, or throw on a config that cannot work. */
export function createSandboxManager(config: InnoSandboxConfig, quota?: SandboxQuotaStore): SandboxManager {
	if (!config.apiKey) {
		throw new Error("Sandbox is enabled but no API key is set: provide sandbox.apiKey in config.json or the E2B_API_KEY environment variable");
	}
	return new SandboxManager(new E2BSandboxProvider({
		apiKey: config.apiKey,
		...(config.domain ? { domain: config.domain } : {}),
		...(config.template ? { template: config.template } : {}),
		timeoutMs: config.timeoutMinutes * 60_000,
		defaultCommandTimeoutMs: config.commandTimeoutSeconds * 1000,
		allowInternetAccess: config.allowInternetAccess,
		allowedDomains: config.allowedDomains,
		requestTimeoutMs: 60_000,
	}), config, quota);
}
