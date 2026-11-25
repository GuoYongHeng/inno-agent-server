import type { TenantContext, WorkspaceFileRow } from "../tenants/store.js";
import { WorkspaceStoreError } from "./workspace-store.js";

/** In-memory TenantStore: the exact workspace_files surface the stores use. */
export class FakeTenantStore {
	readonly rows = new Map<string, WorkspaceFileRow>();

	/** Unit tests exercise the authenticated path; every resource reads as owned. */
	async ownsResource(_context: TenantContext, _kind: string, _resourceId: string): Promise<boolean> { return true; }
	async claimResource(_context: TenantContext, _kind: string, _resourceId: string): Promise<void> {}
	async releaseResource(_context: TenantContext, _kind: string, _resourceId: string): Promise<void> {}

	private key(context: TenantContext, workspaceId: string, relPath: string): string {
		return `${context.tenantId}/${workspaceId}/${relPath}`;
	}

	async getWorkspaceFile(context: TenantContext, workspaceId: string, relPath: string): Promise<WorkspaceFileRow | null> {
		return this.rows.get(this.key(context, workspaceId, relPath)) ?? null;
	}

	async listWorkspaceFiles(context: TenantContext, workspaceId: string): Promise<WorkspaceFileRow[]> {
		const base = `${context.tenantId}/${workspaceId}/`;
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(base))
			.map(([, row]) => row)
			.sort((a, b) => a.relPath.localeCompare(b.relPath));
	}

	async listWorkspaceFilesUnder(context: TenantContext, workspaceId: string, prefix: string, limit: number): Promise<WorkspaceFileRow[]> {
		const base = `${context.tenantId}/${workspaceId}/`;
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(base) && key.slice(base.length).startsWith(prefix))
			.map(([, row]) => row)
			.sort((a, b) => a.relPath.localeCompare(b.relPath))
			.slice(0, limit);
	}

	async summarizeWorkspacePrefix(context: TenantContext, workspaceId: string, prefix: string): Promise<{ count: number; maxMtimeMs: number }> {
		const base = `${context.tenantId}/${workspaceId}/`;
		let count = 0;
		let maxMtimeMs = 0;
		for (const [key, row] of this.rows.entries()) {
			if (!key.startsWith(base) || !key.slice(base.length).startsWith(prefix)) continue;
			count++;
			maxMtimeMs = Math.max(maxMtimeMs, row.mtimeMs);
		}
		return { count, maxMtimeMs };
	}

	async putWorkspaceFile(context: TenantContext, workspaceId: string, row: WorkspaceFileRow): Promise<void> {
		this.rows.set(this.key(context, workspaceId, row.relPath), { ...row });
	}

	async deleteWorkspaceFiles(context: TenantContext, workspaceId: string, path: string, descendants: boolean): Promise<WorkspaceFileRow[]> {
		const removed: WorkspaceFileRow[] = [];
		const base = `${context.tenantId}/${workspaceId}/`;
		for (const [key, row] of [...this.rows.entries()]) {
			if (!key.startsWith(base)) continue;
			const rel = key.slice(base.length);
			if (rel === path || (descendants && rel.startsWith(`${path}/`))) {
				this.rows.delete(key);
				removed.push(row);
			}
		}
		return removed;
	}

	async moveWorkspaceFiles(context: TenantContext, workspaceId: string, from: string, to: string): Promise<WorkspaceFileRow[]> {
		const base = `${context.tenantId}/${workspaceId}/`;
		const conflict = [...this.rows.keys()].some((key) => {
			if (!key.startsWith(base)) return false;
			const rel = key.slice(base.length);
			return rel === to || rel.startsWith(`${to}/`);
		});
		if (conflict) throw new WorkspaceStoreError("exists", `destination exists: ${to}`, to);
		const moved: WorkspaceFileRow[] = [];
		for (const [key, row] of [...this.rows.entries()]) {
			if (!key.startsWith(base)) continue;
			const rel = key.slice(base.length);
			if (rel === from || rel.startsWith(`${from}/`)) {
				this.rows.delete(key);
				moved.push(row);
			}
		}
		for (const row of moved) {
			this.rows.set(this.key(context, workspaceId, to + row.relPath.slice(from.length)), row);
		}
		return moved;
	}

	async deleteAllWorkspaceFiles(context: TenantContext, workspaceId: string): Promise<void> {
		const base = `${context.tenantId}/${workspaceId}/`;
		for (const key of [...this.rows.keys()]) if (key.startsWith(base)) this.rows.delete(key);
	}
}

export const ctxA = { tenantId: "tenant-a", userId: "user-a", role: "owner" } as TenantContext;
export const ctxB = { tenantId: "tenant-b", userId: "user-b", role: "owner" } as TenantContext;
