import { describe, expect, it } from "vitest";
import { createEnvConformance, createExpectAssertions } from "@earendil-works/pi-durable/testing";
import { E2BSandboxProvider } from "./e2b-backend.js";
import { SandboxRunError } from "./sandbox-backend.js";
import { SandboxExecutionEnv } from "./sandbox-env.js";

/**
 * Runs against the real E2B cloud, so it needs an account and creates (and
 * destroys) sandboxes. Skipped unless E2B_API_KEY is set:
 *   E2B_API_KEY=... npm run test:integration -- e2b-live
 */
const apiKey = process.env.E2B_API_KEY?.trim();
const live = apiKey ? describe : describe.skip;

live("E2B cloud sandbox", () => {
	const provider = new E2BSandboxProvider({ apiKey, timeoutMs: 5 * 60_000, defaultCommandTimeoutMs: 60_000 });

	it("creates, runs commands, reports exit codes and timeouts, pauses, resumes and destroys", async () => {
		const sandbox = await provider.create({ metadata: { app: "inno-agent-live-test" } });
		try {
			let out = "";
			expect(await sandbox.run("echo hello && echo oops 1>&2", { onStdout: (d) => { out += d; } })).toEqual({ exitCode: 0 });
			expect(out).toContain("hello");
			expect((await sandbox.run("exit 3")).exitCode).toBe(3);
			await expect(sandbox.run("sleep 30", { timeoutMs: 1_500 })).rejects.toMatchObject({ code: "timeout" });
			const abort = new AbortController();
			const pending = sandbox.run("sleep 30", { signal: abort.signal });
			setTimeout(() => abort.abort(), 1_000);
			await expect(pending).rejects.toBeInstanceOf(SandboxRunError);

			await sandbox.writeFile("/home/user/live/a.txt", "persisted");
			await sandbox.pause();
			const resumed = await provider.connect(sandbox.id);
			expect(resumed).not.toBeNull();
			expect(new TextDecoder().decode(await resumed!.readFile("/home/user/live/a.txt"))).toBe("persisted");
		} finally {
			await provider.destroy(sandbox.id);
		}
		expect(await provider.connect(sandbox.id)).toBeNull();
	}, 180_000);

	// pi-durable's ExecutionEnv contract against the real service. Watching is not offered.
	it("satisfies the ExecutionEnv conformance cases", async () => {
		const cases = createEnvConformance({
			assertions: createExpectAssertions(expect as never),
			withEnv: async (use) => {
				const sandbox = await provider.create({ metadata: { app: "inno-agent-live-test" } });
				try {
					await sandbox.makeDir("/home/user/conformance");
					await use(new SandboxExecutionEnv(sandbox, "/home/user/conformance"));
				} finally {
					await provider.destroy(sandbox.id);
				}
			},
			symlinks: false,
			listFiles: false,
		});
		for (const testCase of cases.filter((candidate) => !candidate.name.startsWith("watch"))) {
			await testCase.run();
		}
	}, 900_000);
});
