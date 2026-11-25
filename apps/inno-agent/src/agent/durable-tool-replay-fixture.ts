import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { LocalDirSandbox } from "../sandbox/local-backend.js";
import type { SandboxRuntimeBinding } from "../sandbox/sandbox-session.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const [storagePath, mode, workDir] = process.argv.slice(2);
if (!storagePath || !workDir) throw new Error("usage: fixture <storagePath> <bash|unsafe|safe> <workDir>");
if (mode !== "bash" && mode !== "unsafe" && mode !== "safe") throw new Error(`unknown mode ${mode}`);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

let sandbox: SandboxRuntimeBinding | undefined;
let counterPath = join(workDir, "counter.txt");

if (mode === "bash") {
	const sandboxRoot = join(workDir, "sandbox-root");
	mkdirSync(sandboxRoot, { recursive: true });
	counterPath = join(sandboxRoot, "counter.txt");
	const backend = new LocalDirSandbox("tool-replay-sandbox", sandboxRoot);
	sandbox = {
		backend,
		remoteRoot: "/",
		requireApproval: false,
		commandTimeoutSeconds: 60,
		beforeTurn: async () => undefined,
		pullToHost: async () => undefined,
		release: async () => undefined,
		rebasePaths: (text) => text,
		promptSection: "",
	};
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: "printf 'hit\\n' >> counter.txt; echo partial-out; sleep 10",
			}, { id: "bash-call-1" }),
			{ stopReason: "toolUse" },
		),
	]);
} else {
	const tool = defineTool({
		name: "crash_counter",
		description: "Appends a line to the counter file, then crashes the process.",
		parameters: Type.Object({}),
		...(mode === "safe" ? { replay: "safe" as const } : {}),
		async execute() {
			appendFileSync(counterPath, "hit\n");
			process.kill(process.pid, "SIGKILL");
			return { output: [{ type: "text", text: "unreachable" }] };
		},
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("crash_counter", {}, { id: "counter-call-1" }), { stopReason: "toolUse" }),
	]);
	var extraTools = [tool];
}

const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	workspaceTools: mode === "bash",
	sandbox,
	extraTools: mode === "bash" ? [] : extraTools!,
});

const submission = await runtime.submit("run the crashing tool", "replay-request");
console.log(`submission:${submission.id}`);

// The bash command stays in-flight in `sleep 10`; announce once its counter line
// exists, delayed so the tool's streaming output commits "partial-out" first.
if (mode === "bash") {
	const timer = setInterval(() => {
		if (existsSync(counterPath) && readFileSync(counterPath, "utf8").trim().length > 0) {
			clearInterval(timer);
			setTimeout(() => console.log("counter-written"), 500);
		}
	}, 25);
}

await runtime.waitForSubmission(submission.id);
