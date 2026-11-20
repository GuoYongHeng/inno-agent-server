import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { streamRegistry } from "../../chat/stream-registry.js";
import { logger } from "../../logger.js";
import type { WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import type { TenantStore } from "../../tenants/store.js";
import { ownsRequestResource } from "../../tenants/http.js";
import {
	ensureDurableStreamProjection,
	handleDurableChatRoutes,
	restoreDurableStream,
	type DurableHttpContext,
} from "../durable-routes.js";
import { json, matchRoute, readBody } from "../http-helpers.js";

/**
 * Server-owned dependencies of the chat routes. Every conversation is a durable
 * session, so these routes validate the request and hand it to the durable
 * handlers; there is no other execution path.
 */
export interface ChatRouteContext {
	workspaceRegistry: WorkspaceRegistry;
	tenantStore?: TenantStore | null;
	durableSessions: DurableHttpContext["service"];
}

/** /api/chat* route domain. Returns true when the request was handled. */
export async function handleChatRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: ChatRouteContext,
): Promise<boolean> {
	const { workspaceRegistry, tenantStore, durableSessions } = ctx;
	const durableContext: DurableHttpContext = { service: durableSessions, workspaceRegistry, tenantStore };

	const ownsSession = (sessionId: string) => ownsRequestResource(req, tenantStore, "session", sessionId);
	const denySession = () => { json(res, 404, { error: "Session not found" }); return true; };
	/** Hand the request to the durable handlers, or 404 for an unknown session. */
	const toDurable = async (sessionId: string, body?: Record<string, unknown>): Promise<boolean> => {
		if (!await ownsSession(sessionId) || !await durableSessions.get(req, sessionId)) return denySession();
		return handleDurableChatRoutes(req, res, method, url, durableContext, body);
	};

	const pathSessionId = matchRoute("GET", method, url, "/api/chat/status/:sessionId")?.sessionId
		?? matchRoute("GET", method, url, "/api/chat/events/:id")?.id
		?? matchRoute("POST", method, url, "/api/chat/:sessionId/:turnId/abort")?.sessionId;
	if (pathSessionId && !await ownsSession(pathSessionId)) return denySession();

	// --- Non-streaming chat ---
	if (method === "POST" && url === "/api/chat") {
		const body = (await readBody(req)) as Record<string, unknown>;
		if (!body.prompt) {
			json(res, 400, { error: "Missing prompt" });
			return true;
		}
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		if (!sessionId) {
			json(res, 400, { error: "Missing sessionId" });
			return true;
		}
		return toDurable(sessionId, body);
	}

	// --- Question response (from web UI) ---
	if (method === "POST" && url === "/api/chat/question-response") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const turnId = typeof body.turnId === "string" ? body.turnId : "";
		const questionId = typeof body.questionId === "string" ? body.questionId : "";
		if (!sessionId || !turnId || !questionId || !body.result) {
			json(res, 400, { error: "Missing sessionId, turnId, questionId or result" });
			return true;
		}
		return toDurable(sessionId, body);
	}

	// --- Permission response (from web UI) ---
	if (method === "POST" && url === "/api/chat/permission-response") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const turnId = typeof body.turnId === "string" ? body.turnId : "";
		const requestId = typeof body.requestId === "string" ? body.requestId : "";
		const decision = body.decision;
		const validDecision = decision === "allow_once" || decision === "allow_session" || decision === "deny";
		if (!sessionId || !turnId || !requestId || !validDecision) {
			json(res, 400, { error: "Missing sessionId, turnId, requestId or a valid decision (allow_once|allow_session|deny)" });
			return true;
		}
		return toDurable(sessionId, body);
	}

	if (method === "POST" && url === "/api/chat/abort") {
		json(res, 400, { error: "Scoped abort requires sessionId and turnId" });
		return true;
	}

	const chatAbortMatch = matchRoute("POST", method, url, "/api/chat/:sessionId/:turnId/abort");
	if (chatAbortMatch) {
		if (!await ownsSession(chatAbortMatch.sessionId) || !await durableSessions.get(req, chatAbortMatch.sessionId)) return denySession();
		const restored = await restoreDurableStream(req, durableSessions, chatAbortMatch.sessionId, chatAbortMatch.turnId);
		const state = restored?.state ?? streamRegistry.getByTurn(chatAbortMatch.turnId);
		if (!state || state.sessionId !== chatAbortMatch.sessionId) {
			json(res, 404, { error: "Chat turn not found" });
			return true;
		}
		if (state.status !== "queued" && state.status !== "running") {
			json(res, 200, { status: state.status, cancelRequested: state.cancelRequested });
			return true;
		}
		streamRegistry.requestCancel(state);
		try {
			await restored?.store.markCancelled(state.sessionId, state.turnId);
			await durableSessions.abort(req, state.sessionId, state.turnId);
			if (restored) void ensureDurableStreamProjection(req, durableSessions, restored);
		} catch (error) {
			logger.error({ err: error, sessionId: state.sessionId, turnId: state.turnId }, "durable chat abort failed");
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
			return true;
		}
		json(res, 202, { status: state.status, cancelRequested: true });
		return true;
	}

	const chatStatusMatch = matchRoute("GET", method, url, "/api/chat/status/:sessionId");
	if (chatStatusMatch) {
		streamRegistry.cleanupExpiredTurns();
		if (await durableSessions.get(req, chatStatusMatch.sessionId)) {
			await restoreDurableStream(req, durableSessions, chatStatusMatch.sessionId);
		}
		const state = streamRegistry.getLatest(chatStatusMatch.sessionId);
		json(res, 200, state
			? { found: true, stream: streamRegistry.toPublicSnapshot(state) }
			: { found: false });
		return true;
	}

	const chatEventsMatch = matchRoute("GET", method, url, "/api/chat/events/:id");
	if (chatEventsMatch) {
		const sessionId = chatEventsMatch.id;
		const params = new URL(url, "http://localhost").searchParams;
		const turnId = params.get("turnId") ?? "";
		const after = Number.parseInt(params.get("after") ?? "0", 10);
		if (!turnId || !Number.isFinite(after) || after < 0) {
			json(res, 400, { error: "turnId and a non-negative after value are required" });
			return true;
		}
		const restored = await durableSessions.get(req, sessionId)
			? await restoreDurableStream(req, durableSessions, sessionId, turnId)
			: undefined;
		const state = restored?.state ?? streamRegistry.getByTurn(turnId);
		if (!state || state.sessionId !== sessionId) {
			json(res, 404, { error: "Chat turn not found" });
			return true;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		let ended = false;
		const eventsHeartbeat = setInterval(() => {
			if (!ended) {
				try {
					res.write(": heartbeat\n\n");
					logger.debug({ sessionId }, "SSE event replay heartbeat sent");
				} catch (err) {
					logger.warn({ sessionId, err }, "SSE event replay heartbeat write failed");
				}
			}
		}, 15_000);
		const finishResponse = () => {
			if (ended) return;
			ended = true;
			clearInterval(eventsHeartbeat);
			res.write("data: [DONE]\n\n");
			res.end();
		};
		const unsub = streamRegistry.subscribe(state, after, (envelope) => {
			if (ended) return;
			res.write(`data: ${JSON.stringify(envelope)}\n\n`);
			if (["done", "error", "aborted"].includes(envelope.event.type)) finishResponse();
		});
		if (restored && !state.terminalEventPublished) {
			void ensureDurableStreamProjection(req, durableSessions, restored);
		}
		if (state.terminalEventPublished && !ended) finishResponse();
		res.on("close", () => { clearInterval(eventsHeartbeat); unsub(); });
		return true;
	}

	// --- Chat streaming (SSE) ---
	if (method === "POST" && url === "/api/chat/stream") {
		const body = (await readBody(req)) as Record<string, unknown>;
		const prompt = body.prompt as string | undefined;
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";
		if (!prompt || !sessionId || !clientRequestId) {
			json(res, 400, { error: "Missing prompt, sessionId or clientRequestId" });
			return true;
		}
		return toDurable(sessionId, body);
	}

	return false;
}
