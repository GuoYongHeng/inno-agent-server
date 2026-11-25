import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Privacy tests for the LLM fetch logger (issue #162): by default, request
 * and response bodies must NOT be written to the log file — only metadata.
 * LOG_LLM_BODY=1 opts back into (truncated) body logging.
 *
 * The logger writes to process.stdout, so this file spies on it to capture
 * its own output.
 * installFetchLogger wraps globalThis.fetch for the whole test process, so
 * every fetch below goes through the wrapper.
 */

const SECRET_MARKER = "sk-super-secret-prompt-content";

let captured = "";
let stdoutSpy: { mockRestore(): void };
let server: Server;
let baseUrl: string;

function readLog(): string {
	return captured;
}

async function waitForLog(predicate: (log: string) => boolean): Promise<string> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const log = readLog();
		if (predicate(log)) return log;
		await new Promise((r) => setTimeout(r, 50));
	}
	return readLog();
}

beforeAll(async () => {
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
		const cb = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
		cb?.();
		return true;
	}) as typeof process.stdout.write);
	process.env.LOG_LEVEL = "info";
	delete process.env.LOG_LLM_BODY;

	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, echo: SECRET_MARKER }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const { installFetchLogger } = await import("./fetch-logger.js");
	installFetchLogger();
});

afterAll(async () => {
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	stdoutSpy.mockRestore();
});

describe("fetch logger privacy", () => {
	it("logs metadata only by default — no request/response bodies", async () => {
		await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: SECRET_MARKER }] }),
		});

		const log = await waitForLog((l) => l.includes("RESP"));
		expect(log).toContain("REQ →");
		expect(log).toContain("RESP ← 200");
		expect(log).not.toContain(SECRET_MARKER);
		// Quoted field names — requestBodyBytes/responseBodyBytes are allowed.
		expect(log).not.toContain('"requestBody"');
		expect(log).not.toContain('"responseBody"');
	});

	it("logs truncated bodies when LOG_LLM_BODY=1", async () => {
		process.env.LOG_LLM_BODY = "1";
		try {
			await fetch(`${baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messages: [{ role: "user", content: SECRET_MARKER }] }),
			});

			const log = await waitForLog((l) => (l.match(/RESP ←/g) ?? []).length >= 2);
			expect(log).toContain(SECRET_MARKER);
		} finally {
			delete process.env.LOG_LLM_BODY;
		}
	});
});
