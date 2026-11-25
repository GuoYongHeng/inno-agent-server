import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import type { TenantContext } from "./store.js";
import { DEFAULT_MAX_BODY_BYTES, json } from "../server/http-helpers.js";
import { logger } from "../logger.js";

export interface DurableShardConfig {
	localShardId: string;
	targets: Readonly<Record<string, string>>;
}

const FORWARDED_HEADER = "x-inno-durable-forwarded";

/** How long a forwarded request waits for response headers before failing.
 * A frozen (SIGSTOP) owner still completes the TCP handshake at kernel level,
 * so a dead-looking target can only be detected by its silence. Session
 * requests then fall back to local takeover; tenant requests get a 502. */
const FORWARD_HEADERS_TIMEOUT_MS = Math.max(
	500,
	Number(process.env.INNO_DURABLE_FORWARD_TIMEOUT_MS) || 10_000,
);

const SHARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Worker identity: the explicit shard id, else the container/pod `HOSTNAME`
 * when sharding is configured (k8s StatefulSet / compose give every replica a
 * stable unique hostname that matches the URL map keys). */
export function resolveDurableShardId(env: NodeJS.ProcessEnv): string {
	const shard = env.INNO_DURABLE_SHARD_ID?.trim();
	if (shard) return shard;
	if (env.INNO_DURABLE_SHARD_URLS?.trim() || env.INNO_DURABLE_SHARD_URL_TEMPLATE?.trim()) {
		return env.HOSTNAME?.trim() ?? "";
	}
	return "";
}

