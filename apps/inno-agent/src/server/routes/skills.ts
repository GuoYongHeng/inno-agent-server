import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { SkillManifestFile } from "../../skills/skill-object-key.js";
import {
	contentTypeForWorkspaceFile,
	slugifySkillName,
	workspaceFileKind,
	type WorkspaceTreeNode,
} from "../file-helpers.js";
import { json, matchRoute, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";

/**
 * Skill-management dependencies owned by server.ts. All skill state lives in
 * the object-storage catalog (`skill_catalog` rows + `platform/skills/…` /
 * `tenants/<t>/skills/…` bodies) — there is no local-directory fallback.
 */
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
	/** Upload .zip/.md → publish bodies to object storage + catalog, enable for the tenant. */
	installPackage: (fileName: string, data: Buffer) => Promise<CatalogSkillListing>;
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
	/** Platform catalog + tenant_skills. Required: object storage is a boot
	 * dependency, so every skill operation goes through it. */
	catalog: SkillsCatalogContext;
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
 * /api/skills* route domain. Returns true when the
 * request was handled.
 */
export async function handleSkillsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SkillsRouteContext,
): Promise<boolean> {
	const catalog = ctx.catalog;

	if (method === "GET" && url === "/api/skills") {
		json(res, 200, await catalog.listForTenant());
		return true;
	}

	const enableMatch = matchRoute("POST", method, url, "/api/skills/:name/enable");
	if (enableMatch) {
		const name = slugifySkillName(decodeURIComponent(enableMatch.name));
		const entry = await catalog.setEnabled(name, true);
		if (!entry) { json(res, 404, { error: "Skill not found in catalog" }); return true; }
		json(res, 200, entry);
		return true;
	}

	const disableMatch = matchRoute("POST", method, url, "/api/skills/:name/disable");
	if (disableMatch) {
		const name = slugifySkillName(decodeURIComponent(disableMatch.name));
		const entry = await catalog.setEnabled(name, false);
		if (!entry) { json(res, 404, { error: "Skill not found in catalog" }); return true; }
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
		try {
			const entry = await catalog.installPackage(fileName, Buffer.from(dataBase64, "base64"));
			json(res, 201, entry);
		} catch (err) {
			json(res, 400, { error: err instanceof Error ? err.message : "Failed to install skill package" });
		}
		return true;
	}

	if (method === "POST" && url === "/api/skills/reload") {
		json(res, 200, { reloaded: true, skills: await catalog.listForTenant() });
		return true;
	}

	const skillToggleMatch = matchRoute("PATCH", method, url, "/api/skills/:name");
	if (skillToggleMatch) {
		const name = slugifySkillName(decodeURIComponent(skillToggleMatch.name));
		const body = (await readBody(req)) as Record<string, unknown>;
		if (typeof body.enabled !== "boolean") {
			json(res, 400, { error: "enabled boolean required" });
			return true;
		}
		const entry = await catalog.setEnabled(name, body.enabled);
		if (!entry) { json(res, 404, { error: "Skill not found in catalog" }); return true; }
		json(res, 200, entry);
		return true;
	}

	const skillDeleteMatch = matchRoute("DELETE", method, url, "/api/skills/:name");
	if (skillDeleteMatch) {
		const name = slugifySkillName(decodeURIComponent(skillDeleteMatch.name));
		try {
			if (!(await catalog.delete(name))) {
				json(res, 404, { error: "Skill not found" });
				return true;
			}
			json(res, 204, null);
		} catch (err) {
			json(res, (err as { statusCode?: number }).statusCode ?? 500, { error: err instanceof Error ? err.message : "Failed to delete skill" });
		}
		return true;
	}

	// GET /api/skills/:name/content — read SKILL.md content
	const skillContentGetMatch = matchRoute("GET", method, url, "/api/skills/:name/content");
	if (skillContentGetMatch) {
		const name = slugifySkillName(decodeURIComponent(skillContentGetMatch.name));
		const body = await catalog.readFile(name, "SKILL.md");
		if (!body) { json(res, 404, { error: "Skill not found" }); return true; }
		json(res, 200, { name, content: new TextDecoder().decode(body) });
		return true;
	}

	// PUT /api/skills/:name/content — save SKILL.md content
	const skillContentPutMatch = matchRoute("PUT", method, url, "/api/skills/:name/content");
	if (skillContentPutMatch) {
		const name = slugifySkillName(decodeURIComponent(skillContentPutMatch.name));
		const body = (await readBody(req)) as Record<string, unknown>;
		const content = typeof body.content === "string" ? body.content : "";
		try {
			const entry = await catalog.writeFile(name, "SKILL.md", content);
			if (!entry) { json(res, 404, { error: "Skill not found" }); return true; }
			json(res, 200, { name, saved: true });
		} catch (err) {
			json(res, (err as { statusCode?: number }).statusCode ?? 500, { error: err instanceof Error ? err.message : "Failed to save skill" });
		}
		return true;
	}

	// GET /api/skills/:name/tree — file tree of a skill directory
	const skillTreeMatch = matchRoute("GET", method, url, "/api/skills/:name/tree");
	if (skillTreeMatch) {
		const name = slugifySkillName(decodeURIComponent(skillTreeMatch.name));
		const described = await catalog.describe(name);
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

	// GET /api/skills/:name/file?path=... — read a file inside a skill
	const skillFileGetMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/file");
	if (skillFileGetMatch && method === "GET") {
		const name = slugifySkillName(decodeURIComponent(skillFileGetMatch.name));
		const params = new URL(url, "http://localhost").searchParams;
		const relPath = (params.get("path") ?? "").replace(/^\/+/, "");
		const described = await catalog.describe(name);
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
		const body = await catalog.readFile(name, relPath);
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

	// PUT /api/skills/:name/file — save a file inside a skill
	const skillFilePutMatch = matchRoute("PUT", method, url, "/api/skills/:name/file");
	if (skillFilePutMatch) {
		const name = slugifySkillName(decodeURIComponent(skillFilePutMatch.name));
		const body = (await readBody(req)) as Record<string, unknown>;
		const relPath = typeof body.path === "string" ? body.path.trim().replace(/^\/+/, "") : "";
		const content = typeof body.content === "string" ? body.content : "";
		if (!relPath) { json(res, 400, { error: "Missing path" }); return true; }
		const described = await catalog.describe(name);
		const meta = described?.files.find((f) => f.relPath === relPath);
		if (!described || !meta) { json(res, 404, { error: "File not found" }); return true; }
		try {
			const entry = await catalog.writeFile(name, relPath, content);
			if (!entry) { json(res, 404, { error: "File not found" }); return true; }
			json(res, 200, { path: relPath, saved: true, size: Buffer.byteLength(content), updatedAt: entry.publishedAt });
		} catch (err) {
			json(res, (err as { statusCode?: number }).statusCode ?? 500, { error: err instanceof Error ? err.message : "Failed to save skill" });
		}
		return true;
	}

	// GET /api/skills/:name/raw?path=... — serve raw file bytes
	const skillRawMatch = matchRoute("GET", method, url.split("?")[0], "/api/skills/:name/raw");
	if (skillRawMatch) {
		const name = slugifySkillName(decodeURIComponent(skillRawMatch.name));
		const params = new URL(url, "http://localhost").searchParams;
		const relPath = (params.get("path") ?? "").replace(/^\/+/, "");
		const body = await catalog.readFile(name, relPath);
		if (!body) { json(res, 404, { error: "File not found" }); return true; }
		res.writeHead(200, { "Content-Type": contentTypeForWorkspaceFile(relPath), "Cache-Control": "no-cache" });
		res.end(Buffer.from(body));
		return true;
	}

	return false;
}
