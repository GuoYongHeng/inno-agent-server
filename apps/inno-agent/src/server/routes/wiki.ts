import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { basename, extname } from "node:path";
import { logger } from "../../logger.js";
import { getL2Memory } from "../../memory/l2/l2-memory.js";
import { readManifest, removeWikiPathFromManifest } from "../../memory/l2/manifest-store.js";
import { buildWikiGraph } from "../../memory/l2/wiki-graph.js";
import { parseFrontmatter, rebuildIndex } from "../../memory/l2/wiki-maintainer.js";
import type { WikiIngestReview } from "../../memory/l2/wiki-generator.js";
import { l2Store, checkL2Path, readJsonLines, type L2Backend } from "../../memory/l2/l2-backend.js";
import { json, readBody, UPLOAD_MAX_BODY_BYTES } from "../http-helpers.js";
import { listWikiPagePaths } from "../../memory/l2/wiki-page-files.js";
import { getRequestTenant } from "../../tenants/http.js";
import { resolveTenantDataDir } from "../../tenants/paths.js";

export interface WikiRouteContext {
	l2DataDir: string;
	dataDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers moved verbatim from server.ts (P2 route split). The two wiki
// listing helpers closed over server.ts's module-level l2DataDir; they take
// it as an explicit parameter instead.
// ---------------------------------------------------------------------------

async function manifestSourceIdByWikiPath(store: L2Backend): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const entry of await readManifest(store)) {
		for (const wikiPath of entry.wikiPages) {
			map.set(wikiPath, entry.id);
		}
	}
	return map;
}

function sanitizeUploadName(name: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "upload";
}

