import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { requireRequestTenant } from "./http.js";
import { getCurrentTenant } from "./current.js";

/**
 * Virtual namespace for tenant-scoped storage keys: a tenant's L2 wiki, L3
 * index and durable sessions are identified as `<root>/tenants/<id>/<domain>`.
 * It is never created and nothing is stored under it — the data lives in
 * PostgreSQL and object storage. The root is absolute and not writable, so an
 * accidental local write fails loudly instead of silently landing on disk.
 */
export const VIRTUAL_TENANT_ROOT = "/inno-virtual";

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
