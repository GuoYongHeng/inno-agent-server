import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { logger } from "../logger.js";
import type { ObjectStore } from "../object-store/object-store.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { incCounter, observeMs } from "../utils/metrics.js";
import { isWithin } from "../utils/path-safety.js";
import { workspaceObjectKey, workspaceObjectPrefix } from "./workspace-object-key.js";
import { TEMP_WORKSPACE_ID, type WorkspaceMeta, type WorkspaceRegistry } from "./workspace-registry.js";

/**
 * Replicates tenant workspaces into durable storage so any worker can
 * reconstruct them after a takeover:
 * - registry rows (`workspaces/registry.json`) → `tenant_workspaces` (PG)
 * - session→workspace bindings (`sessions/workspaces.json`) → `session_workspaces` (PG)
 * - workspace file bytes → `tenants/<t>/workspaces/<ws>/<path>` objects + the
 *   `workspace_files` listing table (PG)
 * The worker-local directory stays the working copy; the replica is the
 * durable mirror. Sync granularity is file-level last-writer-wins — two workers
 * actively writing the same shared workspace can overwrite each other's copy,
 * which is documented in the roadmap.
 */

const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache", ".global-skills"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_DEPTH = 24;

interface ReplicaStamp {
	size: number;
	mtimeMs: number;
	/** Absent in state files written before directory replication: a file. */
	kind?: "file" | "directory";
}

interface ReplicaState {
	files: Record<string, ReplicaStamp>;
}

export interface ReplicaReport {
	uploaded: number;
	downloaded: number;
	deleted: number;
	skipped: number;
}

function ignored(rel: string): boolean {
	return rel.split("/").some((part) => IGNORED_DIRS.has(part));
}

function b64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

export class WorkspaceReplica {
	/**
	 * What this process last pushed or pulled per (tenant, workspace). It is how
	 * `push` tells "deleted locally" from "never materialised"; losing it on a
	 * restart is safe because `pull` re-records every file it reconciles and a
	 * file absent from the state is simply re-uploaded, never deleted.
	 */
	private readonly states = new Map<string, ReplicaState>();

	constructor(
		private readonly objects: ObjectStore,
		private readonly store: TenantStore,
		private readonly registry: WorkspaceRegistry,
	) {}

	private objectKey(context: TenantContext, workspaceId: string, rel: string): string {
		return workspaceObjectKey(context.tenantId, workspaceId, rel);
	}

	private stateKey(context: TenantContext, workspaceId: string): string {
		return `${b64(context.tenantId)}--${b64(workspaceId)}`;
	}

	private loadState(context: TenantContext, workspaceId: string): ReplicaState {
		return this.states.get(this.stateKey(context, workspaceId)) ?? { files: {} };
	}

	private saveState(context: TenantContext, workspaceId: string, state: ReplicaState): void {
		this.states.set(this.stateKey(context, workspaceId), state);
	}

	// ---- Registry + binding replication -------------------------------------

	async replicateWorkspace(context: TenantContext, ws: WorkspaceMeta): Promise<void> {
		await this.store.upsertWorkspaceRow(context, {
			workspaceId: ws.id, relPath: ws.relPath, name: ws.name, isTemp: ws.isTemp,
		});
	}

	async deleteWorkspace(context: TenantContext, workspaceId: string): Promise<void> {
		await this.store.deleteWorkspaceRow(context, workspaceId);
		await this.objects.deletePrefix(workspaceObjectPrefix(context.tenantId, workspaceId));
		this.states.delete(this.stateKey(context, workspaceId));
	}

	async setSessionBinding(context: TenantContext, sessionId: string, workspaceId: string): Promise<void> {
		await this.store.setSessionWorkspace(context, sessionId, workspaceId);
	}

	async clearSessionBinding(context: TenantContext, sessionId: string): Promise<void> {
		await this.store.deleteSessionWorkspace(context, sessionId);
	}

	/**
	 * Ensure the local registry knows `workspaceId`, adopting the replicated
	 * row when the workspace was created on another worker. Returns the local
	 * meta or null when the workspace is unknown everywhere.
	 */
	async materializeWorkspace(context: TenantContext, workspaceId: string,
		options?: { download?: (relPath: string) => boolean }): Promise<WorkspaceMeta | null> {
		const local = this.registry.getWorkspace(workspaceId);
		if (local) return local;
		const row = await this.store.getWorkspaceRow(context, workspaceId);
		if (!row) return null;
		const meta = this.registry.adoptWorkspace({
			id: row.workspaceId, name: row.name, relPath: row.relPath,
			createdAt: row.createdAt, updatedAt: row.updatedAt, isTemp: row.isTemp,
		});
		const dir = join(this.registry.workspaceRoot, meta.relPath);
		mkdirSync(dir, { recursive: true });
		// A freshly adopted workspace is empty locally — pull its replica before
		// callers write, so remote files aren't "missing" from the next push.
		await this.pull(context, workspaceId, dir, options);
		return meta;
	}