function uploadExtension(fileName: string, mimeType: string): string {
	const ext = extname(fileName);
	if (ext) return ext;
	if (mimeType === "application/pdf") return ".pdf";
	if (mimeType.includes("wordprocessingml")) return ".docx";
	if (mimeType.includes("spreadsheetml")) return ".xlsx";
	if (mimeType.includes("presentationml")) return ".pptx";
	if (mimeType === "text/markdown") return ".md";
	if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length).replace("jpeg", "jpg")}`;
	if (mimeType.startsWith("text/")) return ".txt";
	return ".bin";
}

/** Validate a client-supplied wiki-relative path; null on traversal/junk. */
function safeWikiPath(path: string): string | null {
	try {
		return checkL2Path(path);
	} catch {
		return null;
	}
}

/**
 * /api/wiki/* and /api/l2/raw/upload route domain. Returns true when the
 * request was handled. Reads go through the L2 backend mounted for the
 * tenant (files locally, PostgreSQL + object store in auth mode).
 */
export async function handleWikiRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: WikiRouteContext,
): Promise<boolean> {
	const tenant = getRequestTenant(req);
	if (tenant && !ctx.dataDir) throw new Error("dataDir is required for tenant wiki storage");
	const l2DataDir = tenant
		? resolveTenantDataDir(req, ctx.dataDir!, "l2")
		: ctx.l2DataDir;
	const store = l2Store(l2DataDir);

	// --- Wiki API ---
	if (method === "GET" && url === "/api/wiki/pages") {
		try {
			const sourceIds = await manifestSourceIdByWikiPath(store);
			const pages: unknown[] = [];
			for (const wikiPath of await listWikiPagePaths(store)) {
				if (await store.exists(wikiPath)) {
					const content = await store.readText(wikiPath);
					const { frontmatter, body } = parseFrontmatter(content);
					pages.push({
						path: wikiPath,
						frontmatter,
						bodyPreview: body.slice(0, 200),
						sourceId: sourceIds.get(wikiPath) ?? "",
					});
				}
			}
			json(res, 200, pages);
		} catch (err) {
			logger.warn({ err }, "failed to list wiki pages");
			json(res, 200, []);
		}
		return true;
	}

	if (method === "GET" && url.startsWith("/api/wiki/page?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const path = params.get("path");
		const rel = path ? safeWikiPath(path) : null;
		if (!rel) {
			json(res, 400, { error: path ? "Invalid wiki path" : "Missing path parameter" });
			return true;
		}
		if (!(await store.exists(rel))) {
			json(res, 404, { error: "Wiki page not found" });
			return true;
		}
		const content = await store.readText(rel);
		json(res, 200, { path: rel, content });
		return true;
	}

	if (method === "PUT" && url === "/api/wiki/page") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const path = body.path as string | undefined;
		const content = body.content as string | undefined;
		const rel = path ? safeWikiPath(path) : null;
		if (!rel || content === undefined) {
			json(res, 400, { error: "Missing path or content" });
			return true;
		}
		await store.writeText(rel, content);
		await getL2Memory(l2DataDir).indexPageByPath(rel);
		try {
			await rebuildIndex(store, await readManifest(store));
		} catch (err) {
			logger.warn({ err, path: rel }, "failed to rebuild wiki index after page update");
		}
		json(res, 200, { path: rel, saved: true });
		return true;
	}

	if (method === "DELETE" && url.startsWith("/api/wiki/page?")) {
		const params = new URL(url, "http://localhost").searchParams;
		const path = params.get("path");
		const rel = path ? safeWikiPath(path) : null;
		if (!rel) {
			json(res, 400, { error: path ? "Invalid wiki path" : "Missing path parameter" });
			return true;
		}
		if (!(await store.exists(rel))) {
			json(res, 404, { error: "Wiki page not found" });
			return true;
		}
		try {
			await store.delete(rel);
			await removeWikiPathFromManifest(store, rel);
			await getL2Memory(l2DataDir).removePage(rel);
			try {
				await rebuildIndex(store, await readManifest(store));
			} catch (err) {
				logger.warn({ err, path: rel }, "failed to rebuild wiki index after page deletion");
			}
			json(res, 200, { path: rel, deleted: true });
		} catch (err) {
			logger.warn({ err }, "failed to delete wiki page");
			json(res, 500, { error: "Failed to delete wiki page" });
		}
		return true;
	}

	if (method === "GET" && url === "/api/wiki/reviews") {
		try {
			const reviews = (await readJsonLines<WikiIngestReview>(store, "reviews.jsonl"))
				.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
			json(res, 200, reviews);
		} catch (err) {
			logger.warn({ err }, "failed to list wiki reviews");
			json(res, 200, []);
		}
		return true;
	}

	if (method === "GET" && url === "/api/wiki/graph") {
		try {
			json(res, 200, await buildWikiGraph(store));
		} catch (err) {
			logger.warn({ err }, "failed to build wiki graph");
			json(res, 200, { nodes: [], edges: [] });
		}
		return true;
	}

	if (method === "GET" && url === "/api/wiki/stats") {
		try {
			const entries = await readManifest(store);
			let totalSize = 0;
			let pageCount = 0;
			for (const wikiPath of await listWikiPagePaths(store)) {
				const stat = await store.stat(wikiPath);
				if (stat) {
					totalSize += stat.size;
					pageCount++;
				}
			}
			json(res, 200, { pageCount, totalSize, entryCount: entries.length });
		} catch (err) {
			logger.warn({ err }, "failed to compute wiki stats");
			json(res, 200, { pageCount: 0, totalSize: 0, entryCount: 0 });
		}
		return true;
	}

	// --- L2 Raw Upload API ---
	if (method === "POST" && url === "/api/l2/raw/upload") {
		const body = (await readBody(req, { maxBytes: UPLOAD_MAX_BODY_BYTES })) as Record<string, unknown>;
		const fileName = typeof body.fileName === "string" ? body.fileName : "";
		const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
		const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
		if (!fileName || !dataBase64) {
			json(res, 400, { error: "Missing fileName or dataBase64" });
			return true;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const safeName = sanitizeUploadName(fileName);
		const ext = uploadExtension(safeName, mimeType);
		const base = basename(safeName, ext).slice(0, 80) || "upload";
		const outputName = `${timestamp}-${base}${ext}`;
		const data = Buffer.from(dataBase64, "base64");
		const rawPath = `raw/uploads/${outputName}`;
		await store.putBinary(rawPath, data, mimeType);
		json(res, 201, {
			fileName,
			mimeType,
			size: data.length,
			rawPath,
		});
		return true;
	}

	return false;
}
