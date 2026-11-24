import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DURABLE_JOB_BUSY_WAIT_MS, runDurableJobPrompt } from "./durable-job-runner.js";
import { DurableSessionBusyError, type DurableSessionService } from "./durable-session-service.js";

function fixture(overrides: { pending?: boolean } = {}) {
	const binding = vi.fn();
	const permissionBinding = vi.fn();
	const submit = vi.fn(async () => ({ id: "submission-1" }));
	const stop = vi.fn(async () => undefined);
	const watch = vi.fn(async (callback: (events: any[]) => Promise<void>) => {
		await callback([{ type: "message_update", changes: [{ type: "text_delta", delta: "durable", contentIndex: 0 }] }]);
		return { stop };
	});
	const release = vi.fn(async () => undefined);
	const runtime = {
		bindQuestionTurn: binding,
		unbindQuestionTurn: vi.fn(),
		bindPermissionTurn: permissionBinding,
		unbindPermissionTurn: vi.fn(),
		watch,
		submit,
		waitForSubmission: vi.fn(async () => ({ status: "done", text: "durable answer" })),
	};
	const service = {
		pendingQuestion: vi.fn(() => overrides.pending ? { questionId: "pending" } : undefined),
		pendingPermission: vi.fn(() => undefined),
		prepareImages: vi.fn(() => null),
		recordTurnMetadata: vi.fn(),
		prepareRecallContext: vi.fn(async () => "recalled context"),
		lease: vi.fn(async () => ({ runtime, release })),
		noteSubmission: vi.fn(),
		snapshot: vi.fn(async () => ({})),
		maybeAutoGenerateTopic: vi.fn(async () => undefined),
	};
	return { service: service as unknown as DurableSessionService, binding, permissionBinding, submit, stop, watch, release };
}

const req = {} as IncomingMessage;

