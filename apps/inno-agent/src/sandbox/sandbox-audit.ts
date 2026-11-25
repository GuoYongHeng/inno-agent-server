import type { ManagedSandboxInfo, SandboxProvider } from "./sandbox-backend.js";

export interface OrphanSandbox extends ManagedSandboxInfo {
	/** The session the sandbox was created for, from its metadata. */
	sessionId?: string;
	tenantId?: string;
}

/** A sandbox younger than this may belong to a session whose record is still being written. */
export const ORPHAN_SANDBOX_GRACE_MS = 60 * 60_000;

/**
 * Sandboxes this application created that no session record references: a delete
 * that failed to destroy the sandbox, or a crash between creating one and
 * recording its ID. They keep costing money until the provider's own timeout.
 * Read-only; {@link removeOrphanSandboxes} destroys them.
 */
export async function findOrphanSandboxes(
	provider: SandboxProvider,
	referencedIds: ReadonlySet<string>,
	options: { graceMs?: number; now?: number } = {},
): Promise<OrphanSandbox[]> {
	const now = options.now ?? Date.now();
	const grace = options.graceMs ?? ORPHAN_SANDBOX_GRACE_MS;
	return (await provider.listManaged())
		.filter((sandbox) => !referencedIds.has(sandbox.id) && now - sandbox.createdAt >= grace)
		.map((sandbox) => ({
			...sandbox,
			...(sandbox.metadata.sessionId ? { sessionId: sandbox.metadata.sessionId } : {}),
			...(sandbox.metadata.tenantId ? { tenantId: sandbox.metadata.tenantId } : {}),
		}))
		.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeOrphanSandboxes(provider: SandboxProvider, orphans: readonly OrphanSandbox[]): Promise<{ removed: string[]; failed: Array<{ id: string; error: string }> }> {
	const removed: string[] = [];
	const failed: Array<{ id: string; error: string }> = [];
	for (const orphan of orphans) {
		try {
			await provider.destroy(orphan.id);
			removed.push(orphan.id);
		} catch (error) {
			failed.push({ id: orphan.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removed, failed };
}
