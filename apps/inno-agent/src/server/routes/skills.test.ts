import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleSkillsRoutes, type SkillsRouteContext } from "./skills.js";

function fakeReq(): HttpReq {
	const req = Readable.from([]) as HttpReq;
	req.headers = {};
	return req;
}

function fakeRes(): ServerResponse & { statusCode: number; payload: unknown } {
	const res = {
		statusCode: 0,
		payload: undefined as unknown,
		writeHead(status: number) {
			res.statusCode = status;
			return res;
		},
		end(body?: string) {
			res.payload = body ? JSON.parse(body) : undefined;
			return res;
		},
	};
	return res as unknown as ServerResponse & { statusCode: number; payload: unknown };
}

function catalogContext(overrides: Partial<SkillsRouteContext["catalog"]> = {}): SkillsRouteContext {
	const entry = {
		name: "demo",
		description: "d",
		enabled: true,
		loaded: true,
		filePath: "catalog:demo@v1",
		size: 0,
		updatedAt: "2026-01-01T00:00:00Z",
		diagnostics: [],
		skillId: "demo",
		version: "v1",
		disableModelInvocation: false,
		source: "upload",
		publishedAt: "2026-01-01T00:00:00Z",
	};
	return {
		catalog: {
			listForTenant: vi.fn(async () => [entry]),
			setEnabled: vi.fn(async () => entry),
			installPackage: vi.fn(async () => entry),
			describe: vi.fn(async () => ({ entry, files: [{ relPath: "SKILL.md", sha256: "x", size: 4 }] })),
			readFile: vi.fn(async () => new TextEncoder().encode("body")),
			writeFile: vi.fn(async () => entry),
			delete: vi.fn(async () => true),
			...overrides,
		},
	};
}

function reqWithBody(body: unknown): HttpReq {
	const req = Readable.from([JSON.stringify(body)]) as HttpReq;
	req.headers = {};
	return req;
}

describe("catalog-backed skill management", () => {
	it("uploads go through installPackage (object store + catalog), never the local dir", async () => {
		const ctx = catalogContext();
		const res = fakeRes();
		expect(await handleSkillsRoutes(
			reqWithBody({ fileName: "demo.md", dataBase64: Buffer.from("x").toString("base64") }),
			res, "POST", "/api/skills/upload", ctx,
		)).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(ctx.catalog.installPackage).toHaveBeenCalledOnce();
	});

	it("deletes through the catalog", async () => {
		const ctx = catalogContext();
		const res = fakeRes();
		expect(await handleSkillsRoutes(fakeReq(), res, "DELETE", "/api/skills/demo", ctx)).toBe(true);
		expect(res.statusCode).toBe(204);
		expect(ctx.catalog.delete).toHaveBeenCalledWith("demo");
	});

	it("maps catalog 403s from delete/writeFile onto the response", async () => {
		const ctx = catalogContext({
			delete: vi.fn(async () => { throw Object.assign(new Error("forbidden"), { statusCode: 403 }); }),
		});
		const res = fakeRes();
		expect(await handleSkillsRoutes(fakeReq(), res, "DELETE", "/api/skills/demo", ctx)).toBe(true);
		expect(res.statusCode).toBe(403);
	});

	it("serves content and file trees from the manifest, not disk", async () => {
		const ctx = catalogContext();
		const res = fakeRes();
		expect(await handleSkillsRoutes(fakeReq(), res, "GET", "/api/skills/demo/content", ctx)).toBe(true);
		expect(res.statusCode).toBe(200);
		expect((res.payload as { content: string }).content).toBe("body");

		const treeRes = fakeRes();
		expect(await handleSkillsRoutes(fakeReq(), treeRes, "GET", "/api/skills/demo/tree", ctx)).toBe(true);
		expect(treeRes.statusCode).toBe(200);
		const tree = treeRes.payload as { children: { name: string }[] };
		expect(tree.children[0]?.name).toBe("SKILL.md");
	});
});