describe("runDurableJobPrompt", () => {
	it("uses no_ui for headless runs and commits recall with the raw prompt", async () => {
		const { service, binding, permissionBinding, submit, watch, release } = fixture();
		await expect(runDurableJobPrompt(req, service, "durable-session", "scheduled prompt", {
			requestId: "job-request", turnId: "job-turn",
		})).resolves.toBe("durable answer");
		expect(binding).toHaveBeenCalledWith({ turnId: "job-turn", noUi: true });
		expect(permissionBinding).toHaveBeenCalledWith({ turnId: "job-turn", noUi: true });
		expect(watch).not.toHaveBeenCalled();
		expect(submit).toHaveBeenCalledWith([
			{ type: "text", text: "scheduled prompt" },
			{ type: "text", text: "recalled context" },
		], "job-request");
		expect(release).toHaveBeenCalledOnce();
	});

	it("projects live events and binds streaming questions to the job turn", async () => {
		const { service, binding, permissionBinding, watch, stop } = fixture();
		const onEvent = vi.fn();
		await expect(runDurableJobPrompt(req, service, "durable-session", "stream prompt", {
			requestId: "job-request", turnId: "job-turn", onEvent,
		})).resolves.toBe("durable answer");
		expect(binding).toHaveBeenCalledWith({ turnId: "job-turn", emit: onEvent });
		expect(permissionBinding).toHaveBeenCalledWith({ turnId: "job-turn", emit: onEvent });
		expect(watch).toHaveBeenCalledOnce();
		expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "durable", contentIndex: 0 });
		expect(stop).toHaveBeenCalledOnce();
	});

	it("keeps streaming channel runs no_ui even while projecting events", async () => {
		const { service, binding, permissionBinding } = fixture();
		const onEvent = vi.fn();
		await runDurableJobPrompt(req, service, "durable-session", "channel prompt", {
			requestId: "channel-request", turnId: "channel-turn", onEvent, noUi: true,
		});
		expect(binding).toHaveBeenCalledWith({ turnId: "channel-turn", emit: onEvent, noUi: true });
		expect(permissionBinding).toHaveBeenCalledWith({ turnId: "channel-turn", emit: onEvent, noUi: true });
	});

	it.each([{ native: true }, { native: false }])("prepares channel images with native=$native and restores their sidecar metadata", async ({ native }) => {
		const { service, submit } = fixture();
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const prepared = {
			nativeImages: native ? [image] : [],
			images: [{ mimeType: "image/png", workspacePath: ".chat-images/channel.png" }],
			fallbackContext: "Image path hints",
			workspaceId: "workspace-1",
			workspaceRoot: "/tmp/workspace-1",
		};
		vi.mocked(service.prepareImages).mockResolvedValue(prepared);

		await runDurableJobPrompt(req, service, "durable-session", "describe this", {
			requestId: "channel-request", turnId: "channel-turn", images: [image], noUi: true,
		});

		expect(service.prepareImages).toHaveBeenCalledWith(req, "durable-session", [image], "channel-request");
		expect(service.recordTurnMetadata).toHaveBeenCalledWith(req, "durable-session", null, prepared, "describe this", "channel-request");
		expect(submit).toHaveBeenCalledWith([
			{ type: "text", text: "describe this" },
			...(native ? [image] : []),
			{ type: "text", text: "Image path hints" },
			{ type: "text", text: "recalled context" },
		], "channel-request");
	});

	it("leases with the default busy wait and honors a per-call override", async () => {
		const { service } = fixture();
		await runDurableJobPrompt(req, service, "durable-session", "prompt", {
			requestId: "job-request", turnId: "job-turn",
		});
		expect(service.lease).toHaveBeenCalledWith(req, "durable-session", { busyWaitMs: DURABLE_JOB_BUSY_WAIT_MS });
		await runDurableJobPrompt(req, service, "durable-session", "prompt", {
			requestId: "job-request-2", turnId: "job-turn-2", busyWaitMs: 42,
		});
		expect(service.lease).toHaveBeenLastCalledWith(req, "durable-session", { busyWaitMs: 42 });
	});

	it("rejects a pending question before opening a headless run", async () => {
		const { service } = fixture({ pending: true });
		await expect(runDurableJobPrompt(req, service, "durable-session", "prompt", {
			requestId: "job-request", turnId: "job-turn",
		})).rejects.toThrow("pending question");
		expect(service.lease).not.toHaveBeenCalled();
	});

	it("forwards to the owner worker when the lease stays busy", async () => {
		const { service } = fixture();
		service.lease = vi.fn(async () => { throw new DurableSessionBusyError(); });
		const forwardToOwner = vi.fn(async () => "forwarded answer");
		await expect(runDurableJobPrompt(req, service, "durable-session", "job prompt", {
			requestId: "job-request", turnId: "job-turn", forwardToOwner,
		})).resolves.toBe("forwarded answer");
		expect(forwardToOwner).toHaveBeenCalledWith({
			sessionId: "durable-session", prompt: "job prompt",
			requestId: "job-request", turnId: "job-turn",
		});
	});

	it("rethrows busy when forwarding is impossible and never forwards image prompts", async () => {
		const { service } = fixture();
		service.lease = vi.fn(async () => { throw new DurableSessionBusyError(); });
		const forwardToOwner = vi.fn(async () => null);
		await expect(runDurableJobPrompt(req, service, "durable-session", "job prompt", {
			requestId: "job-request", turnId: "job-turn", forwardToOwner,
		})).rejects.toThrow(DurableSessionBusyError);
		await expect(runDurableJobPrompt(req, service, "durable-session", "image prompt", {
			requestId: "job-request", turnId: "job-turn", forwardToOwner,
			images: [{ type: "image", data: "a", mimeType: "image/png" } as never],
		})).rejects.toThrow(DurableSessionBusyError);
		expect(forwardToOwner).toHaveBeenCalledOnce();
	});
});