function shardTargetOrigin(shardId: string, rawUrl: string): string {
	if (!SHARD_ID_PATTERN.test(shardId)) throw new Error(`Invalid durable shard entry: ${shardId}`);
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid durable shard URL for ${shardId}`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:")
		|| url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
		|| url.search || url.hash) {
		throw new Error(`Durable shard URL must be an http(s) origin without credentials or paths: ${shardId}`);
	}
	return url.origin;
}

/** Expand `INNO_DURABLE_SHARD_URL_TEMPLATE` (a `{id}` placeholder origin) over
 * the peer list from `INNO_DURABLE_SHARD_IDS`, or generated as
 * `INNO_DURABLE_SHARD_PREFIX`-0..COUNT-1 for StatefulSet-style deployments. */
function expandShardUrlTemplate(env: NodeJS.ProcessEnv): Record<string, string> {
	const template = env.INNO_DURABLE_SHARD_URL_TEMPLATE!.trim();
	if (!template.includes("{id}")) {
		throw new Error("INNO_DURABLE_SHARD_URL_TEMPLATE must contain a {id} placeholder");
	}
	const rawIds = env.INNO_DURABLE_SHARD_IDS?.trim();
	const prefix = env.INNO_DURABLE_SHARD_PREFIX?.trim();
	const rawCount = env.INNO_DURABLE_SHARD_COUNT?.trim();
	if (rawIds && (prefix || rawCount)) {
		throw new Error("Use either INNO_DURABLE_SHARD_IDS or INNO_DURABLE_SHARD_PREFIX+INNO_DURABLE_SHARD_COUNT, not both");
	}
	let shardIds: string[];
	if (rawIds) {
		shardIds = rawIds.split(",").map((id) => id.trim()).filter(Boolean);
	} else if (prefix && rawCount) {
		const count = Math.max(0, Math.floor(Number(rawCount)));
		if (!count || count > 1000) throw new Error("INNO_DURABLE_SHARD_COUNT must be a positive integer");
		shardIds = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
	} else {
		throw new Error("INNO_DURABLE_SHARD_URL_TEMPLATE requires INNO_DURABLE_SHARD_IDS or INNO_DURABLE_SHARD_PREFIX+INNO_DURABLE_SHARD_COUNT");
	}
	const targets: Record<string, string> = {};
	for (const shardId of shardIds) {
		targets[shardId] = shardTargetOrigin(shardId, template.split("{id}").join(shardId));
	}
	return targets;
}

/** Worker discovery. `INNO_DURABLE_SHARD_URLS` gives an explicit id→origin map;
 * `INNO_DURABLE_SHARD_URL_TEMPLATE` + peer list expands the same map for
 * StatefulSet-style deploys. `INNO_DURABLE_SHARD_ID` defaults to `HOSTNAME`.
 * Tenant identity is never read from this config or from a request header;
 * callers pass only the verified PostgreSQL tenant. */
export function readDurableShardConfig(env: NodeJS.ProcessEnv): DurableShardConfig | null {
	const rawTargets = env.INNO_DURABLE_SHARD_URLS?.trim() ?? "";
	const rawTemplate = env.INNO_DURABLE_SHARD_URL_TEMPLATE?.trim() ?? "";
	const localShardId = resolveDurableShardId(env);
	if (!localShardId && !rawTargets && !rawTemplate) return null;
	if (rawTargets && rawTemplate) {
		throw new Error("Use either INNO_DURABLE_SHARD_URLS or INNO_DURABLE_SHARD_URL_TEMPLATE, not both");
	}
	if (!localShardId || (!rawTargets && !rawTemplate)) {
		throw new Error("A shard id (INNO_DURABLE_SHARD_ID or HOSTNAME) and INNO_DURABLE_SHARD_URLS or INNO_DURABLE_SHARD_URL_TEMPLATE must be configured together");
	}
	const targets: Record<string, string> = {};
	if (rawTemplate) {
		Object.assign(targets, expandShardUrlTemplate(env));
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawTargets);
		} catch {
			throw new Error("INNO_DURABLE_SHARD_URLS must be a JSON object of shard IDs to origin URLs");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("INNO_DURABLE_SHARD_URLS must be a JSON object of shard IDs to origin URLs");
		}
		for (const [shardId, rawUrl] of Object.entries(parsed)) {
			if (typeof rawUrl !== "string") throw new Error(`Invalid durable shard entry: ${shardId}`);
			targets[shardId] = shardTargetOrigin(shardId, rawUrl);
		}
	}
	if (!targets[localShardId]) throw new Error(`Local durable shard ${localShardId} is missing from the durable shard URL map`);
	return { localShardId, targets };
}

export function selectDurableShard(tenantId: string, config: DurableShardConfig): string {
	const shardIds = Object.keys(config.targets).sort();
	if (shardIds.length === 0) throw new Error("No durable shards configured");
	const digest = createHash("sha256").update(`tenant\0${tenantId}`).digest();
	return shardIds[Number(digest.readUInt32BE(0) % shardIds.length)];
}

/** Resolve a session id carried in the request URL, mirroring the session-scoped
 * route shapes in server/routes/{chat,btw,sessions,workspaces}.ts. */
function sessionIdFromPath(path: string): string | null {
	const patterns = [
		/^\/api\/sessions\/([^/?#]+)/,
		/^\/api\/chat\/status\/([^/?#]+)$/,
		/^\/api\/chat\/events\/([^/?#]+)$/,
		/^\/api\/chat\/([^/?#]+)\/[^/?#]+\/abort$/,
		/^\/api\/btw\/state\/([^/?#]+)$/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(path);
		if (match?.[1]) return decodeURIComponent(match[1]);
	}
	return null;
}

/** Session-scoped JSON endpoints that carry `sessionId` in the request body. */
const BODY_SESSION_ROUTES = new Set([
	"POST /api/chat",
	"POST /api/chat/stream",
	"POST /api/chat/question-response",
	"POST /api/chat/permission-response",
	"POST /api/btw/ask",
	"POST /api/btw/bring-back",
]);

function sessionIdFromBody(body: Buffer): string | null {
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { sessionId?: unknown };
		return typeof parsed?.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
	} catch {
		return null;
	}
}

/** Rebuild a request-like stream around a buffered body so downstream handlers
 * can still read it when the request is served locally. */
export function replayBodyRequest(req: IncomingMessage, body: Buffer): IncomingMessage {
	const stream = new PassThrough();
	const replay = stream as unknown as IncomingMessage;
	replay.method = req.method;
	replay.url = req.url;
	replay.headers = req.headers;
	replay.rawHeaders = req.rawHeaders;
	replay.httpVersion = req.httpVersion;
	replay.httpVersionMajor = req.httpVersionMajor;
	replay.httpVersionMinor = req.httpVersionMinor;
	replay.complete = true;
	Object.defineProperty(replay, "socket", { value: req.socket });
	Object.defineProperty(replay, "connection", { value: req.socket });
	// Propagate client disconnect: handlers abort long-running work on 'close'.
	req.socket?.once("close", () => replay.destroy());
	stream.end(body);
	return replay;
}

export function bufferBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolveBuffer, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		req.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > DEFAULT_MAX_BODY_BYTES) {
				req.removeAllListeners("data");
				req.pause();
				reject(new Error("body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.once("end", () => resolveBuffer(Buffer.concat(chunks)));
		req.once("error", reject);
	});
}

/**
 * Route after cookie authentication and personal-tenant provisioning, before
 * the local agent runtime is touched. Session-scoped requests follow the live
 * recorded storage owner (`ds_metadata`) instead of the tenant hash, so a
 * request landing on any worker reaches the worker holding the lease; requests
 * without a live owner keep the tenant-hash target that will claim it.
 * The target authenticates the forwarded cookie again; no client-supplied
 * tenant or shard is trusted.
 *
 * Returns the request to serve locally — a replay wrapper when the body was
 * buffered to extract a session id — or null when the response was handled
 * here (forwarded upstream or answered with an error).
 */
export async function forwardDurableTenantRequest(
	req: IncomingMessage,
	res: ServerResponse,
	tenant: TenantContext,
	config: DurableShardConfig,
	resolveSessionOwner?: (sessionId: string) => Promise<string | { owner: string | null; affinity?: string | null } | null>,
): Promise<IncomingMessage | null> {
	const path = (req.url ?? "/").split("?")[0];
	let sessionId = sessionIdFromPath(path);
	let bufferedBody: Buffer | null = null;
	const methodHasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
	// Buffer every session-scoped body: for body-carried ids it is how the
	// session is identified, and for any session request it keeps the request
	// replayable when the chosen target turns out to be unreachable.
	if ((sessionId && methodHasBody) || BODY_SESSION_ROUTES.has(`${req.method} ${path}`)) {
		const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
		if (Number.isFinite(declared) && declared > DEFAULT_MAX_BODY_BYTES) {
			json(res, 413, { error: `Request body too large (limit ${DEFAULT_MAX_BODY_BYTES} bytes)` });
			return null;
		}
		try {
			bufferedBody = await bufferBody(req);
		} catch {
			json(res, 413, { error: `Request body too large (limit ${DEFAULT_MAX_BODY_BYTES} bytes)` });
			return null;
		}
		req = replayBodyRequest(req, bufferedBody);
		if (!sessionId) sessionId = sessionIdFromBody(bufferedBody);
	}
	const hint = sessionId && resolveSessionOwner ? await resolveSessionOwner(sessionId) : null;
	// Session-scoped requests follow the live recorded owner, else the worker
	// that last held the lease (its disk still carries the session's local
	// files), else the tenant hash; an unreachable target falls back to local
	// service so the requester can claim the lease itself. Tenant-level
	// requests keep the hash target and fail closed because other tenant
	// state is not routed by lease.
	const resolved = typeof hint === "string" ? { owner: hint, affinity: null } : hint;
	const preferred = (resolved?.owner ?? resolved?.affinity) ?? null;
	const targetShard = preferred && config.targets[preferred]
		? preferred
		: selectDurableShard(tenant.tenantId, config);
	if (targetShard === config.localShardId) return req;
	if (req.headers[FORWARDED_HEADER]) {
		json(res, 503, { error: "Durable shard forwarding loop detected", code: "durable_shard_loop" });
		return null;
	}
	const target = new URL(req.url ?? "/", config.targets[targetShard]);
	const transportRequest = target.protocol === "https:" ? httpsRequest : httpRequest;
	const headers = { ...req.headers, host: target.host, [FORWARDED_HEADER]: "1" };
	res.setHeader("x-inno-durable-shard", targetShard);
	const outcome = await new Promise<"forwarded" | "unavailable">((resolveForward) => {
		let responded = false;
		const upstream = transportRequest(target, { method: req.method, headers }, (upstreamResponse) => {
			// Headers arrived: stop the connect timeout, the response may stream for a while.
			upstream.setTimeout(0);
			responded = true;
			res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
			upstreamResponse.pipe(res);
			resolveForward("forwarded");
		});
		upstream.on("error", (error) => {
			if (!responded && sessionId) {
				res.removeHeader("x-inno-durable-shard");
				resolveForward("unavailable");
				return;
			}
			logger.error({ err: error, tenantId: tenant.tenantId, targetShard }, "durable tenant shard forwarding failed");
			if (res.headersSent) {
				res.end();
			} else {
				json(res, 502, { error: "Durable shard owner unavailable", code: "durable_shard_unavailable" });
			}
			resolveForward("forwarded");
		});
		res.once("close", () => {
			if (!res.writableFinished) upstream.destroy();
		});
		upstream.setTimeout(FORWARD_HEADERS_TIMEOUT_MS, () => {
			upstream.destroy(new Error(`durable shard forward timed out after ${FORWARD_HEADERS_TIMEOUT_MS}ms`));
		});
		if (bufferedBody) upstream.end(bufferedBody);
		else req.pipe(upstream);
	});
	return outcome === "unavailable" ? req : null;
}
