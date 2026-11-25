import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DurableSessionRuntime } from "./durable-runtime.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function probeTool(name: string): ToolRegistration {
	return defineTool({
		name,
		description: `${name} probe`,
		parameters: Type.Object({}),
		async execute() {
			return { output: [{ type: "text" as const, text: "ok" }] };
		},
	});
}

/** Tools announced to the model so far, read from the transcript's system entries (they accumulate). */
async function offeredTools(storagePath: string, extraTools: ToolRegistration[], conversationId?: string) {
	const seen: string[][] = [];
	const faux = fauxProvider();
	faux.setResponses([(context) => {
		// The tools offered to the model are announced in the transcript's system entries.
		const messages = (context as unknown as { messages: Array<{ role: string; toolsAdded?: Array<{ name: string }> }> }).messages;
		seen.push(messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name));
		return fauxAssistantMessage("done");
	}]);
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await DurableSessionRuntime.open({
		storagePath,
		models,
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
		workspaceTools: true,
		extraTools,
		...(conversationId ? { conversationId } : {}),
	});
	try {
		const submission = await runtime.submit("hello", `req-${Math.random()}`);
		await runtime.waitForSubmission(submission.id);
		return { names: seen[0] ?? [], conversationId: runtime.conversationId };
	} finally {
		await runtime.close();
	}
}

describe("tools of an existing durable session", () => {
	it("offers newly registered tools when the session is reopened", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-tools-reopen-"));
		roots.push(root);
		const storagePath = join(root, "session.sqlite");

		const first = await offeredTools(storagePath, []);
		expect(first.names).toEqual(expect.arrayContaining(["read", "write", "edit"]));
		expect(first.names).not.toContain("probe_new");

		// The session already exists; a newer build registers one more tool.
		const second = await offeredTools(storagePath, [probeTool("probe_new")]);
		expect(second.names).toContain("probe_new");
	});

	it("applies the same refresh to a forked conversation after edit-and-resend", async () => {
		const root = mkdtempSync(join(tmpdir(), "inno-tools-fork-"));
		roots.push(root);
		const storagePath = join(root, "session.sqlite");
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const model = { provider: faux.provider.id, modelId: faux.getModel().id };
		const runtime = await DurableSessionRuntime.open({ storagePath, models, model, workspaceTools: true });
		await runtime.waitForSubmission((await runtime.submit("first", "r1")).id);
		await runtime.waitForSubmission((await runtime.submit("second", "r2")).id);
		const snapshot = await runtime.snapshot();
		const secondUser = snapshot.entries.find((entry) => entry.model?.[0]?.role === "user" && JSON.stringify(entry.model[0]).includes("second"))!;
		const branched = await runtime.branchBeforeUserMessage(String(secondUser.id));
		await runtime.close();

		const reopened = await offeredTools(storagePath, [probeTool("probe_fork")], branched.conversationId);
		expect(reopened.conversationId).toBe(branched.conversationId);
		expect(reopened.names).toContain("probe_fork");
	});
});
