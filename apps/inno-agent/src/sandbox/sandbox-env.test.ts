import { afterAll, describe, expect, it } from "vitest";
import { createEnvConformance, createExpectAssertions } from "@earendil-works/pi-durable/testing";
import { LocalDirSandboxProvider } from "./local-backend.js";
import { SandboxExecutionEnv } from "./sandbox-env.js";

const provider = new LocalDirSandboxProvider();
afterAll(() => provider.dispose());

/**
 * pi-durable's own contract for ExecutionEnv implementations, run against the
 * adapter over a directory-backed test double. Directory watching is skipped:
 * nothing in the harness or this app calls `env.watch`, and the sandbox
 * environment reports it as not supported.
 */
describe("SandboxExecutionEnv over LocalDirSandbox (ExecutionEnv conformance)", () => {
	const cases = createEnvConformance({
		assertions: createExpectAssertions(expect as never),
		withEnv: async (use) => {
			const backend = await provider.create();
			try {
				await backend.makeDir("/workspace");
				await use(new SandboxExecutionEnv(backend, "/workspace"));
			} finally {
				await backend.kill();
			}
		},
		symlinks: false,
		listFiles: false,
	});
	for (const testCase of cases.filter((candidate) => !candidate.name.startsWith("watch"))) {
		it(testCase.name, () => testCase.run(), testCase.timeoutMs);
	}
});
