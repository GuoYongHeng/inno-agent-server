import type { IncomingMessage } from "node:http";
import { TEMP_WORKSPACE_ID, type WorkspaceMeta, type WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { WorkspaceReplica } from "../workspace/workspace-replica.js";
import { getRequestTenant, ownsRequestResource } from "./http.js";
import type { TenantStore } from "./store.js";

/**
 * Resolve the legacy tmp fallback to a per-tenant directory in authenticated
 * mode. The global .tmp directory is never claimed or exposed to a tenant.
 * With a replica, workspaces owned by the tenant but created on another worker
 * are materialized into the local registry before resolution.
 */
export async function resolveRequestWorkspace(
	req: IncomingMessage,
	registry: WorkspaceRegistry,
	store: TenantStore | null | undefined,
	workspaceId?: string | null,
	replica?: WorkspaceReplica | null,
): Promise<WorkspaceMeta | null> {
	const tenant = getRequestTenant(req);
	const requestedId = workspaceId?.trim() || TEMP_WORKSPACE_ID;
	if (!tenant) return registry.getWorkspace(requestedId);
	if (requestedId !== TEMP_WORKSPACE_ID) {
		if (!await ownsRequestResource(req, store, "workspace", requestedId)) return null;
		return (replica ? await replica.materializeWorkspace(tenant, requestedId) : null) ?? registry.getWorkspace(requestedId);
	}
	if (!store) throw new Error("Tenant store is required for an authenticated request");
	const tempId = `tmp-${tenant.tenantId}`;
	const existing = registry.getWorkspace(tempId) ?? (replica ? await replica.materializeWorkspace(tenant, tempId) : null);
	if (existing && await store.ownsResource(tenant, "workspace", tempId)) {
		if (replica) await replica.replicateWorkspace(tenant, existing);
		return existing;
	}
	const workspace = existing ?? registry.createWorkspace({ isTemp: true, tempId });
	await store.claimResource(tenant, "workspace", tempId);
	if (replica) await replica.replicateWorkspace(tenant, workspace);
	return workspace;
}
