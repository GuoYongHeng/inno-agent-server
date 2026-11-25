import type { IncomingMessage } from "node:http";
import { TEMP_WORKSPACE_ID, type WorkspaceMeta, type WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { WorkspaceReplica } from "../workspace/workspace-replica.js";
import { ownsRequestResource, requireRequestTenant } from "./http.js";
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
	store: TenantStore,
	workspaceId?: string | null,
	replica?: WorkspaceReplica | null,
): Promise<WorkspaceMeta | null> {
	const tenant = requireRequestTenant(req);
	const requestedId = workspaceId?.trim() || TEMP_WORKSPACE_ID;
	if (requestedId !== TEMP_WORKSPACE_ID) {
		if (!await ownsRequestResource(req, store, "workspace", requestedId)) return null;
		return (replica ? await replica.materializeWorkspace(tenant, requestedId) : null) ?? registry.getWorkspace(requestedId);
	}
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

/**
 * Read-path resolution: same ownership rules as `resolveRequestWorkspace` but
 * never materializes files — authenticated reads are served from the manifest
 * + object store, so pulling the replica onto this worker's disk would be
 * wasted I/O. The tmp mapping still claims the `tmp-<tenantId>` id and
 * replicates its registry row (a brand-new tenant's tmp workspace must exist),
 * it just skips the file pull. Returns the resolvable id + display name only.
 */
export async function resolveRequestWorkspaceForRead(
	req: IncomingMessage,
	registry: WorkspaceRegistry,
	store: TenantStore,
	workspaceId?: string | null,
	replica?: WorkspaceReplica | null,
): Promise<{ id: string; name: string } | null> {
	const tenant = requireRequestTenant(req);
	const requestedId = workspaceId?.trim() || TEMP_WORKSPACE_ID;
	if (requestedId !== TEMP_WORKSPACE_ID) {
		if (!await ownsRequestResource(req, store, "workspace", requestedId)) return null;
		const row = await store.getWorkspaceRow(tenant, requestedId);
		return row ? { id: row.workspaceId, name: row.name } : null;
	}
	const tempId = `tmp-${tenant.tenantId}`;
	let workspace = registry.getWorkspace(tempId);
	if (!workspace) {
		const row = await store.getWorkspaceRow(tenant, tempId);
		workspace = registry.createWorkspace({ isTemp: true, tempId, name: row?.name });
	}
	if (!await store.ownsResource(tenant, "workspace", tempId)) {
		await store.claimResource(tenant, "workspace", tempId);
	}
	if (replica) await replica.replicateWorkspace(tenant, workspace);
	return { id: workspace.id, name: workspace.name };
}
