import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { requireRequestTenant } from "./http.js";
import { getCurrentTenant } from "./current.js";

/** Resolve private HTTP state without trusting client-provided tenant paths. */
export function resolveRequestTenantDataRoot(req: IncomingMessage, dataDir: string): string {
	const tenant = requireRequestTenant(req);
	return tenant ? join(dataDir, "tenants", tenant.tenantId) : dataDir;
}

/** Resolve a domain directory without trusting client-provided path segments. */
export function resolveTenantDataDir(
	req: IncomingMessage,
	dataDir: string,
	domain: "l2" | "l3",
): string {
	const tenant = requireRequestTenant(req);
	return tenant ? join(dataDir, "tenants", tenant.tenantId, domain) : join(dataDir, domain);
}

export function resolveCurrentTenantDataRoot(dataDir: string): string {
	const tenant = getCurrentTenant();
	return tenant ? join(dataDir, "tenants", tenant.tenantId) : dataDir;
}

export function resolveCurrentTenantDataDir(
	dataDir: string,
	domain: "l2" | "l3" | "runs",
): string {
	const tenant = getCurrentTenant();
	return tenant ? join(dataDir, "tenants", tenant.tenantId, domain) : join(dataDir, domain);
}
