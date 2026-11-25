import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { logger } from "../../logger.js";
import type { SkillLibraryItem } from "../../content-source/types.js";
import type { SkillManifestFile } from "../../skills/skill-object-key.js";
import { isWithin } from "../../utils/path-safety.js";
import {
	canonicalTreeRoot,
	contentTypeForWorkspaceFile,
	safeJoinReal,
	slugifySkillName,
	workspaceFileKind,
	WORKSPACE_TREE_MAX_DEPTH,
	type WorkspaceTreeNode,
} from "../file-helpers.js";
import { json, matchRoute, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

/**
 * Skill-management dependencies owned by server.ts. These helpers close over
 * server module state (skillsDir, configDir, the content source), so they are
 * injected rather than imported. A later split step may move them into a
 * shared skill-store module; until then this ctx keeps the route domain
 * behavior-identical.
 */
/** Shape compatible with the web `SkillInfo` panel, plus catalog fields. */
export interface CatalogSkillListing {
	name: string;
	description: string;
	enabled: boolean;
	loaded: boolean;
	filePath: string;
	size: number;
	updatedAt: string;
	diagnostics: string[];
	skillId: string;
	version: string;
	disableModelInvocation: boolean;
	source: string | null;
	publishedAt: string;
}

export interface SkillsCatalogContext {
	listForTenant: () => Promise<CatalogSkillListing[]>;
	setEnabled: (skillId: string, enabled: boolean) => Promise<CatalogSkillListing | null>;
	/** Enable a published catalog skill; returns null when not in catalog. */
	enableIfPublished: (skillId: string) => Promise<CatalogSkillListing | null>;
	/** Upload .zip/.md → publish bodies to object storage + catalog, enable for the tenant. */
	installPackage: (fileName: string, data: Buffer) => Promise<CatalogSkillListing>;
	/** Content-hub import → publish when missing, enable for the tenant. Throws on failure. */
	importFromLibrary: (name: string) => Promise<CatalogSkillListing>;
	/** Catalog record + manifest file list; null when the skill is not published. */
	describe: (skillId: string) => Promise<{ entry: CatalogSkillListing; files: SkillManifestFile[] } | null>;
	/** Bytes of one packaged file; null when the skill or file is missing. */
	readFile: (skillId: string, relPath: string) => Promise<Uint8Array | null>;
	/** Overwrite one packaged file and republish; null when the skill is missing. */
	writeFile: (skillId: string, relPath: string, content: string) => Promise<CatalogSkillListing | null>;
	/** Unpublish: drop the catalog row (tenant_skills cascade) and the object bodies. */
	delete: (skillId: string) => Promise<boolean>;
}

export interface SkillsRouteContext {
	skillsDir: string;
	/** Authenticated tenants share the admin-managed skill directory read-only. */
	sharedSkillsReadOnly?: boolean;
	/** Platform catalog + tenant_skills (authenticated mode). */
	catalog?: SkillsCatalogContext;
	scheduleSkillsReload: () => void;
	listProjectSkills: () => unknown[];
	setSkillEnabled: (name: string, enabled: boolean) => Promise<void>;
	installSkillZip: (fileName: string, data: Buffer) => { name: string; filePath: string };
	installSkillMarkdown: (fileName: string, data: Buffer) => { name: string; filePath: string };
	listSkillLibrary: (forceRefresh?: boolean) => Promise<SkillLibraryItem[]>;
	importSkillFromLibrary: (name: string) => Promise<{ name: string; filePath: string }>;
}

/** Build the UI tree shape from a published skill's flat manifest file list. */
function manifestToTree(files: SkillManifestFile[], updatedAt: string): WorkspaceTreeNode[] {
	interface MutableDir {
		node: WorkspaceTreeNode;
		dirs: Map<string, MutableDir>;
	}
	const root: MutableDir = { node: { name: "", path: "", type: "directory", size: 0, updatedAt, children: [] }, dirs: new Map() };
	for (const file of files) {
		const parts = file.relPath.split("/").filter(Boolean);
		if (parts.length === 0) continue;
		let dir = root;
		for (const part of parts.slice(0, -1)) {
			let next = dir.dirs.get(part);
			if (!next) {
				const path = dir.node.path ? `${dir.node.path}/${part}` : part;
				next = { node: { name: part, path, type: "directory", size: 0, updatedAt, children: [] }, dirs: new Map() };
				dir.dirs.set(part, next);
				dir.node.children!.push(next.node);
			}
			dir = next;
		}
		const name = parts[parts.length - 1]!;
		dir.node.children!.push({
			name,
			path: dir.node.path ? `${dir.node.path}/${name}` : name,
			type: "file",
			size: file.size,
			updatedAt,
		});
	}
	const sortLevel = (nodes: WorkspaceTreeNode[]): void => {
		nodes.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, "zh-CN"));
		for (const node of nodes) if (node.children) sortLevel(node.children);
	};
	sortLevel(root.node.children ?? []);
	return root.node.children ?? [];
}

