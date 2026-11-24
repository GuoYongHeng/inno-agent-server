import { tenantObjectPrefix, type ObjectMeta, type ObjectStore } from "../object-store/object-store.js";
import type { TenantContext, WorkspaceFileRow } from "../tenants/store.js";
import { workspaceObjectKey, workspaceObjectPrefix } from "./workspace-object-key.js";

/**
 * Orphan sweep for workspace object bytes. The `workspace_files` manifest is
 * the index: an object under `tenants/<t>/workspaces/<ws>/` with no file row is
 * an orphan — abandoned presigned uploads, the crash window between `put` and
 * the manifest write, failed deletes in `remove`/`move`/`deleteAll`. Orphans
 * only cost storage; a manifest row pointing at a missing object is the
 * dangerous direction and is reported separately (`read` would throw).
 *
 * Deletion honours a grace window: an object younger than `graceMs` may belong
 * to an in-flight presigned upload or replica push ahead of its manifest row,
 * so it is deferred, not deleted. Objects without `mtimeMs` are deferred for
 * the same reason (every real store now records it).
 */

/** The manifest surface the sweep needs (`TenantStore`, `FakeTenantStore`). */
export interface WorkspaceFileManifestLike {
	listWorkspaceFiles(context: TenantContext, workspaceId: string): Promise<WorkspaceFileRow[]>;
}

export interface WorkspaceObjectOrphan {
	key: string;
	size: number;
	mtimeMs?: number;
}

export interface WorkspaceObjectMissing {
	relPath: string;
	size: number;
}

export interface WorkspaceObjectAudit {
	tenantId: string;
	workspaceId: string;
	/** Objects with no manifest row, regardless of age. */
	orphans: WorkspaceObjectOrphan[];
	/** Orphans inside the grace window (or without mtime): never deleted. */
	deferred: WorkspaceObjectOrphan[];
	/** Manifest file rows whose object bytes are absent. */
	missing: WorkspaceObjectMissing[];
	/** Orphan keys actually deleted (repair mode only). */
	repaired: string[];
	error?: string;
}

/** `tenants/<t>/workspaces/<b64ws>/<b64path>` — exactly five segments. */
const WORKSPACE_OBJECT = /^tenants\/([^/]+)\/workspaces\/([^/]+)\/([^/]+)$/;

function decodeSegment(segment: string): string {
	return Buffer.from(segment, "base64url").toString("utf8");
}

export async function auditWorkspaceObjects(options: {
	objects: ObjectStore;
	store: WorkspaceFileManifestLike;
	context: TenantContext;
	workspaceId: string;
	graceMs: number;
	repair?: boolean;
	now?: number;
	/** Pre-listed objects; when absent the prefix is listed here. */
	listed?: ObjectMeta[];
}): Promise<WorkspaceObjectAudit> {
	const now = options.now ?? Date.now();
	const rows = await options.store.listWorkspaceFiles(options.context, options.workspaceId);
	const expected = new Map<string, WorkspaceFileRow>();
	for (const row of rows) {
		if (row.kind !== "file") continue;
		expected.set(workspaceObjectKey(options.context.tenantId, options.workspaceId, row.relPath), row);
	}
	const metas = options.listed ?? await options.objects.list(workspaceObjectPrefix(options.context.tenantId, options.workspaceId));
	const actual = new Map<string, ObjectMeta>();
	for (const meta of metas) actual.set(meta.key, meta);

	const orphans: WorkspaceObjectOrphan[] = [];
	const deferred: WorkspaceObjectOrphan[] = [];
	const repaired: string[] = [];
	for (const meta of metas) {
		if (expected.has(meta.key)) continue;
		const orphan: WorkspaceObjectOrphan = { key: meta.key, size: meta.size, ...(meta.mtimeMs !== undefined ? { mtimeMs: meta.mtimeMs } : {}) };
		orphans.push(orphan);
		if (!options.repair || meta.mtimeMs === undefined || now - meta.mtimeMs < options.graceMs) {
			deferred.push(orphan);
			continue;
		}
		await options.objects.delete(meta.key);
		repaired.push(meta.key);
	}
	const missing: WorkspaceObjectMissing[] = [];
	for (const [key, row] of expected) {
		if (!actual.has(key)) missing.push({ relPath: row.relPath, size: row.size });
	}
	return {
		tenantId: options.context.tenantId,
		workspaceId: options.workspaceId,
		orphans,
		deferred,
		missing: missing.sort((a, b) => a.relPath.localeCompare(b.relPath)),
		repaired,
	};
}

/**
 * Scan every workspace object in the store (single `list` over `tenants/`) and
 * audit each (tenant, workspace) group against its manifest — including
 * workspaces whose rows were already deleted, where every surviving object is
 * an orphan. `tenantId` narrows the scan to one tenant.
 */
export async function auditAllWorkspaceObjects(options: {
	objects: ObjectStore;
	store: WorkspaceFileManifestLike;
	graceMs: number;
	repair?: boolean;
	now?: number;
	tenantId?: string;
}): Promise<WorkspaceObjectAudit[]> {
	const prefix = options.tenantId ? tenantObjectPrefix(options.tenantId, "workspaces") : "tenants/";
	const metas = await options.objects.list(prefix);
	const groups = new Map<string, { context: TenantContext; workspaceId: string; metas: ObjectMeta[] }>();
	for (const meta of metas) {
		const match = WORKSPACE_OBJECT.exec(meta.key);
		if (!match) continue;
		const tenantId = match[1]!;
		const encoded = match[2]!;
		let group = groups.get(`${tenantId}/${encoded}`);
		if (!group) {
			group = {
				context: { tenantId, userId: "", role: "owner" },
				workspaceId: decodeSegment(encoded),
				metas: [],
			};
			groups.set(`${tenantId}/${encoded}`, group);
		}
		group.metas.push(meta);
	}
	const audits: WorkspaceObjectAudit[] = [];
	for (const group of groups.values()) {
		try {
			audits.push(await auditWorkspaceObjects({
				objects: options.objects,
				store: options.store,
				context: group.context,
				workspaceId: group.workspaceId,
				graceMs: options.graceMs,
				repair: options.repair,
				now: options.now,
				listed: group.metas,
			}));
		} catch (error) {
			audits.push({
				tenantId: group.context.tenantId,
				workspaceId: group.workspaceId,
				orphans: [],
				deferred: [],
				missing: [],
				repaired: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return audits.sort((a, b) => `${a.tenantId}/${a.workspaceId}`.localeCompare(`${b.tenantId}/${b.workspaceId}`));
}
