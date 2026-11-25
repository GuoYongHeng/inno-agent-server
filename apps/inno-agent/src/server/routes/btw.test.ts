import { FileStateKv } from "../../tenants/state-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBtwContextDigest, handleBtwRoutes, type BtwRouteContext } from "./btw.js";
import { FakeTenantStore, ctxA } from "../../workspace/fake-tenant-store.js";
import { setRequestTenant } from "../../tenants/http.js";
import type { TenantStore } from "../../tenants/store.js";

const SESSION = "durable-1";

interface StubService {
	get: ReturnType<typeof vi.fn>;
	snapshot: ReturnType<typeof vi.fn>;
	completeSideQuestion: ReturnType<typeof vi.fn>;
	appendAssistantNotification: ReturnType<typeof vi.fn>;
}

const tenantStore = new FakeTenantStore();
function fakeReq(payload: unknown): HttpReq & PassThrough {
	const stream = new PassThrough() as HttpReq & PassThrough;
	stream.headers = {};
	stream.end(JSON.stringify(payload));
	setRequestTenant(stream, ctxA, tenantStore as unknown as TenantStore);
	return stream;
}

function fakeRes(): ServerResponse & { statusCode: number; body: () => unknown } {
	let body = "";
	const res = {
		statusCode: 0,
		writeHead(status: number) {
			res.statusCode = status;
			return res;
		},
		end(chunk?: string) {
			body = chunk ?? "";
			return res;
		},
		body: () => (body ? JSON.parse(body) : undefined),
	} as unknown as ServerResponse & { statusCode: number; body: () => unknown };
	return res;
}

let dataDir: string;
let service: StubService;
let ctx: BtwRouteContext;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "btw-routes-"));
	service = {
		get: vi.fn((_req: unknown, id: string) => (id === SESSION ? { id } : undefined)),
		snapshot: vi.fn(async () => ({
			messages: [
				{ role: "user", content: "什么是闭包？" },
				{ role: "assistant", content: "闭包是能记住外层作用域的函数。" },
			],
		})),
		completeSideQuestion: vi.fn(),
		appendAssistantNotification: vi.fn(async () => undefined),
	};
	ctx = { stateKv: new FileStateKv(dataDir), durableSessions: service as never, tenantStore: tenantStore as unknown as TenantStore };
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("buildBtwContextDigest", () => {
	it("keeps recent user/assistant messages with role labels", () => {
		const digest = buildBtwContextDigest([
			{ role: "user", content: "问题一" },
			{ role: "assistant", content: "回答一" },
			{ role: "system", content: "系统提示" },
			{ role: "user", content: "  " },
		] as never);
		expect(digest).toContain("学生: 问题一");
		expect(digest).toContain("助教: 回答一");
		expect(digest).not.toContain("系统提示");
		expect(digest).toContain("只读参考");
	});

	it("samples only the most recent messages and truncates long ones", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const digest = buildBtwContextDigest(messages as never);
		expect(digest).not.toContain("m0");
		expect(digest).not.toContain("m7");
		expect(digest).toContain("m8");
		expect(digest).toContain("m19");

		const long = buildBtwContextDigest([{ role: "assistant", content: "x".repeat(2000) }] as never);
		expect(long).toContain(`${"x".repeat(800)}…`);
		expect(long).not.toContain("x".repeat(801));
	});

	it("returns an empty digest when there is nothing to sample", () => {
		expect(buildBtwContextDigest([])).toBe("");
	});
});

