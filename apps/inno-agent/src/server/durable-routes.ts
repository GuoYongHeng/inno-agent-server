import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { buildDurableUserInput } from "../agent/durable-user-input.js";
import { contentDispositionAttachment } from "./file-helpers.js";
import { sessionToMarkdown } from "./session-markdown.js";
import { DurableBranchError } from "../agent/durable-runtime.js";
import { DurableModelNotFoundError, DurableRuntimeDisabledError, DurableSessionBusyError, type DurableSessionService, type DurableSessionSummary, type PreparedDurableAttachments, type PreparedDurableImages } from "../agent/durable-session-service.js";
import { DurableSseProjector } from "../agent/durable-projection.js";
import type { StreamJournal } from "../agent/durable-stream-store.js";
import type { QuestionBridgeResult } from "../agent/question-types.js";
import type { PermissionDecision } from "../agent/permission-types.js";
import {
	hasCompleteTurnAfterBaseline,
	streamRegistry,
	type ChatStreamEvent,
	type SessionStreamState,
	type StreamEventEnvelope,
} from "../chat/stream-registry.js";
import { logger } from "../logger.js";
import { releaseRequestResource, requireRequestTenant } from "../tenants/http.js";
import type { TenantStore } from "../tenants/store.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { WorkspaceReplica } from "../workspace/workspace-replica.js";
import { json, matchRoute, readBody } from "./http-helpers.js";
import { createReplicaPushGate, workspaceChangePublisher } from "./replica-push.js";
import { createWorkspaceChangeMonitor } from "./workspace-change-monitor.js";

export interface DurableHttpContext {
	service: DurableSessionService;
	workspaceRegistry: WorkspaceRegistry;
	tenantStore: TenantStore;
	workspaceReplica?: WorkspaceReplica | null;
}

function errorStatus(error: unknown): number {
	if (error instanceof DurableRuntimeDisabledError) return 503;
	if (error instanceof DurableSessionBusyError) return 409;
	return 500;
}

interface DurableStreamContext {
	state: SessionStreamState;
	store: StreamJournal;
}

const durableProjections = new Map<string, Promise<void>>();

function publishDurableEvent(context: DurableStreamContext, event: ChatStreamEvent): StreamEventEnvelope {
	const envelope = streamRegistry.publishStreamEvent(context.state, event);
	context.store.append(envelope);
	return envelope;
}

function finishDurableTurn(
	context: DurableStreamContext,
	status: "completed" | "error" | "aborted",
	event: ChatStreamEvent,
	persistence: { persisted: boolean; finalMessageCount?: number; finalSessionRevision?: string },
): StreamEventEnvelope | undefined {
	const envelope = streamRegistry.finishTurn(context.state, status, event, persistence);
	if (envelope) context.store.append(envelope);
	return envelope;
}

/** Restore before any registry lookup that follows a process restart. */
export async function restoreDurableStream(
	req: HttpReq,
	service: DurableSessionService,
	sessionId: string,
	turnId?: string,
): Promise<DurableStreamContext | undefined> {
	const store = service.streamStore(req);
	const restored = turnId ? await store.load(sessionId, turnId) : await store.latest(sessionId);
	if (!restored) return undefined;
	try {
		const state = streamRegistry.restoreTurn(restored.snapshot, restored.history, restored.cancelRequested);
		return { state, store };
	} catch (error) {
		logger.error({ err: error, sessionId, turnId: restored.snapshot.turnId }, "failed to restore durable SSE journal");
		return undefined;
	}
}

/** The original HTTP turn and every reconnect share one projection. Recovery
 * reacquires the committed submission; it never submits a synthetic user turn. */
export function ensureDurableStreamProjection(
	req: HttpReq,
	service: DurableSessionService,
	context: DurableStreamContext,
	httpCtx?: DurableHttpContext,
): Promise<void> {
	if (context.state.terminalEventPublished) return Promise.resolve();
	const existing = durableProjections.get(context.state.turnId);
	if (existing) return existing;
	const operation = streamDurableTurn(req, context, service, httpCtx).finally(() => {
		durableProjections.delete(context.state.turnId);
	});
	durableProjections.set(context.state.turnId, operation);
	return operation;
}

/** Handle only subresources whose semantics have a durable implementation.
 * Workspace subroutes return false so the existing workspace handler can run. */
