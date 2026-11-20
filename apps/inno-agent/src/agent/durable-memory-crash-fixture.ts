import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { DurableSessionRuntime } from "./durable-runtime.js";

const storagePath = process.argv[2];
const dataRoot = process.argv[3];
if (!storagePath || !dataRoot) throw new Error("storage path and data root are required");

const l2DataDir = join(dataRoot, "l2");
const sessionId = "durable-crash-memory";

// The real l2_archive, killed right after it wrote its records and before the
// tool result is committed: the worst moment for a replay-safe tool.
const realArchive = createL2Tools(l2DataDir, () => true, undefined, () => dataRoot, true, true)
	.find((tool) => tool.name === "l2_archive");
if (!realArchive) throw new Error("l2_archive is not registered");
const crashingArchive = {
	...realArchive,
	replay: "safe" as const,
	async execute(...args: Parameters<typeof realArchive.execute>) {
		await realArchive.execute(...args);
		console.log("archived-before-commit");
		process.kill(process.pid, "SIGKILL");
		return { output: [{ type: "text" as const, text: "unreachable" }] };
	},
};
const registry = createRegistry();
registry.install(defineExtension({ name: "inno.memory", tools: [crashingArchive] }));

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("l2_archive", {
		title: "力的分解",
		content: "把一个力分解成两个相互垂直的分力，便于分别计算。",
		sourceType: "text",
	}, { id: "crash-memory-archive" }), { stopReason: "toolUse" }),
]);

const runtime = await DurableSessionRuntime.open({
	storagePath,
	models,
	model: { provider: faux.provider.id, modelId: faux.getModel().id },
	registry,
	memory: { sessionId, l2DataDir, workspaceDir: dataRoot, l2Enabled: true },
});
const submission = await runtime.submit("archive before crashing", "memory-crash-request");
console.log(`submission:${submission.id}`);
await runtime.waitForSubmission(submission.id);