	/**
	 * Resolve the workspace a session opens on this worker: an existing local
	 * binding wins, then the replicated binding, then the catalog workspace,
	 * then the shared tmp fallback. Adopted bindings are written into the local
	 * session map so `getSessionWorkspaceId` resolves correctly afterwards.
	 */
	async materializeSessionWorkspace(context: TenantContext, sessionId: string, catalogWorkspaceId?: string | null,
		options?: { download?: (relPath: string) => boolean }): Promise<string> {
		if (this.registry.isSessionBound(sessionId)) {
			const id = this.registry.getSessionWorkspaceId(sessionId);
			await this.materializeWorkspace(context, id, options);
			return id;
		}
		const candidates = [await this.store.getSessionWorkspace(context, sessionId), catalogWorkspaceId ?? null];
		for (const id of candidates) {
			if (!id || id === TEMP_WORKSPACE_ID) continue;
			if (await this.materializeWorkspace(context, id, options)) {
				this.registry.bindSession(sessionId, id);
				return id;
			}
		}
		return TEMP_WORKSPACE_ID;
	}

	// ---- File sync -----------------------------------------------------------

	private hostFiles(dir: string): Map<string, ReplicaStamp> {
		const out = new Map<string, ReplicaStamp>();
		const walk = (current: string, depth: number) => {
			if (depth > MAX_DEPTH || out.size >= MAX_FILES) return;
			let entries;
			try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				const full = join(current, entry.name);
				const rel = relative(dir, full).split(sep).join("/");
				if (entry.isDirectory()) {
					// Directories (including empty ones) replicate as manifest rows so
					// another worker reconstructs them before any file arrives inside.
					out.set(rel, { size: 0, mtimeMs: statSync(full).mtimeMs, kind: "directory" });
					if (out.size >= MAX_FILES) return;
					walk(full, depth + 1);
				} else if (entry.isFile()) {
					const stats = statSync(full);
					if (stats.size > MAX_FILE_BYTES) { incCounter("inno_workspace_replica_skipped_total"); continue; }
					out.set(rel, { size: stats.size, mtimeMs: stats.mtimeMs, kind: "file" });
					if (out.size >= MAX_FILES) return;
				}
			}
		};
		walk(dir, 0);
		return out;
	}

	/** Local workspace → objects + listing rows. Local deletions propagate. */
	async push(context: TenantContext, workspaceId: string, dir: string): Promise<ReplicaReport> {
		const started = performance.now();
		try {
			return await this.pushInner(context, workspaceId, dir);
		} finally {
			observeMs("inno_workspace_replica_push_ms", performance.now() - started);
		}
	}

	private async pushInner(context: TenantContext, workspaceId: string, dir: string): Promise<ReplicaReport> {
		const report: ReplicaReport = { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0 };
		const state = this.loadState(context, workspaceId);
		const upserts: Array<{ relPath: string; size: number; mtimeMs: number }> = [];
		const deletes: string[] = [];
		if (!existsSync(dir)) { this.saveState(context, workspaceId, state); return report; }
		for (const [rel, stamp] of this.hostFiles(dir)) {
			const known = state.files[rel];
			if (known && (known.kind ?? "file") === stamp.kind && known.size === stamp.size && known.mtimeMs === stamp.mtimeMs) continue;
			if (stamp.kind === "directory") {
				// No object: a directory exists only as a manifest row.
				state.files[rel] = stamp;
				upserts.push({ relPath: rel, ...stamp });
				continue; // directories upload no object, so `uploaded` stays object-count
			}
			const bytes = new Uint8Array(readFileSync(join(dir, ...rel.split("/"))));
			await this.objects.put(this.objectKey(context, workspaceId, rel), bytes);
			incCounter("inno_workspace_replica_uploaded_bytes", bytes.length);
			state.files[rel] = stamp;
			upserts.push({ relPath: rel, ...stamp });
			report.uploaded++;
		}
		for (const rel of Object.keys(state.files)) {
			const stamp = state.files[rel]!;
			const target = join(dir, ...rel.split("/"));
			let gone = false;
			try {
				const stats = lstatSync(target);
				gone = (stamp.kind ?? "file") === "directory" ? !stats.isDirectory() : !stats.isFile();
			} catch { gone = true; }
			if (!gone) continue;
			if ((stamp.kind ?? "file") !== "directory") await this.objects.delete(this.objectKey(context, workspaceId, rel));
			delete state.files[rel];
			deletes.push(rel);
			report.deleted++;
		}
		await this.store.syncWorkspaceFiles(context, workspaceId, upserts, deletes);
		this.saveState(context, workspaceId, state);
		incCounter("inno_workspace_replica_uploaded_total", report.uploaded);
		return report;
	}

	/**
	 * Remote replica → local workspace: downloads rows whose local file is
	 * missing or has drifted, and never deletes files the replica doesn't know
	 * (local extras are kept). Returns early when the workspace has no replica.
	 * `options.download` defers bodies the filter rejects (lazy pull): deferred
	 * rows are NOT recorded in pull state — recording them would let the next
	 * push treat the never-materialized file as a local deletion and remove
	 * the manifest row + object.
	 */
	async pull(context: TenantContext, workspaceId: string, dir: string,
		options?: { download?: (relPath: string) => boolean }): Promise<ReplicaReport> {
		const started = performance.now();
		try {
			return await this.pullInner(context, workspaceId, dir, options);
		} finally {
			observeMs("inno_workspace_replica_pull_ms", performance.now() - started);
		}
	}

	/**
	 * Pull ONE manifest file into the local copy on demand (lazy pull): the
	 * object is downloaded only when the local file is missing or has drifted
	 * from the manifest row. Returns whether the manifest knows the file.
	 */
	async materializeFile(context: TenantContext, workspaceId: string, dir: string, relPath: string): Promise<boolean> {
		const started = performance.now();
		try {
			const row = await this.store.getWorkspaceFile(context, workspaceId, relPath);
			if (!row || row.kind !== "file" || ignored(row.relPath)) return false;
			const target = join(dir, ...row.relPath.split("/"));
			if (!isWithin(dir, target)) return false;
			let local: ReplicaStamp | null = null;
			try {
				const stats = lstatSync(target);
				if (stats.isFile()) local = { size: stats.size, mtimeMs: stats.mtimeMs };
			} catch { /* missing */ }
			const state = this.loadState(context, workspaceId);
			if (!local || local.size !== row.size || local.mtimeMs !== row.mtimeMs) {
				const body = await this.objects.get(this.objectKey(context, workspaceId, row.relPath));
				if (!body) {
					incCounter("inno_workspace_replica_materialize_errors_total");
					return false;
				}
				incCounter("inno_workspace_replica_downloaded_bytes", body.length);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, body);
				const mtimeSec = row.mtimeMs / 1000;
				try { utimesSync(target, mtimeSec, mtimeSec); } catch { /* mtime best-effort */ }
				incCounter("inno_workspace_replica_materialized_total");
			}
			state.files[row.relPath] = { size: row.size, mtimeMs: row.mtimeMs, kind: "file" };
			this.saveState(context, workspaceId, state);
			return true;
		} finally {
			observeMs("inno_workspace_replica_materialize_ms", performance.now() - started);
		}
	}

	private async pullInner(context: TenantContext, workspaceId: string, dir: string,
		options?: { download?: (relPath: string) => boolean }): Promise<ReplicaReport> {
		const report: ReplicaReport = { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0 };
		const rows = await this.store.listWorkspaceFiles(context, workspaceId);
		if (rows.length === 0) return report;
		const state = this.loadState(context, workspaceId);
		mkdirSync(dir, { recursive: true });
		for (const row of rows) {
			if (ignored(row.relPath)) { report.skipped++; continue; }
			const target = join(dir, ...row.relPath.split("/"));
			if (!isWithin(dir, target)) { report.skipped++; continue; }
			if (row.kind === "directory") {
				// Directory rows carry no object; materialize the folder (empty
				// directories created on another worker appear locally).
				try {
					mkdirSync(target, { recursive: true });
					const mtimeSec = row.mtimeMs / 1000;
					try { utimesSync(target, mtimeSec, mtimeSec); } catch { /* mtime best-effort */ }
					state.files[row.relPath] = { size: 0, mtimeMs: row.mtimeMs, kind: "directory" };
				} catch { report.skipped++; }
				continue;
			}
			let local: ReplicaStamp | null = null;
			try {
				const stats = lstatSync(target);
				if (stats.isFile()) local = { size: stats.size, mtimeMs: stats.mtimeMs };
			} catch { /* missing */ }
			if (local && local.size === row.size && local.mtimeMs === row.mtimeMs) {
				state.files[row.relPath] = row;
				continue;
			}
			if (options?.download && !options.download(row.relPath)) {
				// Lazy pull: leave the body for materializeFile. Not recording
				// state keeps the entry pending for the next pull AND safe from
				// push's local-deletion propagation.
				report.skipped++;
				continue;
			}
			const body = await this.objects.get(this.objectKey(context, workspaceId, row.relPath));
			if (!body) { report.skipped++; logger.warn({ workspaceId, rel: row.relPath }, "workspace replica object missing"); continue; }
			incCounter("inno_workspace_replica_downloaded_bytes", body.length);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, body);
			const mtimeSec = row.mtimeMs / 1000;
			try { utimesSync(target, mtimeSec, mtimeSec); } catch { /* mtime best-effort */ }
			state.files[row.relPath] = { size: row.size, mtimeMs: row.mtimeMs, kind: "file" };
			report.downloaded++;
		}
		this.saveState(context, workspaceId, state);
		incCounter("inno_workspace_replica_downloaded_total", report.downloaded);
		return report;
	}
}
