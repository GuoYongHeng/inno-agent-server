import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalTreeRoot, safeJoinReal } from "../server/file-helpers.js";
import { isWithin } from "../utils/path-safety.js";
import { isIgnoredName, pageEntries } from "./workspace-listing.js";
import {
	normalizeWorkspacePath,
	WORKSPACE_MAX_FILE_BYTES,
	WorkspaceStoreError,
	type WorkspaceEntry,
	type WorkspaceListOptions,
	type WorkspaceListPage,
	type WorkspaceStore,
} from "./workspace-store.js";

function fail(code: ConstructorParameters<typeof WorkspaceStoreError>[0], message: string, path?: string): never {
	throw new WorkspaceStoreError(code, message, path);
}

/**
 * The file-backed workspace store (local mode): plain fs operations over the
 * worker's own directory, reproducing the existing HTTP route semantics —
 * including the symlink guard (`safeJoinReal`): a path whose real location
 * escapes the workspace root behaves as if it did not exist, and broken
 * symlinks are skipped rather than fatal.
 */
export class LocalFsWorkspaceStore implements WorkspaceStore {
	private readonly maxFileBytes: number;

	constructor(
		private readonly options: {
			resolveRoot: (workspaceId: string) => string | null;
			maxFileBytes?: number;
		},
	) {
		this.maxFileBytes = options.maxFileBytes ?? WORKSPACE_MAX_FILE_BYTES;
	}

	private root(workspaceId: string): string {
		const root = this.options.resolveRoot(workspaceId);
		if (!root) fail("not_found", `workspace not found: ${workspaceId}`, workspaceId);
		return root;
	}

	/** Canonical containment check; null means the path is "not there" to callers. */
	private resolve(root: string, relPath: string): string | null {
		return safeJoinReal(root, relPath);
	}

	private entry(root: string, full: string, stats: Stats): WorkspaceEntry {
		const rel = full.slice(root.length).replaceAll("\\", "/").replace(/^\//, "");
		return {
			path: rel,
			name: basename(full),
			kind: stats.isDirectory() ? "directory" : "file",
			size: stats.isDirectory() ? 0 : stats.size,
			mtimeMs: stats.mtimeMs,
		};
	}

	/** Stat `full` for listing: null for anything unreadable or escaping the root. */
	private listableStat(canonicalRoot: string, full: string): { stats: Stats; real: string } | null {
		try {
			const stats = statSync(full); // follows symlinks
			const real = realpathSync(full);
			if (!isWithin(canonicalRoot, real)) return null;
			return { stats, real };
		} catch {
			return null;
		}
	}

	async list(workspaceId: string, dir: string, options?: WorkspaceListOptions): Promise<WorkspaceListPage> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(dir);
		const full = target === "" ? root : this.resolve(root, target);
		if (!full || !existsSync(full)) fail("not_found", `directory not found: ${target}`, target);
		const stats = statSync(full);
		if (!stats.isDirectory()) fail("not_directory", `not a directory: ${target}`, target);
		const canonicalRoot = canonicalTreeRoot(root);
		const entries: WorkspaceEntry[] = [];
		for (const child of readdirSync(full, { withFileTypes: true })) {
			if (isIgnoredName(child.name)) continue;
			const childFull = join(full, child.name);
			const resolved = this.listableStat(canonicalRoot, childFull);
			if (!resolved) continue; // broken symlink or escape: skip, never fatal
			entries.push(this.entry(root, childFull, resolved.stats));
		}
		return pageEntries(entries.sort((a, b) =>
			Number(b.kind === "directory") - Number(a.kind === "directory")
			|| a.name.localeCompare(b.name, "zh-CN")), options);
	}

