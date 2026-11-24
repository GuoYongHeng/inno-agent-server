import type { DurableHttpContext } from "../durable-routes.js";
import { execFile, spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { streamRegistry } from "../../chat/stream-registry.js";
import { logger } from "../../logger.js";
import type { RuntimePaths } from "../../runtime.js";
import { ensureDir } from "../../storage/file-store.js";
import { isWithin } from "../../utils/path-safety.js";
import { TEMP_WORKSPACE_ID, type WorkspaceMeta, type WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import type { TenantStore } from "../../tenants/store.js";
import { claimRequestResource, getRequestTenant, ownsRequestResource, releaseRequestResource } from "../../tenants/http.js";
import { resolveRequestWorkspace, resolveRequestWorkspaceForRead } from "../../tenants/workspaces.js";
import type { WorkspaceReplica } from "../../workspace/workspace-replica.js";
import { LocalFsWorkspaceStore } from "../../workspace/local-fs-workspace-store.js";
import {
	normalizeWorkspacePath,
	WorkspaceStoreError,
	type WorkspaceStore,
} from "../../workspace/workspace-store.js";
import {
	canonicalTreeRoot,
	contentDispositionAttachment,
	contentTypeForWorkspaceFile,
	officeFormat,
	safeJoinReal,
	workspaceFileKind,
	normalizeWorkspaceRelativePath,
	WORKSPACE_IGNORES,
	WORKSPACE_TREE_MAX_DEPTH,
	type WorkspaceTreeNode,
} from "../file-helpers.js";
import {
	buildWorkspaceSwitchPreview,
	isSwitchableWorkspace,
	transferWorkspaceFiles,
	workspaceSwitchStatistics,
	type WorkspaceSwitchFileAction,
} from "../workspace-switch.js";
import { decodeRouteParam, json, matchRoute, readBody } from "../http-helpers.js";

/**
 * Server-owned dependencies the workspace routes touch. `workspaceRegistry`
 * is the live singleton; the skill installers close over server module state
 * (skillsDir default), so they are injected rather than imported.
 */
export interface WorkspacesRouteContext {
	workspaceRegistry: WorkspaceRegistry;
	dataDir: string;
	paths: RuntimePaths;
	tenantStore?: TenantStore | null;
	installSkillZip: (fileName: string, data: Buffer, targetRoot?: string) => { name: string; filePath: string };
	installSkillMarkdown: (fileName: string, data: Buffer, targetRoot?: string) => { name: string; filePath: string };
	importWorkspaceZip: (fileName: string, data: Buffer, name?: string) => WorkspaceMeta;
	scheduleSkillsReload: () => void;
	durableSessions: DurableHttpContext["service"];
	workspaceReplica?: WorkspaceReplica | null;
	/**
	 * server.ts resolves the per-request WorkspaceStore: object-store backed in
	 * authenticated mode, local fs otherwise. Absent in tests → local fs.
	 */
	workspaceStoreFor?: (req: HttpReq) => WorkspaceStore;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split)
// ---------------------------------------------------------------------------

function workspaceIdFromQuery(url: string): string {
	try {
		const params = new URL(url, "http://localhost").searchParams;
		const id = params.get("workspaceId");
		return id && id.trim() ? id.trim() : TEMP_WORKSPACE_ID;
	} catch (err) {
		return TEMP_WORKSPACE_ID;
	}
}

function workspaceIdFromBody(body: Record<string, unknown>): string {
	const id = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
	return id || TEMP_WORKSPACE_ID;
}

/** Per-workspace private skills directory (same location agent/workspace-context.ts reads). */
const WORKSPACE_PRIVATE_SKILLS_DIR = ".skills";

function workspaceRelativePath(rootDir: string, filePath: string): string {
	return relative(rootDir, filePath) || "";
}

/** Build a tree node for an installed private skill directory under `<root>/.skills`. */
function workspaceSkillNode(root: string, skillName: string): { name: string; path: string; type: string; size: number; updatedAt: string } {
	const dir = join(root, WORKSPACE_PRIVATE_SKILLS_DIR, skillName);
	const stat = statSync(dir);
	return {
		name: skillName,
		path: workspaceRelativePath(root, dir),
		type: "directory",
		size: stat.size,
		updatedAt: stat.mtime.toISOString(),
	};
}

// Deep enough to cover nested output conventions (e.g. skill runs that nest
// <skill>/<slug>/<timestamp>/<artifact>/<file>), while still bounded so a
// pathological tree cannot hang the request.
// Exported for the store-parity test: the reference local-fs implementation.
export function readWorkspaceTree(rootDir: string, dir: string, depth = 0, seen: ReadonlySet<string> = new Set()): WorkspaceTreeNode[] {
	if (depth > WORKSPACE_TREE_MAX_DEPTH) return [];
	const realRoot = canonicalTreeRoot(rootDir);
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => !WORKSPACE_IGNORES.has(entry.name))
		.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
		.slice(0, 200)
		.map((entry): WorkspaceTreeNode | null => {
			const fullPath = join(dir, entry.name);
			// statSync follows symlinks, so a directory symlink (e.g. a `latest`
			// pointer) resolves to its target type. A broken symlink throws here
			// and is skipped instead of crashing the whole tree with a 500.
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(fullPath);
			} catch {
				return null;
			}
			const isDir = stat.isDirectory();
			const node: WorkspaceTreeNode = {
				name: entry.name,
				path: workspaceRelativePath(rootDir, fullPath),
				type: isDir ? "directory" : "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			};
			if (isDir) {
				// Resolve the real path to (a) keep symlink traversal inside the
				// workspace root and (b) guard against symlink cycles.
				let real: string;
				try {
					real = realpathSync(fullPath);
				} catch {
					real = fullPath;
				}
				const withinRoot = isWithin(realRoot, real);
				node.children = withinRoot && !seen.has(real)
					? readWorkspaceTree(rootDir, fullPath, depth + 1, new Set([...seen, real]))
					: [];
			}
			return node;
		})
		.filter((node): node is WorkspaceTreeNode => node !== null);
}

/**
 * Build the `/api/workspace/tree` children from ONE `store.walk("")` pass —
 * identical shape to `readWorkspaceTree`: directories first in zh-CN order,
 * 200 entries per directory, `WORKSPACE_TREE_MAX_DEPTH` depth cap, ignored
 * names already omitted by walk. Works for both stores; the manifest store
 * yields implied directories explicitly so empty folders appear.
 * Known difference vs the legacy reader: a symlink escaping the workspace
 * root was listed as a childless node by `readWorkspaceTree` but is hidden by
 * the store (same rule as `list`); directory `size` is 0 rather than the
 * filesystem's own directory size.
 */
export async function workspaceTreeFromStore(store: WorkspaceStore, wsId: string): Promise<WorkspaceTreeNode[]> {
	const dirChildren = new Map<string, Map<string, WorkspaceTreeNode>>();
	const childrenOf = (dir: string): Map<string, WorkspaceTreeNode> => {
		let children = dirChildren.get(dir);
		if (!children) { children = new Map(); dirChildren.set(dir, children); }
		return children;
	};
	childrenOf("");
	for await (const entry of store.walk(wsId, "")) {
		const segments = entry.path.split("/");
		if (segments.length - 1 > WORKSPACE_TREE_MAX_DEPTH) continue;
		const node: WorkspaceTreeNode = {
			name: entry.name,
			path: entry.path,
			type: entry.kind,
			size: entry.size,
			updatedAt: new Date(entry.mtimeMs).toISOString(),
		};
		childrenOf(segments.slice(0, -1).join("/")).set(entry.name, node);
		if (entry.kind === "directory" && segments.length <= WORKSPACE_TREE_MAX_DEPTH) {
			childrenOf(entry.path);
		}
	}
	const build = (dir: string): WorkspaceTreeNode[] => {
		return [...(dirChildren.get(dir)?.values() ?? [])]
			.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory")
				|| a.name.localeCompare(b.name, "zh-CN"))
			.slice(0, 200)
			.map((node) => node.type === "directory" ? { ...node, children: build(node.path) } : node);
	};
	return build("");
}

