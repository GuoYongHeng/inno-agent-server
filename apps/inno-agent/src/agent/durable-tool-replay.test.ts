import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type ModelRef, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDirSandbox } from "../sandbox/local-backend.js";
import type { SandboxRuntimeBinding } from "../sandbox/sandbox-session.js";
import { durableEntriesToMessages } from "./durable-projection.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const FIXTURE = fileURLToPath(new URL("./durable-tool-replay-fixture.ts", import.meta.url));
const INTERRUPTED = "interrupted";

interface FauxRuntime {
	faux: FauxProviderHandle;
	models: Models;
	model: ModelRef;
}

function fauxRuntime(): FauxRuntime {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		models,
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
	};
}

function waitForOutput(child: ChildProcess, marker: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}; stdout=${stdout}; stderr=${stderr}`)), 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes(marker)) {
				clearTimeout(timeout);
				resolve(stdout);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			if (stdout.includes(marker)) {
				clearTimeout(timeout);
				resolve(stdout);
			} else {
				clearTimeout(timeout);
				reject(new Error(`Crash fixture exited ${code}; stdout=${stdout}; stderr=${stderr}`));
			}
		});
	});
}

const tempRoots: string[] = [];
const openRuntimes: DurableSessionRuntime[] = [];
const children = new Set<ChildProcess>();

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "inno-tool-replay-"));
	tempRoots.push(root);
	return root;
}

function spawnFixture(storagePath: string, mode: string, workDir: string): ChildProcess {
	const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, storagePath, mode, workDir], {
		cwd: process.cwd(),
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

async function open(options: Parameters<typeof DurableSessionRuntime.open>[0]): Promise<DurableSessionRuntime> {
	const runtime = await DurableSessionRuntime.open(options);
	openRuntimes.push(runtime);
	return runtime;
}

function sandboxBinding(root: string): SandboxRuntimeBinding {
	mkdirSync(root, { recursive: true });
	return {
		backend: new LocalDirSandbox("tool-replay-sandbox", root),
		remoteRoot: "/",
		requireApproval: false,
		commandTimeoutSeconds: 60,
		beforeTurn: async () => undefined,
		pullToHost: async () => undefined,
		release: async () => undefined,
		rebasePaths: (text) => text,
		promptSection: "",
	};
}

/** Test-side counterpart of the fixture's counter tool: appends, then reports. */
function counterTool(counterPath: string, replay: "safe" | "unsafe", executions: { count: number }): ToolRegistration {
	return defineTool({
		name: "crash_counter",
		description: "Appends a line to the counter file, then reports success.",
		parameters: Type.Object({}),
		replay,
		async execute() {
			executions.count += 1;
			appendFileSync(counterPath, "hit\n");
			return { output: [{ type: "text", text: "counter-tool-ran-again" }] };
		},
	});
}

function counterLines(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
}

/** The assistant message's tool record carrying the settled result, if any. */
function toolResultFor(messages: ReturnType<typeof durableEntriesToMessages>, toolCallId: string) {
	for (const message of messages) {
		const tool = message.tools?.find((call) => call.toolCallId === toolCallId);
		if (tool) return tool;
	}
	return undefined;
}

function resultText(result: unknown): string {
	return JSON.stringify(result);
}

afterEach(async () => {
	await Promise.all(openRuntimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)));
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable tool-call recovery after SIGKILL", () => {
	it("does not re-run the built-in bash tool and reports an interrupted error result", async () => {
		const root = tempRoot();
		const workDir = join(root, "work");
		mkdirSync(workDir, { recursive: true });
		const sandboxRoot = join(workDir, "sandbox-root");
		const counterPath = join(sandboxRoot, "counter.txt");
		const storagePath = join(root, "crash.sqlite");

		const child = spawnFixture(storagePath, "bash", workDir);
		const output = await waitForOutput(child, "counter-written");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		expect(Number.isInteger(submissionId)).toBe(true);
		child.kill("SIGKILL");
		await once(child, "exit");
		children.delete(child);
		// The command appended once, echoed partial output, then slept mid-call.
		expect(counterLines(counterPath)).toHaveLength(1);

		let secondRequestContext: unknown;
		const provider = fauxRuntime();
		provider.faux.setResponses([(context) => {
			secondRequestContext = context;
			return fauxAssistantMessage("recovered after crash");
		}]);
		const runtime = await open({
			storagePath,
			workspaceTools: true,
			sandbox: sandboxBinding(sandboxRoot),
			...provider,
		});
		const recovered = await runtime.waitForSubmission(submissionId);
		expect(recovered).toMatchObject({ status: "done", text: "recovered after crash" });
		// Exactly-once: the sleeping command was never re-executed.
		expect(counterLines(counterPath)).toHaveLength(1);

		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const tool = toolResultFor(messages, "bash-call-1");
		expect(tool).toMatchObject({ toolName: "bash", isError: true });
		expect(resultText(tool?.result)).toContain(INTERRUPTED);
		// Output committed before the kill is preserved in the error result.
		expect(resultText(tool?.result)).toContain("partial-out");
		// The next model request sees the same interrupted tool result.
		expect(JSON.stringify(secondRequestContext)).toContain(INTERRUPTED);
		expect(provider.faux.state.callCount).toBe(1);
	}, 30_000);

	it("does not re-run an unsafe custom tool after it killed the process", async () => {
		const root = tempRoot();
		const workDir = join(root, "work");
		mkdirSync(workDir, { recursive: true });
		const counterPath = join(workDir, "counter.txt");
		const storagePath = join(root, "crash.sqlite");

		const child = spawnFixture(storagePath, "unsafe", workDir);
		const output = await waitForOutput(child, "submission:");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		expect(Number.isInteger(submissionId)).toBe(true);
		await once(child, "exit"); // the tool SIGKILLs itself inside execute()
		children.delete(child);
		expect(counterLines(counterPath)).toHaveLength(1);

		let secondRequestContext: unknown;
		const provider = fauxRuntime();
		provider.faux.setResponses([(context) => {
			secondRequestContext = context;
			return fauxAssistantMessage("recovered after crash");
		}]);
		const executions = { count: 0 };
		const runtime = await open({
			storagePath,
			extraTools: [counterTool(counterPath, "unsafe", executions)],
			...provider,
		});
		const recovered = await runtime.waitForSubmission(submissionId);
		expect(recovered).toMatchObject({ status: "done", text: "recovered after crash" });
		expect(executions.count).toBe(0);
		expect(counterLines(counterPath)).toHaveLength(1);

		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const tool = toolResultFor(messages, "counter-call-1");
		expect(tool).toMatchObject({ toolName: "crash_counter", isError: true });
		expect(resultText(tool?.result)).toContain(INTERRUPTED);
		expect(JSON.stringify(secondRequestContext)).toContain(INTERRUPTED);
		expect(provider.faux.state.callCount).toBe(1);
	}, 30_000);

	it("re-runs a replay-safe custom tool after it killed the process", async () => {
		const root = tempRoot();
		const workDir = join(root, "work");
		mkdirSync(workDir, { recursive: true });
		const counterPath = join(workDir, "counter.txt");
		const storagePath = join(root, "crash.sqlite");

		const child = spawnFixture(storagePath, "safe", workDir);
		const output = await waitForOutput(child, "submission:");
		const submissionId = Number(/submission:(\d+)/.exec(output)?.[1]) as SubmissionId;
		expect(Number.isInteger(submissionId)).toBe(true);
		await once(child, "exit");
		children.delete(child);
		expect(counterLines(counterPath)).toHaveLength(1);

		const provider = fauxRuntime();
		provider.faux.setResponses([fauxAssistantMessage("recovered after crash")]);
		const executions = { count: 0 };
		const runtime = await open({
			storagePath,
			extraTools: [counterTool(counterPath, "safe", executions)],
			...provider,
		});
		const recovered = await runtime.waitForSubmission(submissionId);
		expect(recovered).toMatchObject({ status: "done", text: "recovered after crash" });
		// The safe replay re-executed the tool in the recovering process.
		expect(executions.count).toBe(1);
		expect(counterLines(counterPath)).toHaveLength(2);

		const messages = durableEntriesToMessages((await runtime.snapshot()).entries);
		const tool = toolResultFor(messages, "counter-call-1");
		expect(tool).toMatchObject({ toolName: "crash_counter", isError: false });
		expect(resultText(tool?.result)).toContain("counter-tool-ran-again");
		expect(provider.faux.state.callCount).toBe(1);
	}, 30_000);
});