	async stat(workspaceId: string, path: string): Promise<WorkspaceEntry | null> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(path);
		if (target === "") return { path: "", name: "", kind: "directory", size: 0, mtimeMs: statSync(root).mtimeMs };
		const full = this.resolve(root, target);
		if (!full) return null;
		try {
			return this.entry(root, full, statSync(full));
		} catch {
			return null;
		}
	}

	async read(workspaceId: string, path: string): Promise<{ entry: WorkspaceEntry; body: Uint8Array } | null> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(path);
		const full = target === "" ? null : this.resolve(root, target);
		if (!full) return null;
		let stats;
		try { stats = statSync(full); } catch { return null; }
		if (!stats.isFile()) return null;
		if (stats.size > this.maxFileBytes) fail("too_large", `file too large: ${target}`, target);
		return { entry: this.entry(root, full, stats), body: new Uint8Array(readFileSync(full)) };
	}

	async write(workspaceId: string, path: string, body: Uint8Array): Promise<WorkspaceEntry> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(path);
		if (target === "") fail("is_directory", "cannot write the workspace root", target);
		if (body.byteLength > this.maxFileBytes) fail("too_large", `file too large: ${target}`, target);
		const full = this.resolve(root, target);
		if (!full) fail("not_found", `invalid target: ${target}`, target);
		this.checkAncestors(root, target);
		if (existsSync(full) && statSync(full).isDirectory()) {
			fail("is_directory", `is a directory: ${target}`, target);
		}
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
		return this.entry(root, full, statSync(full));
	}

	async mkdir(workspaceId: string, path: string): Promise<WorkspaceEntry> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(path);
		if (target === "") return { path: "", name: "", kind: "directory", size: 0, mtimeMs: statSync(root).mtimeMs };
		const full = this.resolve(root, target);
		if (!full) fail("not_found", `invalid target: ${target}`, target);
		this.checkAncestors(root, target);
		if (existsSync(full) && !statSync(full).isDirectory()) {
			fail("not_directory", `not a directory: ${target}`, target);
		}
		mkdirSync(full, { recursive: true });
		return this.entry(root, full, statSync(full));
	}

	/** An existing non-directory on the path chain rejects directory-ish writes. */
	private checkAncestors(root: string, relPath: string): void {
		const segments = relPath.split("/");
		for (let index = 1; index < segments.length; index++) {
			const ancestor = join(root, ...segments.slice(0, index));
			try {
				if (!lstatSync(ancestor).isDirectory()) {
					fail("not_directory", `not a directory: ${segments.slice(0, index).join("/")}`, relPath);
				}
			} catch (error) {
				if (error instanceof WorkspaceStoreError) throw error;
				// Missing ancestors are fine — they are created on write.
			}
		}
	}

	async remove(workspaceId: string, path: string, options?: { recursive?: boolean }): Promise<void> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(path);
		if (target === "") fail("invalid_path", "cannot remove the workspace root", target);
		const full = this.resolve(root, target);
		if (!full || !existsSync(full)) fail("not_found", `not found: ${target}`, target);
		const stats = statSync(full);
		if (stats.isDirectory()) {
			if (options?.recursive !== true && readdirSync(full).length > 0) {
				fail("exists", `directory not empty: ${target}`, target);
			}
			rmSync(full, { recursive: true, force: true });
		} else {
			rmSync(full, { force: true });
		}
	}

	async move(workspaceId: string, from: string, to: string): Promise<void> {
		const root = this.root(workspaceId);
		const source = normalizeWorkspacePath(from);
		const destination = normalizeWorkspacePath(to);
		if (source === "" || destination === "" || source === destination || destination.startsWith(`${source}/`)) {
			fail("invalid_path", `invalid move: ${source} -> ${destination}`, destination);
		}
		const fullSource = this.resolve(root, source);
		const fullDestination = this.resolve(root, destination);
		if (!fullSource || !existsSync(fullSource)) fail("not_found", `not found: ${source}`, source);
		if (!fullDestination) fail("not_found", `invalid target: ${destination}`, destination);
		if (existsSync(fullDestination)) fail("exists", `destination exists: ${destination}`, destination);
		this.checkAncestors(root, destination);
		mkdirSync(dirname(fullDestination), { recursive: true });
		try {
			renameSync(fullSource, fullDestination);
		} catch (error) {
			// EXDEV or parent-kind conflicts surface as filesystem errors; map the
			// common "parent is a file" failure onto the store vocabulary.
			fail("invalid_path", `cannot move: ${(error as Error).message}`, destination);
		}
	}

	async *walk(workspaceId: string, dir: string, options?: { maxEntries?: number }): AsyncIterable<WorkspaceEntry> {
		const root = this.root(workspaceId);
		const target = normalizeWorkspacePath(dir);
		const full = target === "" ? root : this.resolve(root, target);
		if (!full || !existsSync(full)) fail("not_found", `directory not found: ${target}`, target);
		if (!statSync(full).isDirectory()) fail("not_directory", `not a directory: ${target}`, target);
		const maxEntries = options?.maxEntries ?? 50_000;
		const canonicalRoot = canonicalTreeRoot(root);
		const collected: WorkspaceEntry[] = [];
		let overflow = false;
		// `ancestors` mirrors the legacy tree's `seen` guard: it holds the real
		// directory chain from the root, so a symlink cycle stops at the
		// ancestor it points back to — but a sibling symlink to an
		// already-visited directory is still listed with its full subtree,
		// exactly like the old tree reader.
		const rootAncestors = new Set<string>();
		try { rootAncestors.add(realpathSync(full)); } catch { /* root resolved earlier */ }
		const visit = (current: string, ancestors: ReadonlySet<string>) => {
			if (overflow) return;
			let children;
			try { children = readdirSync(current, { withFileTypes: true }); } catch { return; }
			// Descend in the legacy order (dirs first, zh-CN names) so the output
			// sequence is deterministic before the final path sort.
			const resolvedChildren = children
				.filter((child) => !isIgnoredName(child.name))
				.map((child) => {
					const childFull = join(current, child.name);
					return { childFull, name: child.name, resolved: this.listableStat(canonicalRoot, childFull) };
				})
				.filter((child): child is { childFull: string; name: string; resolved: { stats: Stats; real: string } } => child.resolved !== null)
				.sort((a, b) => Number(b.resolved.stats.isDirectory()) - Number(a.resolved.stats.isDirectory())
					|| a.name.localeCompare(b.name, "zh-CN"));
			for (const child of resolvedChildren) {
				if (collected.length >= maxEntries) { overflow = true; return; }
				collected.push(this.entry(root, child.childFull, child.resolved.stats));
				if (child.resolved.stats.isDirectory() && !ancestors.has(child.resolved.real)) {
					visit(child.childFull, new Set([...ancestors, child.resolved.real]));
				}
				if (overflow) return;
			}
		};
		visit(full, rootAncestors);
		if (overflow) fail("limit_exceeded", `walk exceeds ${maxEntries} entries under ${target || "/"}`);
		for (const entry of collected.sort((a, b) => a.path.localeCompare(b.path))) yield entry;
	}

	async deleteAll(workspaceId: string): Promise<void> {
		const root = this.root(workspaceId);
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
	}
}