/**
 * /api/skills* and /api/skill-library* route domain. Returns true when the
 * request was handled. Extracted verbatim from server.ts during the P2 route
 * split — behavior unchanged.
 */
export async function handleSkillsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SkillsRouteContext,
): Promise<boolean> {
	const { skillsDir } = ctx;

	// With a platform catalog every mutation below goes through object storage
	// + skill_catalog — no shared local directory is touched. The read-only
	// guard only matters when the catalog is absent (legacy local mode).
	if (ctx.sharedSkillsReadOnly && !ctx.catalog && method !== "GET") {
		json(res, 409, { error: "Shared skill management is read-only in authenticated mode" });
		return true;
	}

	if (method === "GET" && url === "/api/skills") {
		if (ctx.catalog) {
			json(res, 200, await ctx.catalog.listForTenant());
			return true;
		}
		// Do not call reloadResources() here — it is queued behind the agent
		// loop, so it stalls while an LLM turn is streaming. Listing from
		// disk is enough for displaying the panel.
		json(res, 200, ctx.listProjectSkills());
		return true;
	}

	const enableMatch = matchRoute("POST", method, url, "/api/skills/:name/enable");
	if (enableMatch && ctx.catalog) {
		const name = slugifySkillName(decodeURIComponent(enableMatch.name));
		const entry = await ctx.catalog.setEnabled(name, true);
		if (!entry) {
			json(res, 404, { error: "Skill not found in catalog" });
			return true;
		}
		json(res, 200, entry);
		return true;
	}

	const disableMatch = matchRoute("POST", method, url, "/api/skills/:name/disable");
	if (disableMatch && ctx.catalog) {
		const name = slugifySkillName(decodeURIComponent(disableMatch.name));
		const entry = await ctx.catalog.setEnabled(name, false);
		if (!entry) {
			json(res, 404, { error: "Skill not found in catalog" });
			return true;
		}
		json(res, 200, entry);
		return true;
	}

	if (method === "POST" && url === "/api/skills/upload") {
		const body = (await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES })) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!fileName || !dataBase64) {
			json(res, 400, { error: "Missing fileName or dataBase64" });
			return true;
		}
		const data = Buffer.from(dataBase64, "base64");
		if (ctx.catalog) {
			try {
				const entry = await ctx.catalog.installPackage(fileName, data);
				json(res, 201, entry);
			} catch (err) {
				json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
			}
			return true;
		}
		const ext = extname(fileName).toLowerCase();
		const skill = ext === ".zip"
			? ctx.installSkillZip(fileName, data)
			: ctx.installSkillMarkdown(fileName, data);
		await ctx.setSkillEnabled(skill.name, true);
		const installed = ctx.listProjectSkills().find((entry) => (entry as { name: string }).name === skill.name);
		json(res, 201, installed ?? { name: skill.name });
		ctx.scheduleSkillsReload();
		return true;
	}

	if (method === "POST" && url === "/api/skills/reload") {
		ctx.scheduleSkillsReload();
		json(res, 200, { reloaded: true, skills: ctx.catalog ? await ctx.catalog.listForTenant() : ctx.listProjectSkills() });
		return true;
	}

	// --- Remote skill library (GitHub) ---
	if (method === "GET" && url.split("?")[0] === "/api/skill-library") {
		const forceRefresh = new URL(url, "http://localhost").searchParams.get("refresh") === "1";
		try {
			json(res, 200, await ctx.listSkillLibrary(forceRefresh));
		} catch (err) {
			logger.warn({ err }, "failed to list skill library");
			json(res, 502, { error: err instanceof Error ? err.message : "Failed to load skill library" });
		}
		return true;
	}

	if (method === "POST" && url === "/api/skill-library/import") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const skillName = typeof body.name === "string" ? body.name.trim() : "";
		if (!skillName) {
			json(res, 400, { error: "Missing skill name" });
			return true;
		}
		if (ctx.catalog) {
			try {
				const entry = await ctx.catalog.enableIfPublished(slugifySkillName(skillName))
					?? await ctx.catalog.importFromLibrary(skillName);
				json(res, 201, entry);
			} catch (err) {
				logger.warn({ err }, "failed to import skill from library");
				json(res, 502, { error: err instanceof Error ? err.message : "Failed to import skill" });
			}
			return true;
		}
		try {
			const installed = await ctx.importSkillFromLibrary(skillName);
			await ctx.setSkillEnabled(installed.name, true);
			const entry = ctx.listProjectSkills().find((s) => (s as { name: string }).name === installed.name);
			json(res, 201, entry ?? { name: installed.name });
			ctx.scheduleSkillsReload();
		} catch (err) {
			logger.warn({ err }, "failed to import skill from library");
			json(res, 502, { error: err instanceof Error ? err.message : "Failed to import skill" });
		}
		return true;
	}

	const skillToggleMatch = matchRoute("PATCH", method, url, "/api/skills/:name");
	if (skillToggleMatch) {
		const name = slugifySkillName(decodeURIComponent(skillToggleMatch.name));
		const body = (await readBody(req)) as Record<string, unknown>;
		if (ctx.catalog) {
			if (typeof body.enabled !== "boolean") {
				json(res, 400, { error: "enabled boolean required" });
				return true;
			}
			const entry = await ctx.catalog.setEnabled(name, body.enabled);
			if (!entry) {
				json(res, 404, { error: "Skill not found in catalog" });
				return true;
			}
			json(res, 200, entry);
			return true;
		}
		const skillFile = join(skillsDir, name, "SKILL.md");
		if (!existsSync(skillFile)) {
			json(res, 404, { error: "Skill not found" });
			return true;
		}
		if (typeof body.enabled === "boolean") {
			await ctx.setSkillEnabled(name, body.enabled);
		}
		ctx.scheduleSkillsReload();
		json(res, 200, ctx.listProjectSkills().find((entry) => (entry as { name: string }).name === name));
		return true;
	}

	const skillDeleteMatch = matchRoute("DELETE", method, url, "/api/skills/:name");
	if (skillDeleteMatch) {
		const name = slugifySkillName(decodeURIComponent(skillDeleteMatch.name));
		if (ctx.catalog) {
			try {
				if (!(await ctx.catalog.delete(name))) {
					json(res, 404, { error: "Skill not found" });
					return true;
				}
				json(res, 204, null);
			} catch (err) {
				json(res, (err as { statusCode?: number }).statusCode ?? 500, { error: err instanceof Error ? err.message : "Failed to delete skill" });
			}
			return true;
		}
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) {
			json(res, 404, { error: "Skill not found" });
			return true;
		}
		rmSync(skillDir, { recursive: true, force: true });
		await ctx.setSkillEnabled(name, true);
		ctx.scheduleSkillsReload();
		json(res, 204, null);
		return true;
	}

	// GET /api/skills/:name/content — read SKILL.md content
	const skillContentGetMatch = matchRoute("GET", method, url, "/api/skills/:name/content");
	if (skillContentGetMatch) {
		const name = slugifySkillName(decodeURIComponent(skillContentGetMatch.name));
		if (ctx.catalog) {
			const body = await ctx.catalog.readFile(name, "SKILL.md");
			if (!body) { json(res, 404, { error: "Skill not found" }); return true; }
			json(res, 200, { name, content: new TextDecoder().decode(body) });
			return true;
		}
		const filePath = join(skillsDir, name, "SKILL.md");
		if (!existsSync(filePath)) { json(res, 404, { error: "Skill not found" }); return true; }
		json(res, 200, { name, content: readFileSync(filePath, "utf-8") });
		return true;
	}

	// PUT /api/skills/:name/content — save SKILL.md content
	const skillContentPutMatch = matchRoute("PUT", method, url, "/api/skills/:name/content");
	if (skillContentPutMatch) {
		const name = slugifySkillName(decodeURIComponent(skillContentPutMatch.name));
		const body = (await readBody(req)) as Record<string, unknown>;
		const content = typeof body.content === "string" ? body.content : "";
		if (ctx.catalog) {
			try {
				const entry = await ctx.catalog.writeFile(name, "SKILL.md", content);
				if (!entry) { json(res, 404, { error: "Skill not found" }); return true; }
				json(res, 200, { name, saved: true });
			} catch (err) {
				json(res, (err as { statusCode?: number }).statusCode ?? 500, { error: err instanceof Error ? err.message : "Failed to save skill" });
			}
			return true;
		}
		const filePath = join(skillsDir, name, "SKILL.md");
		if (!existsSync(filePath)) { json(res, 404, { error: "Skill not found" }); return true; }
		writeFileSync(filePath, content, "utf-8");
		ctx.scheduleSkillsReload();
		json(res, 200, { name, saved: true });
		return true;
	}

	// GET /api/skills/:name/tree — file tree of a skill directory
	const skillTreeMatch = matchRoute("GET", method, url, "/api/skills/:name/tree");
	if (skillTreeMatch) {
		const name = slugifySkillName(decodeURIComponent(skillTreeMatch.name));
		if (ctx.catalog) {
			const described = await ctx.catalog.describe(name);
			if (!described) { json(res, 404, { error: "Skill not found" }); return true; }
			json(res, 200, {
				name,
				path: "",
				type: "directory",
				size: described.files.reduce((sum, f) => sum + f.size, 0),
				updatedAt: described.entry.publishedAt,
				children: manifestToTree(described.files, described.entry.publishedAt),
			});
			return true;
		}
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
			json(res, 404, { error: "Skill not found" });
			return true;
		}
		const skillRootReal = canonicalTreeRoot(skillDir);
		function readSkillTree(dir: string, depth = 0, seen: ReadonlySet<string> = new Set()): WorkspaceTreeNode[] {
			if (depth > WORKSPACE_TREE_MAX_DEPTH) return [];
			let entries: Dirent<string>[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return [];
			}
			return entries
				.filter((e) => !e.name.startsWith(".") && e.name !== "__MACOSX" && e.name !== "node_modules")
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"))
				.slice(0, 200)
				.map((entry): WorkspaceTreeNode | null => {
					const fullPath = join(dir, entry.name);
					let st: ReturnType<typeof statSync>;
					try {
						st = statSync(fullPath);
					} catch {
						return null;
					}
					const isDir = st.isDirectory();
					const node: WorkspaceTreeNode = {
						name: entry.name,
						path: relative(skillDir, fullPath),
						type: isDir ? "directory" : "file",
						size: st.size,
						updatedAt: st.mtime.toISOString(),
					};
					if (isDir) {
						let real: string;
						try {
							real = realpathSync(fullPath);
						} catch {
							real = fullPath;
						}
						const withinRoot = isWithin(skillRootReal, real);
						node.children = withinRoot && !seen.has(real)
							? readSkillTree(fullPath, depth + 1, new Set([...seen, real]))
							: [];
					}
					return node;
				})
				.filter((node): node is WorkspaceTreeNode => node !== null);
		}
		const st = statSync(skillDir);
		json(res, 200, {
			name,
			path: "",
			type: "directory",
			size: st.size,
			updatedAt: st.mtime.toISOString(),
			children: readSkillTree(skillDir),
		});
		return true;
	}

	// GET /api/skills/:name/file?path=... — read a file inside a skill
	const skillFileGetMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/file");
	if (skillFileGetMatch && method === "GET") {
		const name = slugifySkillName(decodeURIComponent(skillFileGetMatch.name));
		if (ctx.catalog) {
			const params = new URL(url, "http://localhost").searchParams;
			const relPath = (params.get("path") ?? "").replace(/^\/+/, "");
			const described = await ctx.catalog.describe(name);
			const meta = described?.files.find((f) => f.relPath === relPath);
			if (!described || !meta) { json(res, 404, { error: "File not found" }); return true; }
			const kind = workspaceFileKind(relPath);
			const forceText = params.get("forceText") === "1";
			if (!forceText && (kind === "binary" || kind === "pdf" || kind === "image")) {
				json(res, 200, {
					path: relPath,
					name: basename(relPath),
					kind,
					mimeType: contentTypeForWorkspaceFile(relPath),
					size: meta.size,
					updatedAt: described.entry.publishedAt,
					url: `/api/skills/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(relPath)}`,
				});
				return true;
			}
			const body = await ctx.catalog.readFile(name, relPath);
			if (!body) { json(res, 404, { error: "File not found" }); return true; }
			if (body.byteLength > 1024 * 1024) { json(res, 413, { error: "File too large" }); return true; }
			json(res, 200, {
				path: relPath,
				name: basename(relPath),
				kind: forceText ? "text" : kind,
				mimeType: forceText ? "text/plain; charset=utf-8" : contentTypeForWorkspaceFile(relPath),
				size: body.byteLength,
				updatedAt: described.entry.publishedAt,
				content: new TextDecoder().decode(body),
			});
			return true;
		}
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return true; }
		const params = new URL(url, "http://localhost").searchParams;
		const relPath = params.get("path") ?? "";
		const fullPath = safeJoinReal(skillDir, relPath.replace(/^\/+/, ""));
		if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" });
			return true;
		}
		const st = statSync(fullPath);
		const kind = workspaceFileKind(fullPath);
		const forceText = params.get("forceText") === "1";
		if (!forceText && (kind === "binary" || kind === "pdf" || kind === "image")) {
			json(res, 200, {
				path: relative(skillDir, fullPath),
				name: basename(fullPath),
				kind,
				mimeType: contentTypeForWorkspaceFile(fullPath),
				size: st.size,
				updatedAt: st.mtime.toISOString(),
				url: `/api/skills/${encodeURIComponent(name)}/raw?path=${encodeURIComponent(relative(skillDir, fullPath))}`,
			});
			return true;
		}
		if (st.size > 1024 * 1024) { json(res, 413, { error: "File too large" }); return true; }
		json(res, 200, {
			path: relative(skillDir, fullPath),
			name: basename(fullPath),
			kind: forceText ? "text" : kind,
			mimeType: forceText ? "text/plain; charset=utf-8" : contentTypeForWorkspaceFile(fullPath),
			size: st.size,
			updatedAt: st.mtime.toISOString(),
			content: readFileSync(fullPath, "utf-8"),
		});
		return true;
	}

	// PUT /api/skills/:name/file — save a file inside a skill
	const skillFilePutMatch = matchRoute("PUT", method, url, "/api/skills/:name/file");
	if (skillFilePutMatch) {
		const name = slugifySkillName(decodeURIComponent(skillFilePutMatch.name));
		const body = (await readBody(req)) as Record<string, unknown>;
		const relPath = typeof body.path === "string" ? body.path.trim().replace(/^\/+/, "") : "";
		const content = typeof body.content === "string" ? body.content : "";
		if (!relPath) { json(res, 400, { error: "Missing path" }); return true; }
		if (ctx.catalog) {
			const described = await ctx.catalog.describe(name);
			const meta = described?.files.find((f) => f.relPath === relPath);
			if (!described || !meta) { json(res, 404, { error: "File not found" }); return true; }
			try {
				const entry = await ctx.catalog.writeFile(name, relPath, content);
				if (!entry) { json(res, 404, { error: "Skill not found" }); return true; }
				json(res, 200, { path: relPath, saved: true, size: Buffer.byteLength(content), updatedAt: entry.publishedAt });
			} catch (err) {
				json(res, (err as { statusCode?: number }).statusCode ?? 500, { error: err instanceof Error ? err.message : "Failed to save skill" });
			}
			return true;
		}
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return true; }
		const fullPath = safeJoinReal(skillDir, relPath.replace(/^\/+/, ""));
		if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" });
			return true;
		}
		writeFileSync(fullPath, content, "utf-8");
		if (basename(fullPath) === "SKILL.md") ctx.scheduleSkillsReload();
		const st = statSync(fullPath);
		json(res, 200, { path: relPath, saved: true, size: st.size, updatedAt: st.mtime.toISOString() });
		return true;
	}

	// GET /api/skills/:name/raw?path=... — serve raw file bytes
	const skillRawMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/raw");
	if (skillRawMatch) {
		const name = slugifySkillName(decodeURIComponent(skillRawMatch.name));
		if (ctx.catalog) {
			const params = new URL(url, "http://localhost").searchParams;
			const relPath = (params.get("path") ?? "").replace(/^\/+/, "");
			const body = await ctx.catalog.readFile(name, relPath);
			if (!body) { json(res, 404, { error: "File not found" }); return true; }
			res.writeHead(200, { "Content-Type": contentTypeForWorkspaceFile(relPath), "Cache-Control": "no-cache" });
			res.end(Buffer.from(body));
			return true;
		}
		const skillDir = join(skillsDir, name);
		if (!existsSync(skillDir)) { json(res, 404, { error: "Skill not found" }); return true; }
		const params = new URL(url, "http://localhost").searchParams;
		const relPath = params.get("path") ?? "";
		const fullPath = safeJoinReal(skillDir, relPath.replace(/^\/+/, ""));
		if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
			json(res, 404, { error: "File not found" });
			return true;
		}
		const ct = contentTypeForWorkspaceFile(fullPath);
		res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
		res.end(readFileSync(fullPath));
		return true;
	}

	return false;
}
