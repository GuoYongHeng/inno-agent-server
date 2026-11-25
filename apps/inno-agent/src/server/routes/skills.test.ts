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

function routeContext(sharedSkillsReadOnly: boolean): SkillsRouteContext {
	return {
		skillsDir: "/unused",
		sharedSkillsReadOnly,
		scheduleSkillsReload: vi.fn(),
		listProjectSkills: vi.fn(() => [{ name: "shared-skill" }]),
		setSkillEnabled: vi.fn(),
		installSkillZip: vi.fn(),
		installSkillMarkdown: vi.fn(),
		listSkillLibrary: vi.fn(async () => []),
		importSkillFromLibrary: vi.fn(),
	};
}

describe("shared skill management boundary", () => {
	it.each([
		["POST", "/api/skills/upload"],
		["POST", "/api/skills/reload"],
		["POST", "/api/skill-library/import"],
		["PATCH", "/api/skills/shared-skill"],
		["DELETE", "/api/skills/shared-skill"],
		["PUT", "/api/skills/shared-skill/content"],
		["PUT", "/api/skills/shared-skill/file"],
	])("rejects authenticated %s %s before touching shared state", async (method, url) => {
		const ctx = routeContext(true);
		const res = fakeRes();

		expect(await handleSkillsRoutes(fakeReq(), res, method, url, ctx)).toBe(true);

		expect(res.statusCode).toBe(409);
		expect(res.payload).toEqual({ error: "Shared skill management is read-only in authenticated mode" });
		expect(ctx.scheduleSkillsReload).not.toHaveBeenCalled();
		expect(ctx.setSkillEnabled).not.toHaveBeenCalled();
		expect(ctx.installSkillZip).not.toHaveBeenCalled();
		expect(ctx.installSkillMarkdown).not.toHaveBeenCalled();
		expect(ctx.importSkillFromLibrary).not.toHaveBeenCalled();
	});

	it("keeps the shared catalog readable in authenticated mode", async () => {
		const ctx = routeContext(true);
		const res = fakeRes();

		expect(await handleSkillsRoutes(fakeReq(), res, "GET", "/api/skills", ctx)).toBe(true);

		expect(res.statusCode).toBe(200);
		expect(res.payload).toEqual([{ name: "shared-skill" }]);
	});

	it("preserves local-mode skill reloads", async () => {
		const ctx = routeContext(false);
		const res = fakeRes();

		expect(await handleSkillsRoutes(fakeReq(), res, "POST", "/api/skills/reload", ctx)).toBe(true);

		expect(res.statusCode).toBe(200);
		expect(ctx.scheduleSkillsReload).toHaveBeenCalledOnce();
	});
});

function catalogContext(overrides: Partial<NonNullable<SkillsRouteContext["catalog"]>> = {}): SkillsRouteContext {
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
		...routeContext(true),
		catalog: {
			listForTenant: vi.fn(async () => [entry]),
			setEnabled: vi.fn(async () => entry),
			enableIfPublished: vi.fn(async () => null),
			installPackage: vi.fn(async () => entry),
			importFromLibrary: vi.fn(async () => entry),
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
		expect(ctx.catalog!.installPackage).toHaveBeenCalledOnce();
		expect(ctx.installSkillZip).not.toHaveBeenCalled();
		expect(ctx.installSkillMarkdown).not.toHaveBeenCalled();
	});

	it("import enables published skills and publishes missing ones", async () => {
		const ctx = catalogContext();
		const res = fakeRes();
		expect(await handleSkillsRoutes(reqWithBody({ name: "demo" }), res, "POST", "/api/skill-library/import", ctx)).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(ctx.catalog!.importFromLibrary).toHaveBeenCalledOnce();
	});

	it("deletes through the catalog", async () => {
		const ctx = catalogContext();
		const res = fakeRes();
		expect(await handleSkillsRoutes(fakeReq(), res, "DELETE", "/api/skills/demo", ctx)).toBe(true);
		expect(res.statusCode).toBe(204);
		expect(ctx.catalog!.delete).toHaveBeenCalledWith("demo");
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