/**
 * Map a WorkspaceStoreError onto the status the legacy filesystem code
 * produced for the same request shape (bad/missing paths were all 404).
 */
function workspaceReadStatus(error: unknown): number | null {
	if (!(error instanceof WorkspaceStoreError)) return null;
	if (error.code === "too_large") return 413;
	if (error.code === "limit_exceeded") return 500;
	return 404;
}

/**
 * A real local path for tools that need one (document parser, pptx
 * converter). LocalFs resolves the existing file; other stores materialize
 * the bytes into a fresh temp dir that the caller must `cleanup()`.
 */
async function materializeWorkspaceFile(
	store: WorkspaceStore,
	wsId: string,
	relPath: string,
	localPath: (wsId: string, rel: string) => string | null,
): Promise<{ filePath: string; cleanup: () => void } | null> {
	if (store instanceof LocalFsWorkspaceStore) {
		const filePath = localPath(wsId, relPath);
		if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return null;
		return { filePath, cleanup: () => undefined };
	}
	const read = await store.read(wsId, relPath);
	if (!read) return null;
	const dir = join(tmpdir(), `inno-wsread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, basename(relPath));
	writeFileSync(filePath, read.body);
	return { filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Zip a directory and return the archive as a Buffer.
 *
 * Uses the system `zip` on macOS/Linux and PowerShell `Compress-Archive` on
 * Windows so we avoid pulling in a new dependency. The archive is built in a
 * temp dir and read back into memory (workspace folders are expected to be
 * small enough for an in-memory download).
 */
function zipDirectory(dirPath: string): Buffer {
	const tempRoot = join(tmpdir(), `inno-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, "archive.zip");
	ensureDir(tempRoot);
	try {
		if (process.platform === "win32") {
			const ps = `Compress-Archive -Path '${dirPath.replace(/'/g, "''")}\\*' ` +
				`-DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
			const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to create zip archive");
			}
		} else {
			// `-r` recurse, run inside the dir so paths are relative to it.
			// `-y` stores symlinks as links: without it zip dereferences them,
			// so a symlink planted inside the workspace would leak the linked
			// host files into the archive.
			const result = spawnSync("/usr/bin/zip", ["-r", "-y", "-q", zipPath, "."], { cwd: dirPath, encoding: "utf-8" });
			if (result.status !== 0) {
				throw new Error((result.stderr || "").trim() || "Unable to create zip archive");
			}
		}
		return readFileSync(zipPath);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

// --- PPTX → SVG conversion (pure-Python converter, no LibreOffice) ---
const PPTX_TIMEOUT_MS = 60_000;
const MAX_PPTX_SLIDES = 200;
const MAX_PPTX_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);
let cachedPythonExe: string | null | undefined;

/** Absolute path to the vendored pptx_to_svg CLI. */
function pptxScriptPath(codeDir: string): string {
	return join(codeDir, "scripts", "pptx_to_svg.py");
}

/** Resolve a usable Python executable, caching the result. */
function resolvePythonExecutable(): string | null {
	if (cachedPythonExe !== undefined) return cachedPythonExe;
	const candidates: string[] = [];
	const override = process.env.INNO_PYTHON?.trim();
	if (override) candidates.push(override);
	// On Windows the launcher is usually `python`; elsewhere prefer `python3`.
	if (process.platform === "win32") candidates.push("python", "python3");
	else candidates.push("python3", "python");
	for (const candidate of candidates) {
		try {
			const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
			if (!probe.error && probe.status === 0) {
				cachedPythonExe = candidate;
				return candidate;
			}
		} catch {
			// try next candidate
		}
	}
	cachedPythonExe = null;
	return null;
}

interface PptxSvgSlide {
	index: number;
	svg: string;
}

interface PptxConvertResult {
	slides: PptxSvgSlide[];
	canvasPx?: [number, number];
}

/**
 * Convert a .pptx to per-slide SVG strings via the vendored Python converter.
 * Runs asynchronously (never blocks the HTTP loop) and always cleans up its
 * temp directory. Throws on failure so the caller can return a 422 fallback.
 */
async function convertPptxToSvg(codeDir: string, filePath: string): Promise<PptxConvertResult> {
	const python = resolvePythonExecutable();
	if (!python) {
		throw new Error("Python is not available; set INNO_PYTHON or install python3");
	}
	const script = pptxScriptPath(codeDir);
	if (!existsSync(script)) {
		throw new Error(`pptx converter not found at ${script}`);
	}
	const outDir = join(tmpdir(), `inno-pptx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	ensureDir(outDir);
	try {
		const { stdout } = await execFileAsync(
			python,
			[script, filePath, "--embed-images", "--inheritance-mode", "flat", "-o", outDir],
			{ timeout: PPTX_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
		);
		const svgDir = join(outDir, "svg");
		if (!existsSync(svgDir)) {
			throw new Error("converter produced no output");
		}
		const files = readdirSync(svgDir)
			.filter((f) => /^slide_\d+\.svg$/i.test(f))
			.sort((a, b) => {
				const na = Number(a.match(/\d+/)?.[0] ?? 0);
				const nb = Number(b.match(/\d+/)?.[0] ?? 0);
				return na - nb;
			});
		const slides: PptxSvgSlide[] = [];
		for (const file of files.slice(0, MAX_PPTX_SLIDES)) {
			const index = Number(file.match(/\d+/)?.[0] ?? slides.length + 1);
			slides.push({ index, svg: readFileSync(join(svgDir, file), "utf-8") });
		}
		if (slides.length === 0) {
			throw new Error("converter produced no slides");
		}
		let canvasPx: [number, number] | undefined;
		const match = /Canvas:\s*([\d.]+)\s*x\s*([\d.]+)\s*px/i.exec(stdout);
		if (match) canvasPx = [Number(match[1]), Number(match[2])];
		return { slides, canvasPx };
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

/**
 * /api/workspace/*, /api/workspaces* and /api/sessions/:id/workspace route
 * domain. Returns true when the request was handled. Extracted verbatim from
 * server.ts during the P2 route split — behavior unchanged. (The workspaces
 * registry and session-binding routes previously lived ~400 lines below the
 * file routes; exact-path matching makes the reordering inert.)
 */
export async function handleWorkspacesRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: WorkspacesRouteContext,
): Promise<boolean> {
	const {
		workspaceRegistry,
		dataDir,
		paths,
		installSkillZip,
		installSkillMarkdown,
		importWorkspaceZip,
		scheduleSkillsReload,
		durableSessions,
		tenantStore,
	} = ctx;

	const resolveWorkspace = (workspaceId?: string | null) =>
		resolveRequestWorkspace(req, workspaceRegistry, tenantStore, workspaceId, ctx.workspaceReplica);
	const replica = ctx.workspaceReplica ?? null;
	const requestTenant = getRequestTenant(req);
	/** Upload a workspace's file mirror after a route mutation (authenticated mode). */
	const pushReplica = async (workspaceId: string) => {
		if (!replica || !requestTenant) return;
		const dir = workspaceRegistry.resolveWorkspaceDir(workspaceId);
		if (dir) await replica.push(requestTenant, workspaceId, dir);
	};
	const ownsWorkspace = (workspaceId: string) =>
		ownsRequestResource(req, tenantStore, "workspace", workspaceId);
	const ownsSession = (sessionId: string) =>
		ownsRequestResource(req, tenantStore, "session", sessionId);

	// Guard registry subresources before reading metadata or touching the filesystem.
	const workspaceResourceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(url.split("?", 1)[0]);
	if (workspaceResourceMatch && (method === "PATCH" || method === "DELETE")) {
		if (!await ownsWorkspace(decodeRouteParam(workspaceResourceMatch[1]))) {
			json(res, 404, { error: "Workspace not found" });
			return true;
		}
	}
	const boundSessionMatch = /^\/api\/sessions\/([^/]+)\/workspace(?:\/|$)/.exec(url.split("?", 1)[0]);
	if (boundSessionMatch && !await ownsSession(decodeRouteParam(boundSessionMatch[1]))) {
		json(res, 404, { error: "Session not found" });
		return true;
	}

	// Per-request workspace store: object store + manifest for tenants, the
	// local directory otherwise. Read routes below never touch the worker's
	// disk in authenticated mode.
	const store = ctx.workspaceStoreFor?.(req)
		?? new LocalFsWorkspaceStore({ resolveRoot: (id) => workspaceRegistry.resolveWorkspaceDir(id) });
	let readWorkspaceMeta: { id: string; name: string } | null = null;

	// Read-only file routes carry workspaceId in the query. Resolve tmp once and
	// rewrite the local URL so every downstream helper uses the private id.
	// The manifest-backed store reads without materializing; the local fallback
	// must materialize/pull first because the worker's disk is its source of
	// truth (a takeover worker's dir would otherwise read empty).
	if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/")) {
		const requested = new URL(url, "http://localhost");
		const resolved = store instanceof LocalFsWorkspaceStore
			? await resolveWorkspace(requested.searchParams.get("workspaceId"))
			: await resolveRequestWorkspaceForRead(
				req, workspaceRegistry, tenantStore, requested.searchParams.get("workspaceId"), ctx.workspaceReplica,
			);
		readWorkspaceMeta = resolved ? { id: resolved.id, name: resolved.name } : null;
		if (!readWorkspaceMeta) { json(res, 404, { error: "Workspace not found" }); return true; }
		requested.searchParams.set("workspaceId", readWorkspaceMeta.id);
		url = `${requested.pathname}${requested.search}`;
	}

	// safeWorkspacePath closed over server.ts's module-level workspaceRegistry;
	// rebind it to the injected registry here so the route bodies stay verbatim.
	// safeJoinReal (not plain safeJoin): a symlink planted inside the workspace
	// must not let these endpoints read/write files outside it.
	const safeWorkspacePath = (workspaceId: string | null | undefined, userPath: string): string | null => {
		const root = workspaceRegistry.resolveWorkspaceDir(workspaceId ?? TEMP_WORKSPACE_ID);
		if (!root) return null;
		const normalizedPath = normalizeWorkspaceRelativePath(userPath);
		// A workspace path may have a harmless `./` prefix, but a leading `/`
		// (or a Windows drive prefix) is an absolute path and must not be turned
		// into a relative path by the API boundary.
		if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) return null;
		return safeJoinReal(root, normalizedPath);
	};

	// --- Object-store write path (T1.4) -------------------------------------
	// With a manifest-backed store, mutations write bytes + rows directly and
	// then mirror into the worker's local copy (when one exists), so running
	// sessions and persistent-mode tools see the change immediately while the
	// manifest stays the source of truth. Resolution never materializes files.
	const storeBacked = !(store instanceof LocalFsWorkspaceStore);
	const resolveWriteWorkspace = (workspaceId?: string | null) => storeBacked
		? resolveRequestWorkspaceForRead(req, workspaceRegistry, tenantStore, workspaceId ?? null, ctx.workspaceReplica)
		: resolveWorkspace(workspaceId);
	const storeStatus = (error: unknown): number =>
		error instanceof WorkspaceStoreError
			? error.code === "not_found" ? 404
				: error.code === "exists" ? 409
				: error.code === "too_large" ? 413
				: 400
			: 500;
	const mirrorWrite = (wsId: string, rel: string, data: Uint8Array | string) => {
		const target = safeWorkspacePath(wsId, rel);
		if (!target) return;
		ensureDir(dirname(target));
		writeFileSync(target, data);
	};
	const mirrorMkdir = (wsId: string, rel: string) => {
		const target = safeWorkspacePath(wsId, rel);
		if (target) mkdirSync(target, { recursive: true });
	};
	const mirrorRemove = (wsId: string, rel: string) => {
		const target = safeWorkspacePath(wsId, rel);
		if (target && existsSync(target)) rmSync(target, { recursive: true, force: true });
	};
	const mirrorMove = (wsId: string, from: string, to: string) => {
		const src = safeWorkspacePath(wsId, from);
		const dst = safeWorkspacePath(wsId, to);
		if (!src || !dst || !existsSync(src) || existsSync(dst)) return;
		ensureDir(dirname(dst));
		renameSync(src, dst);
	};
	/** Install a skill package into a temp dir, sync `<ws>/.skills/<name>` into
	 * the store, then mirror the install into the local copy when one exists. */
	const installWorkspaceSkill = async (wsId: string, fileName: string, data: Buffer) => {
		const ext = extname(fileName).toLowerCase();
		const skillsRoot = mkdtempSync(join(tmpdir(), "inno-skill-install-"));
		try {
			const skill = ext === ".zip"
				? installSkillZip(fileName, data, skillsRoot)
				: installSkillMarkdown(fileName, data, skillsRoot);
			const skillDir = join(skillsRoot, skill.name);
			const storeRel = `${WORKSPACE_PRIVATE_SKILLS_DIR}/${skill.name}`;
			if (storeBacked) {
				await store.remove(wsId, storeRel, { recursive: true }).catch((error) => {
					if (!(error instanceof WorkspaceStoreError && error.code === "not_found")) throw error;
				});
				const copyTree = async (dir: string, rel: string): Promise<void> => {
					await store.mkdir(wsId, rel);
					for (const child of readdirSync(dir, { withFileTypes: true })) {
						if (child.isDirectory()) await copyTree(join(dir, child.name), `${rel}/${child.name}`);
						else await store.write(wsId, `${rel}/${child.name}`, new Uint8Array(readFileSync(join(dir, child.name))));
					}
				};
				await copyTree(skillDir, storeRel);
			}
			const localSkillsRoot = safeWorkspacePath(wsId, WORKSPACE_PRIVATE_SKILLS_DIR);
			if (localSkillsRoot) {
				if (ext === ".zip") installSkillZip(fileName, data, localSkillsRoot);
				else installSkillMarkdown(fileName, data, localSkillsRoot);
			}
			const stat = statSync(skillDir);
			return {
				name: skill.name,
				path: storeRel,
				type: "directory" as const,
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			};
		} finally {
			rmSync(skillsRoot, { recursive: true, force: true });
		}
	};

	const switchableSession = async (sessionId: string): Promise<{ hasHistory: boolean } | null> => {
		const session = await durableSessions.get(req, sessionId);
		if (!session) {
			json(res, 404, { error: "Session not found" });
			return null;
		}
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Cannot rebind a session with an active chat turn" });
			return null;
		}
		return { hasHistory: session.messageCount > 0 };
	};
	const isAvailableSwitchTarget = (workspaceId: string): boolean => {
		if (isSwitchableWorkspace(workspaceRegistry.getWorkspace(workspaceId))) return true;
		json(res, 404, { error: "Target workspace not found or unavailable" });
		return false;
	};
	const resolveSessionWorkspace = async (sessionId: string): Promise<WorkspaceMeta | null> => {
		const currentId = workspaceRegistry.getSessionWorkspaceId(sessionId);
		const workspace = await resolveWorkspace(currentId);
		if (workspace && workspace.id !== currentId) {
			workspaceRegistry.bindSession(sessionId, workspace.id);
			if (replica && requestTenant) await replica.setSessionBinding(requestTenant, sessionId, workspace.id);
		}
		return workspace;
	};

	// --- Workspace API ---
	if (method === "GET" && url.split("?")[0] === "/api/workspace/tree") {
		const wsId = workspaceIdFromQuery(url);
		let root = "";
		let name = readWorkspaceMeta?.name ?? wsId;
		let size = 0;
		let updatedAt = new Date(0).toISOString();
		if (store instanceof LocalFsWorkspaceStore) {
			const dir = workspaceRegistry.resolveWorkspaceDir(wsId);
			if (!dir) { json(res, 404, { error: "Workspace not found" }); return true; }
			ensureDir(dir);
			const stat = statSync(dir);
			root = dir;
			name = basename(dir);
			size = stat.size;
			updatedAt = stat.mtime.toISOString();
		} else {
			const rootStat = await store.stat(wsId, "");
			if (rootStat) updatedAt = new Date(rootStat.mtimeMs).toISOString();
		}
		let children: WorkspaceTreeNode[];
		try {
			children = await workspaceTreeFromStore(store, wsId);
		} catch (error) {
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: error instanceof Error ? error.message : "Workspace not found" });
			return true;
		}
		json(res, 200, {
			root,
			workspaceId: wsId,
			name,
			path: "",
			type: "directory",
			size,
			updatedAt,
			children,
		});
		return true;
	}

	if (method === "GET" && url.startsWith("/api/workspace/file?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		let relPath: string;
		let entry;
		try {
			relPath = normalizeWorkspacePath(requestedPath);
			entry = await store.stat(wsId, relPath);
		} catch (error) {
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: "Workspace file not found" });
			return true;
		}
		if (!entry || entry.kind !== "file") {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		const kind = workspaceFileKind(relPath);
		const contentType = contentTypeForWorkspaceFile(relPath);
		const updatedAt = new Date(entry.mtimeMs).toISOString();
		const forceText = params.get("forceText") === "1";
		if (!forceText && (kind === "binary" || kind === "pdf" || kind === "image" || kind === "office")) {
			const rawUrl = `/api/workspace/raw?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(relPath)}`;
			const format = kind === "office" ? officeFormat(relPath) : undefined;
			// pptx is rendered as SVG via the Python converter; docx/xlsx are
			// rendered client-side from the raw bytes, so they need no previewUrl.
			const previewUrl = format === "pptx"
				? `/api/workspace/pptx-preview?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(relPath)}`
				: undefined;
			json(res, 200, {
				path: relPath,
				name: basename(relPath),
				kind,
				format,
				mimeType: contentType,
				size: entry.size,
				updatedAt,
				url: rawUrl,
				previewUrl,
			});
			return true;
		}
		if (entry.size > 1024 * 1024) {
			json(res, 413, { error: "File is too large to preview as text" });
			return true;
		}
		let body: Uint8Array;
		try {
			const read = await store.read(wsId, relPath);
			if (!read) { json(res, 404, { error: "Workspace file not found" }); return true; }
			body = read.body;
		} catch (error) {
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: "Workspace file not found" });
			return true;
		}
		json(res, 200, {
			path: relPath,
			name: basename(relPath),
			kind: forceText ? "text" : kind,
			mimeType: forceText ? "text/plain; charset=utf-8" : contentType,
			size: entry.size,
			updatedAt,
			content: Buffer.from(body).toString("utf-8"),
		});
		return true;
	}

	if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/raw?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wantsDownload = params.get("download") === "1";
		const wsId = workspaceIdFromQuery(url);
		let relPath: string;
		let read;
		try {
			relPath = normalizeWorkspacePath(requestedPath);
			read = await store.read(wsId, relPath);
		} catch (error) {
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: "Workspace file not found" });
			return true;
		}
		if (!read || read.entry.kind !== "file") {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		const headers: Record<string, string | number> = {
			"Content-Type": contentTypeForWorkspaceFile(relPath),
			"Content-Length": read.body.length,
			"Cache-Control": "no-store",
		};
		if (wantsDownload) {
			headers["Content-Disposition"] = contentDispositionAttachment(basename(relPath));
		}
		res.writeHead(200, headers);
		res.end(method === "GET" ? Buffer.from(read.body) : undefined);
		return true;
	}

	// Download a directory as a zip archive.
	if ((method === "GET" || method === "HEAD") && url.startsWith("/api/workspace/download-folder?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		let relPath: string;
		let zipSource: string;
		let cleanup: (() => void) | null = null;
		try {
			relPath = normalizeWorkspacePath(requestedPath);
			const entry = await store.stat(wsId, relPath);
			if (!entry || entry.kind !== "directory") {
				json(res, 404, { error: "Workspace folder not found" });
				return true;
			}
			if (store instanceof LocalFsWorkspaceStore) {
				// Empty path → zip the whole workspace root (symlink-safe `zip -y`).
				const root = workspaceRegistry.resolveWorkspaceDir(wsId);
				const dirPath = requestedPath ? safeWorkspacePath(wsId, requestedPath) : root;
				if (!dirPath || !existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
					json(res, 404, { error: "Workspace folder not found" });
					return true;
				}
				zipSource = dirPath;
			} else {
				// Object store: materialize the subtree into a temp dir, preserving
				// paths relative to the requested directory.
				const staging = join(tmpdir(), `inno-wszip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
				mkdirSync(staging, { recursive: true });
				cleanup = () => rmSync(staging, { recursive: true, force: true });
				const prefix = relPath === "" ? "" : `${relPath}/`;
				for await (const item of store.walk(wsId, relPath)) {
					const rel = item.path.slice(prefix.length);
					const target = join(staging, ...rel.split("/"));
					if (item.kind === "directory") {
						mkdirSync(target, { recursive: true });
						continue;
					}
					const read = await store.read(wsId, item.path);
					if (!read) continue;
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, read.body);
				}
				zipSource = staging;
			}
		} catch (error) {
			cleanup?.();
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: "Workspace folder not found" });
			return true;
		}
		const archiveName = `${basename(relPath) || basename(zipSource) || readWorkspaceMeta?.name || "workspace"}.zip`;
		if (method === "HEAD") {
			cleanup?.();
			res.writeHead(200, {
				"Content-Type": "application/zip",
				"Content-Disposition": contentDispositionAttachment(archiveName),
				"Cache-Control": "no-store",
			});
			res.end();
			return true;
		}
		try {
			const zipData = zipDirectory(zipSource);
			res.writeHead(200, {
				"Content-Type": "application/zip",
				"Content-Length": zipData.length,
				"Content-Disposition": contentDispositionAttachment(archiveName),
				"Cache-Control": "no-store",
			});
			res.end(zipData);
		} catch (err) {
			logger.error({ err }, "failed to create zip archive");
			json(res, 500, { error: err instanceof Error ? err.message : "Failed to create zip archive" });
		} finally {
			cleanup?.();
		}
		return true;
	}

	// Extract text from office documents (docx/xlsx/pptx) for in-browser preview.
	if (method === "GET" && url.startsWith("/api/workspace/office-preview?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		let relPath: string;
		let materialized: { filePath: string; cleanup: () => void } | null = null;
		try {
			relPath = normalizeWorkspacePath(requestedPath);
			materialized = await materializeWorkspaceFile(
				store, wsId, relPath,
				(id, rel) => safeWorkspacePath(id, rel),
			);
		} catch (error) {
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: "Workspace file not found" });
			return true;
		}
		if (!materialized) {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		try {
			const { parseDocument } = await import("../../memory/l2/document-parser.js");
			const parsed = await parseDocument(materialized.filePath);
			json(res, 200, {
				name: basename(relPath),
				pageCount: parsed.pageCount,
				text: parsed.text,
				pages: parsed.pages,
			});
		} catch (err) {
			logger.warn({ err }, "failed to parse office document");
			json(res, 422, { error: err instanceof Error ? err.message : "Failed to parse document" });
		} finally {
			materialized.cleanup();
		}
		return true;
	}

	// Render a .pptx as per-slide SVG via the vendored Python converter.
	if (method === "GET" && url.startsWith("/api/workspace/pptx-preview?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const requestedPath = params.get("path") ?? "";
		const wsId = workspaceIdFromQuery(url);
		let relPath: string;
		let entry;
		try {
			relPath = normalizeWorkspacePath(requestedPath);
			entry = await store.stat(wsId, relPath);
		} catch (error) {
			const status = workspaceReadStatus(error);
			json(res, status ?? 500, { error: "Workspace file not found" });
			return true;
		}
		if (!entry || entry.kind !== "file") {
			json(res, 404, { error: "Workspace file not found" });
			return true;
		}
		if (entry.size > MAX_PPTX_BYTES) {
			json(res, 413, { error: "Presentation is too large to preview" });
			return true;
		}
		let materialized: { filePath: string; cleanup: () => void } | null = null;
		try {
			materialized = await materializeWorkspaceFile(
				store, wsId, relPath,
				(id, rel) => safeWorkspacePath(id, rel),
			);
			if (!materialized) {
				json(res, 404, { error: "Workspace file not found" });
				return true;
			}
			const result = await convertPptxToSvg(paths.codeDir, materialized.filePath);
			json(res, 200, {
				name: basename(relPath),
				slideCount: result.slides.length,
				slides: result.slides,
				canvasPx: result.canvasPx,
			});
		} catch (err) {
			logger.warn({ err }, "failed to convert pptx to svg");
			json(res, 422, {
				error: err instanceof Error ? err.message : "Failed to render presentation",
				code: "PPTX_CONVERT_FAILED",
			});
		} finally {
			materialized?.cleanup();
		}
		return true;
	}

	// --- Workspace Mutations API ---

	if (method === "PUT" && url === "/api/workspace/file") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const filePath = typeof body.path === "string" ? body.path.trim() : "";
		const content = typeof body.content === "string" ? body.content : "";
		if (!filePath) { json(res, 400, { error: "Missing path" }); return true; }
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			try {
				const rel = normalizeWorkspacePath(filePath);
				const existing = await store.stat(wsId, rel);
				if (!existing || existing.kind !== "file") { json(res, 404, { error: "File not found" }); return true; }
				const bytes = new TextEncoder().encode(content);
				const entry = await store.write(wsId, rel, bytes);
				mirrorWrite(wsId, rel, bytes);
				json(res, 200, { path: filePath, saved: true, size: entry.size, updatedAt: new Date(entry.mtimeMs).toISOString() });
			} catch (error) {
				json(res, storeStatus(error), { error: error instanceof Error ? error.message : String(error) });
			}
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const fullPath = safeWorkspacePath(wsId, filePath);
		if (!fullPath) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" }); return true;
		}
		writeFileSync(fullPath, content, "utf-8");
		const stat = statSync(fullPath);
				await pushReplica(wsId);
		json(res, 200, { path: filePath, saved: true, size: stat.size, updatedAt: stat.mtime.toISOString() });
		return true;
	}

	if (method === "POST" && url === "/api/workspace/create") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const itemPath = typeof body.path === "string" ? body.path.trim() : "";
		const itemType = body.type === "directory" ? "directory" : "file";
		if (!itemPath) { json(res, 400, { error: "Missing path" }); return true; }
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			try {
				const rel = normalizeWorkspacePath(itemPath);
				if (await store.stat(wsId, rel)) { json(res, 409, { error: "Already exists" }); return true; }
				const entry = itemType === "directory"
					? await store.mkdir(wsId, rel)
					: await store.write(wsId, rel, new Uint8Array());
				if (itemType === "directory") mirrorMkdir(wsId, rel);
				else mirrorWrite(wsId, rel, new Uint8Array());
				json(res, 201, {
					name: entry.name, path: rel, type: itemType, size: entry.size,
					updatedAt: new Date(entry.mtimeMs).toISOString(),
				});
			} catch (error) {
				json(res, storeStatus(error), { error: error instanceof Error ? error.message : String(error) });
			}
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const fullPath = safeWorkspacePath(wsId, itemPath);
		if (!fullPath) { json(res, 400, { error: "Invalid path" }); return true; }
		if (existsSync(fullPath)) { json(res, 409, { error: "Already exists" }); return true; }
		if (itemType === "directory") {
			mkdirSync(fullPath, { recursive: true });
		} else {
			ensureDir(dirname(fullPath));
			writeFileSync(fullPath, "");
		}
		const stat = statSync(fullPath);
				await pushReplica(wsId);
		json(res, 201, {
			name: basename(fullPath),
			path: workspaceRelativePath(root, fullPath),
			type: itemType,
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
		return true;
	}

	if (method === "POST" && url === "/api/workspace/rename") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const oldPath = typeof body.oldPath === "string" ? body.oldPath.trim() : "";
		const newPath = typeof body.newPath === "string" ? body.newPath.trim() : "";
		if (!oldPath || !newPath) { json(res, 400, { error: "Missing oldPath or newPath" }); return true; }
		if (oldPath === newPath) { json(res, 400, { error: "Paths are identical" }); return true; }
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			try {
				const relOld = normalizeWorkspacePath(oldPath);
				const relNew = normalizeWorkspacePath(newPath);
				if (relOld === relNew) { json(res, 400, { error: "Paths are identical" }); return true; }
				if (!await store.stat(wsId, relOld)) { json(res, 404, { error: "Source not found" }); return true; }
				if (await store.stat(wsId, relNew)) { json(res, 409, { error: "Target already exists" }); return true; }
				await store.move(wsId, relOld, relNew);
				mirrorMove(wsId, relOld, relNew);
				const entry = await store.stat(wsId, relNew);
				json(res, 200, {
					name: entry?.name ?? basename(relNew), path: relNew,
					type: entry?.kind === "directory" ? "directory" : "file",
					size: entry?.size ?? 0,
					updatedAt: entry ? new Date(entry.mtimeMs).toISOString() : new Date().toISOString(),
				});
			} catch (error) {
				json(res, storeStatus(error), { error: error instanceof Error ? error.message : String(error) });
			}
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const fullOld = safeWorkspacePath(wsId, oldPath);
		const fullNew = safeWorkspacePath(wsId, newPath);
		if (!fullOld || !fullNew) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullOld)) { json(res, 404, { error: "Source not found" }); return true; }
		if (existsSync(fullNew)) { json(res, 409, { error: "Target already exists" }); return true; }
		ensureDir(dirname(fullNew));
		renameSync(fullOld, fullNew);
		const stat = statSync(fullNew);
				await pushReplica(wsId);
		json(res, 200, {
			name: basename(fullNew),
			path: workspaceRelativePath(root, fullNew),
			type: stat.isDirectory() ? "directory" : "file",
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
		return true;
	}

	if (method === "POST" && url === "/api/workspace/delete") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const itemPath = typeof body.path === "string" ? body.path.trim() : "";
		if (!itemPath) { json(res, 400, { error: "Cannot delete workspace root" }); return true; }
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			try {
				const rel = normalizeWorkspacePath(itemPath);
				if (!await store.stat(wsId, rel)) { json(res, 404, { error: "Not found" }); return true; }
				await store.remove(wsId, rel, { recursive: true });
				mirrorRemove(wsId, rel);
				json(res, 200, { deleted: true, path: itemPath });
			} catch (error) {
				json(res, storeStatus(error), { error: error instanceof Error ? error.message : String(error) });
			}
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const fullPath = safeWorkspacePath(wsId, itemPath);
		if (!fullPath) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullPath)) { json(res, 404, { error: "Not found" }); return true; }
		rmSync(fullPath, { recursive: true, force: true });
				await pushReplica(wsId);
		json(res, 200, { deleted: true, path: itemPath });
		return true;
	}

	if (method === "POST" && url === "/api/workspace/move") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
		const targetDir = typeof body.targetDir === "string" ? body.targetDir.trim() : "";
		if (!sourcePath) { json(res, 400, { error: "Missing sourcePath" }); return true; }
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			try {
				const relSource = normalizeWorkspacePath(sourcePath);
				if (!await store.stat(wsId, relSource)) { json(res, 404, { error: "Source not found" }); return true; }
				const relDir = targetDir ? normalizeWorkspacePath(targetDir) : "";
				const relDest = relDir ? `${relDir}/${basename(relSource)}` : basename(relSource);
				if (await store.stat(wsId, relDest)) { json(res, 409, { error: "Target already exists" }); return true; }
				await store.move(wsId, relSource, relDest);
				mirrorMove(wsId, relSource, relDest);
				const entry = await store.stat(wsId, relDest);
				json(res, 200, {
					name: entry?.name ?? basename(relDest), path: relDest,
					type: entry?.kind === "directory" ? "directory" : "file",
					size: entry?.size ?? 0,
					updatedAt: entry ? new Date(entry.mtimeMs).toISOString() : new Date().toISOString(),
				});
			} catch (error) {
				json(res, storeStatus(error), { error: error instanceof Error ? error.message : String(error) });
			}
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		const fullSource = safeWorkspacePath(wsId, sourcePath);
		const fullTargetDir = targetDir ? safeWorkspacePath(wsId, targetDir) : root;
		if (!fullSource || !fullTargetDir) { json(res, 400, { error: "Invalid path" }); return true; }
		if (!existsSync(fullSource)) { json(res, 404, { error: "Source not found" }); return true; }
		const newFullPath = join(fullTargetDir, basename(fullSource));
		if (existsSync(newFullPath)) { json(res, 409, { error: "Target already exists" }); return true; }
		ensureDir(fullTargetDir);
		renameSync(fullSource, newFullPath);
		const stat = statSync(newFullPath);
				await pushReplica(wsId);
		json(res, 200, {
			name: basename(newFullPath),
			path: workspaceRelativePath(root, newFullPath),
			type: stat.isDirectory() ? "directory" : "file",
			size: stat.size,
			updatedAt: stat.mtime.toISOString(),
		});
		return true;
	}

	if (method === "POST" && url === "/api/workspace/upload") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const files = Array.isArray(body.files) ? body.files : [];
		if (!files.length) { json(res, 400, { error: "No files provided" }); return true; }
		const uploaded: Array<{ name: string; path: string; type: string; size: number; updatedAt: string }> = [];
		let installedSkill = false;
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			for (const entry of files) {
				const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
				const dataBase64 = typeof entry.dataBase64 === "string" ? entry.dataBase64 : "";
				if (!filePath || !dataBase64) continue;
				const data = Buffer.from(dataBase64, "base64");
				const ext = extname(filePath).toLowerCase();
				let rel: string;
				try {
					rel = normalizeWorkspacePath(filePath);
				} catch {
					continue; // same as the fs path: unusable names are skipped
				}
				if (filePath.split("/").includes(WORKSPACE_PRIVATE_SKILLS_DIR) && (ext === ".zip" || ext === ".md")) {
					try {
						uploaded.push(await installWorkspaceSkill(wsId, basename(filePath), data));
						installedSkill = true;
					} catch (err) {
						logger.error({ err }, "failed to install skill package during upload");
						json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
						return true;
					}
					continue;
				}
				try {
					const written = await store.write(wsId, rel, data);
					mirrorWrite(wsId, rel, data);
					uploaded.push({
						name: written.name, path: rel, type: "file", size: written.size,
						updatedAt: new Date(written.mtimeMs).toISOString(),
					});
				} catch (error) {
					json(res, storeStatus(error), { error: error instanceof Error ? error.message : String(error) });
					return true;
				}
			}
			if (installedSkill) scheduleSkillsReload();
			json(res, 201, { uploaded });
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		for (const entry of files) {
			const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
			const dataBase64 = typeof entry.dataBase64 === "string" ? entry.dataBase64 : "";
			if (!filePath || !dataBase64) continue;
			const fullPath = safeWorkspacePath(wsId, filePath);
			if (!fullPath) continue;
			const data = Buffer.from(dataBase64, "base64");
			const ext = extname(filePath).toLowerCase();

			// A .zip or .md dropped into the workspace's private skills dir is
			// installed as a skill (zip is extracted) rather than written raw.
			if (filePath.split("/").includes(WORKSPACE_PRIVATE_SKILLS_DIR) && (ext === ".zip" || ext === ".md")) {
				// The install target must really be `<root>/.skills` — a symlink
				// planted at `.skills` would make the installer delete/overwrite
				// a directory outside the workspace.
				const skillsRoot = safeWorkspacePath(wsId, WORKSPACE_PRIVATE_SKILLS_DIR);
				if (!skillsRoot) { json(res, 400, { error: "Invalid skills directory" }); return true; }
				try {
					const skill = ext === ".zip"
						? installSkillZip(basename(filePath), data, skillsRoot)
						: installSkillMarkdown(basename(filePath), data, skillsRoot);
					uploaded.push(workspaceSkillNode(root, skill.name));
					installedSkill = true;
					continue;
				} catch (err) {
					logger.error({ err }, "failed to install skill package during upload");
					json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
					return true;
				}
			}

			ensureDir(dirname(fullPath));
			writeFileSync(fullPath, data);
			const stat = statSync(fullPath);
			uploaded.push({
				name: basename(fullPath),
				path: workspaceRelativePath(root, fullPath),
				type: "file",
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
		}
		if (installedSkill) scheduleSkillsReload();
				await pushReplica(wsId);
		json(res, 201, { uploaded });
		return true;
	}

	// Install a skill package (.zip / .md) into the workspace's private .skills dir.
	if (method === "POST" && url === "/api/workspace/skills/upload") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWsId = workspaceIdFromBody(body);
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!fileName || !dataBase64) { json(res, 400, { error: "Missing fileName or dataBase64" }); return true; }
		const ext = extname(fileName).toLowerCase();
		if (ext !== ".zip" && ext !== ".md") { json(res, 400, { error: "Only .zip or .md skill packages are supported" }); return true; }
		const data = Buffer.from(dataBase64, "base64");
		if (storeBacked) {
			const workspace = await resolveWriteWorkspace(requestedWsId);
			if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
			const wsId = workspace.id;
			try {
				const node = await installWorkspaceSkill(wsId, fileName, data);
				scheduleSkillsReload();
				json(res, 201, node);
			} catch (err) {
				logger.error({ err }, "failed to install workspace skill package");
				json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
			}
			return true;
		}
		const workspace = await resolveWorkspace(requestedWsId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const wsId = workspace.id;
		const root = workspaceRegistry.resolveWorkspaceDir(wsId);
		if (!root) { json(res, 404, { error: "Workspace not found" }); return true; }
		// Guard the install target: a symlink planted at `.skills` would make the
		// installer delete/overwrite a directory outside the workspace.
		const skillsRoot = safeWorkspacePath(wsId, WORKSPACE_PRIVATE_SKILLS_DIR);
		if (!skillsRoot) { json(res, 400, { error: "Invalid skills directory" }); return true; }
		try {
			const skill = ext === ".zip"
				? installSkillZip(fileName, data, skillsRoot)
				: installSkillMarkdown(fileName, data, skillsRoot);
			scheduleSkillsReload();
			await pushReplica(wsId);
			json(res, 201, workspaceSkillNode(root, skill.name));
		} catch (err) {
			logger.error({ err }, "failed to install workspace skill package");
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
		}
		return true;
	}

	// --- Workspaces registry API ---
	if (method === "GET" && url === "/api/workspaces") {
		const tenant = getRequestTenant(req);
		if (tenant && !tenantStore) throw new Error("Tenant store is required for an authenticated request");
		if (tenant) await resolveWorkspace(TEMP_WORKSPACE_ID);
		const [ownedWorkspaceIds, ownedSessionIds] = tenant
			? await Promise.all([
				tenantStore!.listResourceIds(tenant, "workspace"),
				tenantStore!.listResourceIds(tenant, "session"),
			])
			: [null, null];
		const sessionDir = join(dataDir, "sessions");
		const allSessionIds = existsSync(sessionDir)
			? readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
				.map((file) => basename(file, ".jsonl"))
				.filter((id) => !ownedSessionIds || ownedSessionIds.has(id))
			: [];
		if (replica && tenant && ownedWorkspaceIds) {
			for (const ownedId of ownedWorkspaceIds) {
				if (!workspaceRegistry.getWorkspace(ownedId)) await replica.materializeWorkspace(tenant, ownedId);
			}
		}
		const workspaces = workspaceRegistry.listWorkspaces(allSessionIds)
			.filter((workspace) => !ownedWorkspaceIds || ownedWorkspaceIds.has(workspace.id))
			.map((workspace) => ({
				...workspace,
				sessionIds: ownedSessionIds
					? workspace.sessionIds.filter((id) => ownedSessionIds.has(id))
					: workspace.sessionIds,
			}));
		json(res, 200, workspaces);
		return true;
	}

	if (method === "POST" && url === "/api/workspaces") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const name = typeof body.name === "string" ? body.name : undefined;
		const isTemp = Boolean(body.isTemp);
		try {
			const ws = isTemp
				? await resolveWorkspace(TEMP_WORKSPACE_ID)
				: workspaceRegistry.createWorkspace({ name, isTemp: false });
			if (!ws) { json(res, 404, { error: "Workspace not found" }); return true; }
			if (!isTemp) await claimRequestResource(req, tenantStore, "workspace", ws.id);
			if (replica && requestTenant) await replica.replicateWorkspace(requestTenant, ws);
			json(res, 201, ws);
		} catch (err) {
			logger.error({ err }, "failed to create workspace");
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to create workspace" });
		}
		return true;
	}

	// Import a workspace from a zip archive (e.g. an exported preset workspace
	// bundle): extracts the archive and seeds a fresh workspace with its files.
	if (method === "POST" && url === "/api/workspaces/import") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		const name = typeof body.name === "string" ? body.name : undefined;
		if (!fileName || !dataBase64) { json(res, 400, { error: "Missing fileName or dataBase64" }); return true; }
		if (extname(fileName).toLowerCase() !== ".zip") {
			json(res, 400, { error: "Only .zip workspace archives are supported" });
			return true;
		}
		try {
			const ws = importWorkspaceZip(fileName, Buffer.from(dataBase64, "base64"), name);
			await claimRequestResource(req, tenantStore, "workspace", ws.id);
			if (replica && requestTenant) {
				await replica.replicateWorkspace(requestTenant, ws);
				await pushReplica(ws.id);
			}
			json(res, 201, ws);
		} catch (err) {
			logger.error({ err }, "failed to import workspace archive");
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to import workspace archive" });
		}
		return true;
	}

	const workspacePatchMatch = matchRoute("PATCH", method, url, "/api/workspaces/:id");
	if (workspacePatchMatch) {
		const body = (await readBody(req)) as Record<string, unknown>;
		const name = typeof body.name === "string" ? body.name : "";
		if (!name.trim()) { json(res, 400, { error: "Missing name" }); return true; }
		const updated = workspaceRegistry.renameWorkspace(decodeURIComponent(workspacePatchMatch.id), name);
		if (!updated) { json(res, 404, { error: "Workspace not found" }); return true; }
		if (replica && requestTenant) await replica.replicateWorkspace(requestTenant, updated);
		json(res, 200, updated);
		return true;
	}

	const workspaceDeleteMatch = matchRoute("DELETE", method, url.split("?")[0], "/api/workspaces/:id");
	if (workspaceDeleteMatch) {
		const id = decodeURIComponent(workspaceDeleteMatch.id);
		if (streamRegistry.getActiveForWorkspace(id)) {
			json(res, 409, { error: "Cannot delete a workspace with an active chat turn" });
			return true;
		}
		if (id === TEMP_WORKSPACE_ID) {
			json(res, 400, { error: "Cannot delete the shared tmp workspace" });
			return true;
		}
		const params = new URL(url, "http://localhost").searchParams;
		const removeFiles = params.get("removeFiles") === "1" || params.get("removeFiles") === "true";
		const ok = workspaceRegistry.deleteWorkspace(id, { removeFiles });
		if (!ok) { json(res, 404, { error: "Workspace not found" }); return true; }
		await releaseRequestResource(req, tenantStore, "workspace", id);
		if (replica && requestTenant) await replica.deleteWorkspace(requestTenant, id);
		json(res, 200, { id, deleted: true, removedFiles: removeFiles });
		return true;
	}

	// --- Session ↔ workspace binding ---
	const sessionWorkspaceSwitchPreviewMatch = matchRoute("GET", method, url, "/api/sessions/:id/workspace/switch-preview");
	if (sessionWorkspaceSwitchPreviewMatch) {
		const sessionId = decodeURIComponent(sessionWorkspaceSwitchPreviewMatch.id);
		const switchSession = await switchableSession(sessionId);
		if (!switchSession) return true;
		const requestedTargetWorkspaceId = new URL(url, "http://localhost").searchParams.get("targetWorkspaceId")?.trim() ?? "";
		if (!requestedTargetWorkspaceId) {
			json(res, 400, { error: "Missing targetWorkspaceId" });
			return true;
		}
		const targetWorkspace = await resolveWorkspace(requestedTargetWorkspaceId);
		if (!targetWorkspace) {
			json(res, 404, { error: "Target workspace not found" });
			return true;
		}
		const targetWorkspaceId = targetWorkspace.id;
		if (!await resolveSessionWorkspace(sessionId)) {
			json(res, 404, { error: "Workspace not found" });
			return true;
		}
		if (!isAvailableSwitchTarget(targetWorkspaceId)) return true;
		try {
			const preview = buildWorkspaceSwitchPreview({
				dataDir,
				sessionId,
				hasSessionHistory: switchSession.hasHistory,
				workspaceRegistry,
				targetWorkspaceId,
			});
			json(res, 200, preview);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Unable to preview workspace switch" });
		}
		return true;
	}

	const sessionWorkspaceSwitchMatch = matchRoute("POST", method, url, "/api/sessions/:id/workspace/switch");
	if (sessionWorkspaceSwitchMatch) {
		const sessionId = decodeURIComponent(sessionWorkspaceSwitchMatch.id);
		const switchSession = await switchableSession(sessionId);
		if (!switchSession) return true;
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedTargetWorkspaceId = typeof body.targetWorkspaceId === "string" ? body.targetWorkspaceId.trim() : "";
		if (!requestedTargetWorkspaceId) {
			json(res, 400, { error: "targetWorkspaceId is required" });
			return true;
		}
		const targetWorkspace = await resolveWorkspace(requestedTargetWorkspaceId);
		if (!targetWorkspace) {
			json(res, 404, { error: "Target workspace not found" });
			return true;
		}
		const targetWorkspaceId = targetWorkspace.id;
		if (!await resolveSessionWorkspace(sessionId)) {
			json(res, 404, { error: "Workspace not found" });
			return true;
		}
		if (!body.fileActions || typeof body.fileActions !== "object" || Array.isArray(body.fileActions)) {
			json(res, 400, { error: "fileActions must be an object mapping relative paths to move|copy|none" });
			return true;
		}
		const entries = Object.entries(body.fileActions as Record<string, unknown>);
		if (entries.some(([path, action]) => !path.trim() || (action !== "move" && action !== "copy" && action !== "none"))) {
			json(res, 400, { error: "fileActions must contain only relative paths and move|copy|none actions" });
			return true;
		}
		const fileActions = Object.fromEntries(entries) as Record<string, WorkspaceSwitchFileAction>;
		const sourceWorkspaceId = workspaceRegistry.getSessionWorkspaceId(sessionId);
		if (sourceWorkspaceId === targetWorkspaceId) {
			json(res, 409, { error: "Session is already bound to this workspace" });
			return true;
		}
		if (!isAvailableSwitchTarget(targetWorkspaceId)) return true;
		const sourceRoot = workspaceRegistry.resolveWorkspaceDir(sourceWorkspaceId);
		const targetRoot = workspaceRegistry.resolveWorkspaceDir(targetWorkspaceId);
		if (!sourceRoot || !targetRoot) {
			json(res, 404, { error: "Workspace path is not available" });
			return true;
		}
		let preview;
		try {
			preview = buildWorkspaceSwitchPreview({
				dataDir,
				sessionId,
				hasSessionHistory: switchSession.hasHistory,
				workspaceRegistry,
				targetWorkspaceId,
			});
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Unable to validate workspace switch" });
			return true;
		}

		// Bind before touching any file. A durable session reads its workspace when
		// its runtime opens, so the next message uses the new one.
		if (!workspaceRegistry.bindSession(sessionId, targetWorkspaceId)) {
			json(res, 404, { error: "Target workspace not found" });
			return true;
		}
		const files = transferWorkspaceFiles({ preview, sourceRoot, targetRoot, fileActions });
		if (replica && requestTenant) {
			await replica.setSessionBinding(requestTenant, sessionId, targetWorkspaceId);
			await pushReplica(preview.sourceWorkspace.id);
			await pushReplica(targetWorkspaceId);
		}
		json(res, 200, {
			switched: true,
			sessionId,
			sourceWorkspace: preview.sourceWorkspace,
			targetWorkspace: preview.targetWorkspace,
			files,
			statistics: workspaceSwitchStatistics(files),
			trackingIncomplete: preview.trackingIncomplete,
		});
		return true;
	}

	const sessionWorkspaceGetMatch = matchRoute("GET", method, url, "/api/sessions/:id/workspace");
	if (sessionWorkspaceGetMatch) {
		const sessionId = decodeURIComponent(sessionWorkspaceGetMatch.id);
		const workspace = await resolveSessionWorkspace(sessionId);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		json(res, 200, { sessionId, workspaceId: workspace.id, workspace });
		return true;
	}

	const sessionWorkspacePutMatch = matchRoute("PUT", method, url, "/api/sessions/:id/workspace");
	if (sessionWorkspacePutMatch) {
		const sessionId = decodeURIComponent(sessionWorkspacePutMatch.id);
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Cannot rebind a session with an active chat turn" });
			return true;
		}
		const body = (await readBody(req)) as Record<string, unknown>;
		const requestedWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		if (!requestedWorkspaceId) { json(res, 400, { error: "Missing workspaceId" }); return true; }
		const targetWorkspace = await resolveWorkspace(requestedWorkspaceId);
		if (!targetWorkspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		const workspaceId = targetWorkspace.id;
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Cannot rebind a session with an active chat turn" });
			return true;
		}
		const ok = workspaceRegistry.bindSession(sessionId, workspaceId);
		if (!ok) { json(res, 404, { error: "Workspace not found" }); return true; }
		if (replica && requestTenant) await replica.setSessionBinding(requestTenant, sessionId, workspaceId);
		json(res, 200, { sessionId, workspaceId });
		return true;
	}

	return false;
}
