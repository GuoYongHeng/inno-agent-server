import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { logger } from "../logger.js";
import { readJson, writeJson } from "../storage/file-store.js";
import { incCounter } from "../utils/metrics.js";
import { isWithin } from "../utils/path-safety.js";
import type { SandboxBackend } from "./sandbox-backend.js";

/** Directory names never synchronised in either direction. */
const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_DEPTH = 24;

interface SyncRecord {
	/** Host file stamp when this path was last in sync. */
	hostSize: number;
	hostMtimeMs: number;
	/** Sandbox file stamp when this path was last in sync. */
	remoteSize: number;
	remoteMtimeMs: number;
}

interface SyncState {
	files: Record<string, SyncRecord>;
}

export interface SyncReport {
	uploaded: number;
	downloaded: number;
	deletedHost: number;
	skipped: number;
}

function ignored(rel: string): boolean {
	return rel.split("/").some((part) => IGNORED_DIRS.has(part));
}

/**
 * Keeps a session's host workspace and its sandbox workspace in step. The
 * sandbox is where the agent works; the host copy is what the web UI shows,
 * previews and attaches. Two operations, each a diff against the state recorded
 * at the previous sync:
 * - {@link pushHost}: files the user added or changed on the host go to the sandbox
 *   (host wins). Host deletions are not propagated.
 * - {@link pullRemote}: files the agent created or changed in the sandbox come to
 *   the host (sandbox wins), and files the agent deleted are deleted on the host
 *   only if the host copy has not changed since the last sync.
 * Symlinks, oversized files and ignored directories are skipped and counted.
 */
export class WorkspaceSync {
	private state: SyncState;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly backend: SandboxBackend,
		private readonly hostDir: string,
		private readonly remoteRoot: string,
		private readonly statePath: string,
	) {
		this.state = readJson<SyncState>(statePath, { files: {} });
		if (!this.state.files || typeof this.state.files !== "object") this.state = { files: {} };
	}

	/** Serialise syncs: they read and write one manifest. */
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.chain.then(operation, operation);
		this.chain = next.catch(() => undefined);
		return next;
	}

	private save(): void {
		writeJson(this.statePath, this.state);
	}

	private hostFiles(): Map<string, { size: number; mtimeMs: number }> {
		const out = new Map<string, { size: number; mtimeMs: number }>();
		const walk = (dir: string, depth: number) => {
			if (depth > MAX_DEPTH || out.size >= MAX_FILES) return;
			let entries;
			try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full, depth + 1);
				else if (entry.isFile()) {
					const stats = statSync(full);
					if (stats.size > MAX_FILE_BYTES) { incCounter("inno_sandbox_sync_skipped_total"); continue; }
					out.set(relative(this.hostDir, full).split(sep).join("/"), { size: stats.size, mtimeMs: stats.mtimeMs });
					if (out.size >= MAX_FILES) return;
				}
			}
		};
		walk(this.hostDir, 0);
		return out;
	}

	private async remoteFiles(): Promise<Map<string, { size: number; mtimeMs: number }>> {
		const out = new Map<string, { size: number; mtimeMs: number }>();
		let entries;
		try {
			entries = await this.backend.listTree(this.remoteRoot, MAX_DEPTH);
		} catch (error) {
			if ((error as { code?: string }).code === "not_found") return out;
			throw error;
		}
		for (const entry of entries) {
			if (entry.kind !== "file") continue;
			const rel = posix.relative(this.remoteRoot, entry.path);
			if (!rel || rel.startsWith("..") || ignored(rel)) continue;
			if (entry.size > MAX_FILE_BYTES) { incCounter("inno_sandbox_sync_skipped_total"); continue; }
			out.set(rel, { size: entry.size, mtimeMs: entry.mtimeMs });
			if (out.size >= MAX_FILES) break;
		}
		return out;
	}

	/** Host → sandbox. */
	pushHost(): Promise<SyncReport> {
		return this.serial(async () => {
			const report: SyncReport = { uploaded: 0, downloaded: 0, deletedHost: 0, skipped: 0 };
			mkdirSync(this.hostDir, { recursive: true });
			await this.backend.makeDir(this.remoteRoot);
			for (const [rel, stamp] of this.hostFiles()) {
				const known = this.state.files[rel];
				if (known && known.hostSize === stamp.size && known.hostMtimeMs === stamp.mtimeMs) continue;
				const data = new Uint8Array(readFileSync(join(this.hostDir, rel)));
				await this.backend.writeFile(posix.join(this.remoteRoot, rel), data);
				const remote = await this.backend.stat(posix.join(this.remoteRoot, rel));
				this.state.files[rel] = { hostSize: stamp.size, hostMtimeMs: stamp.mtimeMs, remoteSize: remote.size, remoteMtimeMs: remote.mtimeMs };
				report.uploaded++;
			}
			this.save();
			incCounter("inno_sandbox_sync_uploaded_total", report.uploaded);
			return report;
		});
	}

	/** Sandbox → host. */
	pullRemote(): Promise<SyncReport> {
		return this.serial(async () => {
			const report: SyncReport = { uploaded: 0, downloaded: 0, deletedHost: 0, skipped: 0 };
			const remote = await this.remoteFiles();
			for (const [rel, stamp] of remote) {
				const known = this.state.files[rel];
				if (known && known.remoteSize === stamp.size && known.remoteMtimeMs === stamp.mtimeMs) continue;
				const target = join(this.hostDir, ...rel.split("/"));
				if (!isWithin(this.hostDir, target)) { report.skipped++; continue; }
				const data = await this.backend.readFile(posix.join(this.remoteRoot, rel));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, data);
				const host = statSync(target);
				this.state.files[rel] = { hostSize: host.size, hostMtimeMs: host.mtimeMs, remoteSize: stamp.size, remoteMtimeMs: stamp.mtimeMs };
				report.downloaded++;
			}
			for (const [rel, known] of Object.entries(this.state.files)) {
				if (remote.has(rel) || ignored(rel)) continue;
				// Deleted in the sandbox. Delete on the host only if the user has not touched it since.
				const target = join(this.hostDir, ...rel.split("/"));
				if (!isWithin(this.hostDir, target)) continue;
				try {
					const host = lstatSync(target);
					if (host.isFile() && host.size === known.hostSize && host.mtimeMs === known.hostMtimeMs) {
						rmSync(target);
						report.deletedHost++;
					} else if (existsSync(target)) {
						report.skipped++;
						continue;
					}
				} catch { /* already gone */ }
				delete this.state.files[rel];
			}
			this.save();
			incCounter("inno_sandbox_sync_downloaded_total", report.downloaded);
			if (report.deletedHost || report.skipped) logger.debug({ report }, "sandbox workspace pull");
			return report;
		});
	}

	/** Forget the manifest, so the next push re-uploads everything. */
	reset(): void {
		this.state = { files: {} };
		this.save();
	}
}