export async function handleDurableSessionResourceRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	id: string,
	ctx: DurableHttpContext,
): Promise<boolean> {
	if (url.includes("/workspace")) return false;
	if (matchRoute("GET", method, url, "/api/sessions/:id/context-usage")) {
		json(res, 200, await ctx.service.contextUsage(req, id));
		return true;
	}
	if (matchRoute("GET", method, url, "/api/sessions/:id")) {
		try {
			const detail = await ctx.service.snapshot(req, id);
			json(res, 200, {
				...detail.summary,
				messages: detail.messages,
				messageCount: detail.messages.length,
				sessionRevision: detail.revision,
				...(detail.pendingQuestion ? { pendingQuestion: detail.pendingQuestion } : {}),
				...(detail.pendingPermission ? { pendingPermission: detail.pendingPermission } : {}),
			});
		} catch (error) {
			json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/generate-topic")) {
		try {
			json(res, 200, await ctx.service.generateTopic(req, id));
		} catch (error) {
			json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	if (matchRoute("PATCH", method, url, "/api/sessions/:id")) {
		const body = await readBody(req) as Record<string, unknown>;
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const provider = typeof body.provider === "string" ? body.provider.trim() : "";
		const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
		if ((provider && !modelId) || (!provider && modelId)) {
			json(res, 400, { error: "provider and modelId must be given together" });
			return true;
		}
		if (!name && !provider) { json(res, 400, { error: "Missing session topic or model" }); return true; }
		let summary: DurableSessionSummary | undefined;
		if (provider) {
			try {
				summary = await ctx.service.setModel(req, id, { provider, modelId });
			} catch (error) {
				if (error instanceof DurableModelNotFoundError) { json(res, 400, { error: error.message }); return true; }
				throw error;
			}
		}
		if (name) summary = await ctx.service.rename(req, id, name.slice(0, 120));
		json(res, 200, summary);
		return true;
	}
	if (matchRoute("GET", method, url, "/api/sessions/:id/export.md")) {
		const detail = await ctx.service.snapshot(req, id);
		const baseName = (detail.summary.name?.trim() || id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
		res.writeHead(200, {
			"Content-Type": "text/markdown; charset=utf-8",
			"Content-Disposition": contentDispositionAttachment(`${baseName}.md`),
			"Cache-Control": "no-store",
		});
		res.end(sessionToMarkdown(detail.summary, detail.messages));
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/branch-before-message")) {
		await restoreDurableStream(req, ctx.service, id);
		if (streamRegistry.getActiveForSession(id)) {
			json(res, 409, { error: "Cannot edit a message while the session is generating" });
			return true;
		}
		const body = await readBody(req) as Record<string, unknown>;
		const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
		if (!entryId) { json(res, 400, { error: "Missing message entryId" }); return true; }
		try {
			json(res, 200, await ctx.service.branchBeforeMessage(req, id, entryId));
		} catch (error) {
			if (error instanceof DurableBranchError) {
				json(res, error.code === "entry_not_found" ? 404 : 409, { error: error.message, code: error.code });
				return true;
			}
			throw error;
		}
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/activate")) {
		// Durable sessions do not switch the legacy process-global AgentSession.
		json(res, 200, { id, active: true });
		return true;
	}
	if (matchRoute("DELETE", method, url, "/api/sessions/:id")) {
		await restoreDurableStream(req, ctx.service, id);
		if (streamRegistry.getActiveForSession(id)) {
			json(res, 409, { error: "Cannot delete a session with an active chat turn" });
			return true;
		}
		try {
			await ctx.service.delete(req, id);
		} catch (error) {
			if (error instanceof DurableSessionBusyError) {
				json(res, 409, { error: error.message });
				return true;
			}
			throw error;
		}
		ctx.workspaceRegistry.unbindSession(id);
		await releaseRequestResource(req, ctx.tenantStore, "session", id);
		json(res, 200, { id, deleted: true });
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/archive")) {
		json(res, 200, await ctx.service.setArchived(req, id, true));
		return true;
	}
	if (matchRoute("POST", method, url, "/api/sessions/:id/unarchive")) {
		json(res, 200, await ctx.service.setArchived(req, id, false));
		return true;
	}
	json(res, 400, { error: "This legacy session operation is not supported for durable sessions" });
	return true;
}

function startSse(res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
}

function chatImagesAreEmbedded(raw: unknown): boolean {
	return Array.isArray(raw) && raw.some((item) => item && typeof item === "object" && typeof (item as { data?: unknown }).data === "string");
}

function durableUserInput(
	prompt: string,
	attachments: PreparedDurableAttachments | null,
	images: PreparedDurableImages | null,
	recallContext: string,
) {
	return buildDurableUserInput(prompt, {
		...(images?.vision ? { nativeImages: images.images } : {}),
		...(images?.fallbackContext ? { fallbackContext: images.fallbackContext } : {}),
		...(attachments ? { attachmentContext: attachments.context } : {}),
		...(recallContext ? { recallContext } : {}),
	});
}

async function streamDurableTurn(
	req: HttpReq,
	context: DurableStreamContext,
	service: DurableSessionService,
	httpCtx?: DurableHttpContext,
): Promise<void> {
	const { state, store } = context;
	const projector = new DurableSseProjector();
	let lease: Awaited<ReturnType<DurableSessionService["lease"]>> | undefined;
	let stream: { stop(): Promise<unknown> } | undefined;
	let workspaceMonitor: ReturnType<typeof createWorkspaceChangeMonitor>;
	const closeWorkspaceMonitor = () => {
		workspaceMonitor?.close();
		workspaceMonitor = null;
	};
	try {
		const journal = await store.load(state.sessionId, state.turnId);
		if (!journal) throw new Error("Durable stream journal not found");
		lease = await service.lease(req, state.sessionId);
		await lease.runtime.bindQuestionTurn({
			turnId: state.turnId,
			emit: (event) => publishDurableEvent(context, event),
		});
		await lease.runtime.bindPermissionTurn({
			turnId: state.turnId,
			emit: (event) => publishDurableEvent(context, event),
		});
		// Panel reads come from the manifest + object store in authenticated
		// mode: push the local writes BEFORE publishing workspace_change so the
		// browser's refetch never sees a missing file. Coalesced and bounded —
		// a burst produces at most two pushes and a stalled push never blocks
		// the stream. Only with a durable object provider + replica + tenant.
		const requestTenant = requireRequestTenant(req);
		const replica = httpCtx?.workspaceReplica ?? null;
		const pushGate = replica && requestTenant && state.workspaceRoot
			? createReplicaPushGate(async () => { await replica.push(requestTenant, state.workspaceId, state.workspaceRoot!); })
			: null;
		const publishChange = workspaceChangePublisher(
			(event) => publishDurableEvent(context, event as ChatStreamEvent),
			pushGate,
		);
		workspaceMonitor = createWorkspaceChangeMonitor(state.workspaceRoot, (event) => {
			const changeEvent = event as {
				type: string;
				changes?: Array<{ path?: unknown }>;
				truncated?: boolean;
			};
			const paths = (changeEvent.changes ?? [])
				.map((change) => typeof change.path === "string" ? change.path : "")
				.filter(Boolean);
			void service.recordWorkspaceWriteActivity(
				req,
				state.sessionId,
				state.workspaceId,
				state.workspaceRoot,
				paths,
				changeEvent.truncated === true,
			).catch((error: unknown) => {
				logger.warn({ err: error, sessionId: state.sessionId, turnId: state.turnId }, "durable workspace activity write failed");
			});
			if (!state.terminalEventPublished) {
				publishChange({ ...changeEvent, workspaceId: state.workspaceId });
			}
		});
		const activeStream = await lease.runtime.watch(async (events) => {
			if (state.terminalEventPublished) return;
			for (const event of events) {
				for (const projected of projector.project(event)) {
					if (projected.type === "tool_end"
						&& typeof projected.toolCallId === "string"
						&& typeof projected.toolName === "string") {
						workspaceMonitor?.noteToolEnd(projected.toolCallId, projected.toolName);
					}
					// A watch snapshot is useful to native durable consumers but is not
					// an Inno historical replay event. Canonical history is reloaded on done.
					if (projected.type === "durable_snapshot") continue;
					if (!state.terminalEventPublished) publishDurableEvent(context, projected);
				}
			}
		});
		stream = activeStream;
		if (state.status === "queued") publishDurableEvent(context, { type: "stream_state", status: "running" });
		if (state.cancelRequested) {
			await lease.runtime.abort();
			finishDurableTurn(context, "aborted", {
				type: "aborted", message: "Stopped",
			}, { persisted: false });
			return;
		}
		let submissionId = journal.submissionId;
		if (submissionId === undefined) {
			const submission = await lease.runtime.submit(journal.input, state.clientRequestId);
			submissionId = submission.id;
			await store.markAdmitted(state.sessionId, state.turnId, submissionId);
		}
		await service.noteSubmission(req, state.sessionId, state.inputSnapshot.prompt);
		// Cancellation can race durable admission. Re-apply the abort after the
		// submission commits so an admitted queued input cannot escape it.
		if (state.cancelRequested) await lease.runtime.abort();
		const result = await lease.runtime.waitForSubmission(submissionId);
		await activeStream.stop();
		stream = undefined;
		await workspaceMonitor?.settle();
		// Publish every pending workspace_change (replica push included) before the
		// terminal event below, so `done` can never overtake a file refresh.
		await publishChange.drain();
		closeWorkspaceMonitor();
		await lease.release();
		lease = undefined;
		const detail = await service.snapshot(req, state.sessionId);
		const hasNewCompleteTurn = hasCompleteTurnAfterBaseline(
			detail.messages,
			state.baselineMessageCount,
		);
		// A retry with the same requestId resolves the original submission. It
		// legitimately appends no second user/assistant pair after the baseline.
		const hasCommittedAnswer = result.status === "done" && detail.messages.some((message) =>
			message.role === "assistant" && message.content === result.text,
		);
		const persisted = result.status === "done" && (hasNewCompleteTurn || hasCommittedAnswer);
		const persistence = {
			persisted,
			finalMessageCount: detail.messages.length,
			finalSessionRevision: detail.revision,
		};
		if (result.status === "done" && persisted && !state.cancelRequested) {
			void service.maybeAutoGenerateTopic(req, state.sessionId);
			finishDurableTurn(context, "completed", { type: "done", fullText: result.text }, persistence);
		} else if (state.cancelRequested) {
			finishDurableTurn(context, "aborted", {
				type: "aborted", message: "Stopped",
			}, persistence);
		} else if (result.status === "unanswered") {
			finishDurableTurn(context, "error", {
				type: "error",
				message: `Durable submission was unanswered: ${result.reason}`,
				code: "durable_unanswered",
			}, persistence);
		} else {
			finishDurableTurn(context, "error", {
				type: "error",
				message: "Final durable history could not be confirmed.",
				code: "persistence_confirmation_failed",
			}, persistence);
		}
	} catch (error) {
		logger.error({ err: error, sessionId: state.sessionId, turnId: state.turnId }, "durable SSE chat turn failed");
		if (!state.terminalEventPublished) {
			const persistence = { persisted: false };
			if (state.cancelRequested) {
				finishDurableTurn(context, "aborted", {
					type: "aborted", message: "Stopped",
				}, persistence);
			} else if (state.status === "queued") {
				finishDurableTurn(context, "aborted", {
					type: "aborted",
					message: error instanceof Error ? error.message : String(error),
				}, persistence);
			} else {
				finishDurableTurn(context, "error", {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				}, persistence);
			}
		}
	} finally {
		closeWorkspaceMonitor();
		if (stream) await stream.stop().catch(() => undefined);
		if (lease) {
			lease.runtime.unbindPermissionTurn(state.turnId);
			lease.runtime.unbindQuestionTurn(state.turnId);
			await lease.release().catch(() => undefined);
		}
	}
}

/** Streaming and non-streaming chat entry points for an already authorized,
 * known durable session. Legacy sessions never enter this module. */
export async function handleDurableChatRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: DurableHttpContext,
	parsedBody?: Record<string, unknown>,
): Promise<boolean> {
	if (method === "POST" && url === "/api/chat/question-response") {
		const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const turnId = typeof body.turnId === "string" ? body.turnId : "";
		const questionId = typeof body.questionId === "string" ? body.questionId : "";
		const result = body.result as QuestionBridgeResult | undefined;
		if (!sessionId || !turnId || !questionId || !result
			|| !Array.isArray(result.answers) || typeof result.cancelled !== "boolean") {
			json(res, 400, { error: "Missing or invalid sessionId, turnId, questionId or result" });
			return true;
		}
		const status = await ctx.service.respondQuestion(req, sessionId, { turnId, questionId, result });
		let resumed = false;
		if (status === "accepted") {
			const restored = await restoreDurableStream(req, ctx.service, sessionId, turnId);
			const live = restored?.state ?? streamRegistry.getByTurn(turnId);
			if (live?.sessionId === sessionId && (live.status === "queued" || live.status === "running")) {
				// The original or recovered projection holds the runtime lease until
				// the final response. Restart it if its previous owner disappeared.
				if (restored) void ensureDurableStreamProjection(req, ctx.service, restored, ctx);
				resumed = true;
			} else {
				try {
					await ctx.service.resumeAfterQuestion(req, sessionId);
					resumed = true;
				} catch (error) {
					// The answer is already durable. A later session open can retry the
					// recovered run; do not turn an accepted answer into a failed POST.
					logger.error({ err: error, sessionId, questionId }, "failed to resume durable question");
				}
			}
		}
		json(res, status === "accepted" ? 200 : status === "scope_mismatch" || status === "already_resolved" ? 409 : 404, {
			accepted: status === "accepted",
			...(status === "accepted" ? { resumed, sessionId } : {}),
		});
		return true;
	}

	if (method === "POST" && url === "/api/chat/permission-response") {
		const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const turnId = typeof body.turnId === "string" ? body.turnId : "";
		const requestId = typeof body.requestId === "string" ? body.requestId : "";
		const decision = body.decision;
		const reason = typeof body.reason === "string" ? body.reason : undefined;
		const validDecision: PermissionDecision | null =
			decision === "allow_once" || decision === "allow_session" || decision === "deny" ? decision : null;
		if (!sessionId || !turnId || !requestId || !validDecision) {
			json(res, 400, { error: "Missing sessionId, turnId, requestId or a valid decision" });
			return true;
		}
		const status = await ctx.service.respondPermission(req, sessionId, {
			turnId, requestId, decision: validDecision, ...(reason ? { reason } : {}),
		});
		let resumed = false;
		if (status === "accepted") {
			const restored = await restoreDurableStream(req, ctx.service, sessionId, turnId);
			const live = restored?.state ?? streamRegistry.getByTurn(turnId);
			if (live?.sessionId === sessionId && (live.status === "queued" || live.status === "running")) {
				if (restored) void ensureDurableStreamProjection(req, ctx.service, restored, ctx);
				resumed = true;
			} else {
				try {
					await ctx.service.resumeAfterPermission(req, sessionId);
					resumed = true;
				} catch (error) {
					// The decision is already durable. A later session open can retry
					// the original tool call without another approval card.
					logger.error({ err: error, sessionId, requestId }, "failed to resume durable permission");
				}
			}
		}
		json(res, status === "accepted" ? 200 : status === "scope_mismatch" || status === "already_resolved" ? 409 : 404, {
			accepted: status === "accepted",
			...(status === "accepted" ? { resumed, sessionId } : {}),
		});
		return true;
	}

	if (method === "POST" && url === "/api/chat") {
		const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
		const prompt = typeof body.prompt === "string" ? body.prompt : "";
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		if (!prompt || !sessionId) { json(res, 400, { error: "Missing prompt or sessionId" }); return true; }
		if (chatImagesAreEmbedded(body.images)) {
			json(res, 400, { error: "Chat images must be workspace file references" });
			return true;
		}
		await restoreDurableStream(req, ctx.service, sessionId);
		if (streamRegistry.getActiveForSession(sessionId)) {
			json(res, 409, { error: "Session already has an active chat turn" });
			return true;
		}
		if (await ctx.service.pendingQuestion(req, sessionId)) {
			json(res, 409, { error: "This session has a pending question; answer it through the streaming UI" });
			return true;
		}
		if (await ctx.service.pendingPermission(req, sessionId)) {
			json(res, 409, { error: "This session has a pending permission request; answer it through the streaming UI" });
			return true;
		}
		const requestId = typeof body.clientRequestId === "string" && body.clientRequestId.trim()
			? body.clientRequestId
			: `http-${crypto.randomUUID()}`;
		const attachments = await ctx.service.prepareAttachments(req, sessionId, body.attachments);
		const images = await ctx.service.prepareImages(req, sessionId, body.images, requestId);
		const recallContext = await ctx.service.prepareRecallContext(req, sessionId, prompt);
		let lease: Awaited<ReturnType<DurableSessionService["lease"]>> | undefined;
		try {
			lease = await ctx.service.lease(req, sessionId);
			await lease.runtime.bindQuestionTurn({ turnId: requestId, noUi: true });
			await lease.runtime.bindPermissionTurn({ turnId: requestId, noUi: true });
			await ctx.service.recordTurnMetadata(req, sessionId, attachments, images, prompt, requestId);
			const submission = await lease.runtime.submit(durableUserInput(prompt, attachments, images, recallContext), requestId);
			await ctx.service.noteSubmission(req, sessionId, prompt);
			const result = await lease.runtime.waitForSubmission(submission.id);
			if (result.status !== "done") throw new Error(`Durable submission was unanswered: ${result.reason}`);
			await ctx.service.snapshot(req, sessionId);
			void ctx.service.maybeAutoGenerateTopic(req, sessionId);
			json(res, 200, { response: result.text });
		} catch (error) {
			json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		} finally {
			lease?.runtime.unbindPermissionTurn();
			lease?.runtime.unbindQuestionTurn();
			await lease?.release().catch(() => undefined);
		}
		return true;
	}

	if (method !== "POST" || url !== "/api/chat/stream") return false;
	const body = parsedBody ?? await readBody(req) as Record<string, unknown>;
	const prompt = typeof body.prompt === "string" ? body.prompt : "";
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";
	if (!prompt || !sessionId || !clientRequestId) {
		json(res, 400, { error: "Missing prompt, sessionId or clientRequestId" });
		return true;
	}
	if (chatImagesAreEmbedded(body.images)) {
		json(res, 400, { error: "Chat images must be workspace file references" });
		return true;
	}
	await restoreDurableStream(req, ctx.service, sessionId);
	if (streamRegistry.getActiveForSession(sessionId)) {
		json(res, 409, { error: "Session already has an active chat turn" });
		return true;
	}
	const workspaceId = ctx.workspaceRegistry.getSessionWorkspaceId(sessionId);
	const workspaceRoot = ctx.workspaceRegistry.resolveWorkspaceDir(workspaceId);
	if (!workspaceRoot) { json(res, 404, { error: "Session workspace not found" }); return true; }
	const attachments = await ctx.service.prepareAttachments(req, sessionId, body.attachments);
	const images = await ctx.service.prepareImages(req, sessionId, body.images, clientRequestId);
	let baseline: Awaited<ReturnType<DurableSessionService["snapshot"]>>;
	try {
		baseline = await ctx.service.snapshot(req, sessionId);
	} catch (error) {
		json(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) });
		return true;
	}
	const recallContext = await ctx.service.prepareRecallContext(req, sessionId, prompt);
	const input = durableUserInput(prompt, attachments, images, recallContext);
	let state: SessionStreamState;
	try {
		state = streamRegistry.createTurn({
			sessionId,
			clientRequestId,
			workspaceId,
			workspaceRoot,
			inputSnapshot: { prompt, submittedAt: new Date().toISOString(), images: images?.images ?? [], ...(attachments ? { attachments: attachments.attachments } : {}) },
			baselineMessageCount: baseline.messages.length,
			baselineSessionRevision: baseline.revision,
		});
	} catch {
		json(res, 409, { error: "Session already has an active chat turn" });
		return true;
	}
	const store = ctx.service.streamStore(req);
	const streamContext: DurableStreamContext = { state, store };
	try {
		// Persist the exact model input before admission. If the process dies
		// before the submission ID append, the same requestId reacquires it.
		await store.create(state, input);
	} catch (error) {
		streamRegistry.discardTurn(state);
		json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		return true;
	}
	await ctx.service.recordTurnMetadata(req, sessionId, attachments, images, prompt, clientRequestId);
	publishDurableEvent(streamContext, { type: "stream_state", status: "queued" });
	startSse(res);
	let ended = false;
	const heartbeat = setInterval(() => { if (!ended) res.write(": heartbeat\n\n"); }, 15_000);
	const finish = () => {
		if (ended) return;
		ended = true;
		clearInterval(heartbeat);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	const unsubscribe = streamRegistry.subscribe(state, 0, (envelope) => {
		if (ended) return;
		res.write(`data: ${JSON.stringify(envelope)}\n\n`);
		if (["done", "error", "aborted"].includes(envelope.event.type)) finish();
	});
	res.on("close", () => {
		ended = true;
		clearInterval(heartbeat);
		unsubscribe();
	});
	await ensureDurableStreamProjection(req, ctx.service, streamContext, ctx);
	finish();
	streamRegistry.cleanupExpiredTurns();
	return true;
}