describe("handleBtwRoutes /api/btw/ask", () => {
	it("loads and saves per-session side-question state", async () => {
		const initial = fakeRes();
		await handleBtwRoutes(fakeReq({}), initial as ServerResponse, "GET", `/api/btw/state/${SESSION}`, ctx);
		expect(initial.statusCode).toBe(200);
		expect(initial.body()).toMatchObject({ session: { tabs: [] } });

		const state = {
			session: {
				nextTabNumber: 2,
				activeTabId: "tab-1",
				tabs: [{ id: "tab-1", number: 1, draft: "草稿", scrollTop: 3, exchanges: [] }],
			},
			window: { x: 12, y: 16, width: 520, height: 420 },
			windowInitialized: true,
			minimized: false,
		};
		const saved = fakeRes();
		await handleBtwRoutes(fakeReq(state), saved as ServerResponse, "PUT", `/api/btw/state/${SESSION}`, ctx);
		expect(saved.statusCode).toBe(200);
		expect(saved.body()).toEqual(state);

		const loaded = fakeRes();
		await handleBtwRoutes(fakeReq({}), loaded as ServerResponse, "GET", `/api/btw/state/${SESSION}`, ctx);
		expect(loaded.body()).toEqual(state);
	});

	it("rejects malformed state payloads", async () => {
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ session: {}, window: {} }), res as ServerResponse, "PUT", `/api/btw/state/${SESSION}`, ctx);
		expect(res.statusCode).toBe(400);
	});

	it("answers a side question with the digest and thread", async () => {
		service.completeSideQuestion.mockResolvedValue("词法作用域决定的。");
		const res = fakeRes();
		const handled = await handleBtwRoutes(fakeReq({
			sessionId: SESSION,
			question: "那自由变量呢？",
			thread: [{ question: "什么是闭包？", answer: "闭包是…" }],
		}), res as ServerResponse, "POST", "/api/btw/ask", ctx);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(res.body()).toEqual({ answer: "词法作用域决定的。" });
		const [, sessionId, input] = service.completeSideQuestion.mock.calls[0]!;
		expect(sessionId).toBe(SESSION);
		expect(input.question).toBe("那自由变量呢？");
		expect(input.thread).toEqual([{ question: "什么是闭包？", answer: "闭包是…" }]);
		expect(input.contextDigest).toContain("什么是闭包？");
		expect(input.signal).toBeInstanceOf(AbortSignal);
	});

	it("does not write a response after the client aborts", async () => {
		service.completeSideQuestion.mockImplementation((_req, _id, { signal }) => new Promise<string>((resolve) => {
			signal?.addEventListener("abort", () => resolve(""), { once: true });
		}));
		const req = fakeReq({ sessionId: SESSION, question: "q" });
		const res = fakeRes();
		const handled = handleBtwRoutes(req, res as ServerResponse, "POST", "/api/btw/ask", ctx);
		await vi.waitFor(() => expect(service.completeSideQuestion).toHaveBeenCalled());
		req.emit("aborted");
		await expect(handled).resolves.toBe(true);
		expect(res.statusCode).toBe(0);
	});

	it("rejects malformed bodies with 400", async () => {
		for (const payload of [
			{},
			{ sessionId: SESSION },
			{ sessionId: SESSION, question: "   " },
			{ sessionId: SESSION, question: "q", thread: "nope" },
			{ sessionId: SESSION, question: "q", thread: [{ question: "q" }] },
			{ sessionId: SESSION, question: "x".repeat(4001) },
		]) {
			const res = fakeRes();
			await handleBtwRoutes(fakeReq(payload), res as ServerResponse, "POST", "/api/btw/ask", ctx);
			expect(res.statusCode).toBe(400);
		}
		expect(service.completeSideQuestion).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown session", async () => {
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ sessionId: "missing", question: "q" }), res as ServerResponse, "POST", "/api/btw/ask", ctx);
		expect(res.statusCode).toBe(404);
		expect(service.completeSideQuestion).not.toHaveBeenCalled();
	});

	it("returns 502 when the side completion fails", async () => {
		service.completeSideQuestion.mockResolvedValue("");
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ sessionId: SESSION, question: "q" }), res as ServerResponse, "POST", "/api/btw/ask", ctx);
		expect(res.statusCode).toBe(502);
	});
});

describe("handleBtwRoutes /api/btw/bring-back", () => {
	const body = { sessionId: SESSION, question: "什么是闭包？", answer: "闭包是…", clientRequestId: "btw-exchange-1" };

	it("appends the confirmed Q/A to the session history with a stable request ID", async () => {
		const req = fakeReq(body);
		const res = fakeRes();
		await handleBtwRoutes(req, res as ServerResponse, "POST", "/api/btw/bring-back", ctx);
		expect(res.statusCode).toBe(200);
		expect(res.body()).toEqual({ ok: true });
		const [, id, text, requestId] = service.appendAssistantNotification.mock.calls[0]!;
		expect(id).toBe(SESSION);
		expect(requestId).toBe("btw-exchange-1");
		expect(text).toContain("📌 旁注问答");
		expect(text).toContain("Q: 什么是闭包？");
		expect(text).toContain("A: 闭包是…");
	});

	it("requires a request ID before writing history", async () => {
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ sessionId: SESSION, question: "q", answer: "a" }), res as ServerResponse, "POST", "/api/btw/bring-back", ctx);
		expect(res.statusCode).toBe(400);
		expect(service.appendAssistantNotification).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown session", async () => {
		const res = fakeRes();
		await handleBtwRoutes(fakeReq({ ...body, sessionId: "missing" }), res as ServerResponse, "POST", "/api/btw/bring-back", ctx);
		expect(res.statusCode).toBe(404);
		expect(service.appendAssistantNotification).not.toHaveBeenCalled();
	});

	it("returns 500 when the append fails", async () => {
		service.appendAssistantNotification.mockRejectedValue(new Error("storage busy"));
		const res = fakeRes();
		await handleBtwRoutes(fakeReq(body), res as ServerResponse, "POST", "/api/btw/bring-back", ctx);
		expect(res.statusCode).toBe(500);
	});

	it("ignores unrelated routes", async () => {
		const res = fakeRes();
		expect(await handleBtwRoutes(fakeReq({}), res as ServerResponse, "GET", "/api/btw/ask", ctx)).toBe(false);
		expect(await handleBtwRoutes(fakeReq({}), res as ServerResponse, "POST", "/api/other", ctx)).toBe(false);
	});
});
