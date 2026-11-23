import { tenantObjectKey, tenantObjectPrefix } from "../object-store/object-store.js";

function b64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * The object key for one workspace file's bytes. Shared by `WorkspaceReplica`
 * (which writes the objects) and `ObjectWorkspaceStore` (which reads/writes
 * them through the manifest): the scheme is frozen so replicated data stays
 * readable by either component.
 */
export function workspaceObjectKey(tenantId: string, workspaceId: string, relPath: string): string {
	return tenantObjectKey(tenantId, "workspaces", b64(workspaceId), b64(relPath));
}

/** Prefix holding every object of one workspace (`deletePrefix`/`list` target). */
export function workspaceObjectPrefix(tenantId: string, workspaceId: string): string {
	return tenantObjectPrefix(tenantId, "workspaces", b64(workspaceId));
}
