import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	forwardDurableTenantRequest,
	readDurableShardConfig,
	selectDurableShard,
	type DurableShardConfig,
} from "./durable-tenant-router.js";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
		server.closeAllConnections();
		server.close(() => resolveClose());
	})));
});

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return `http://127.0.0.1:${address.port}`;
}

function shardConfig(localShardId: string, workerA: string, workerB: string): DurableShardConfig {
	return { localShardId, targets: { "worker-a": workerA, "worker-b": workerB } };
}

describe("durable tenant router", () => {
	it("is disabled without explicit shard configuration and requires id plus url", () => {
		expect(readDurableShardConfig({})).toBeNull();
		expect(() => readDurableShardConfig({ INNO_DURABLE_SHARD_ID: "worker-a" })).toThrow(/must be configured together/);
		expect(() => readDurableShardConfig({
			INNO_DURABLE_SHARD_ID: "worker-a",
			INNO_DURABLE_SHARD_URLS: JSON.stringify({ "worker-a": "http://127.0.0.1:3000" }),
		})).not.toThrow();
	});

	it("derives the local shard id from HOSTNAME when sharding is configured", () => {
		const authEnv = {};
		const config = readDurableShardConfig({
			...authEnv,
			HOSTNAME: "inno-agent-1",
			INNO_DURABLE_SHARD_URLS: JSON.stringify({
				"inno-agent-0": "http://inno-agent-0.svc:3000",
				"inno-agent-1": "http://inno-agent-1.svc:3000",
			}),
		});
		expect(config?.localShardId).toBe("inno-agent-1");
		// Explicit id still wins over HOSTNAME.
		expect(readDurableShardConfig({
			...authEnv, HOSTNAME: "inno-agent-1", INNO_DURABLE_SHARD_ID: "inno-agent-0",
			INNO_DURABLE_SHARD_URLS: JSON.stringify({ "inno-agent-0": "http://a.local", "inno-agent-1": "http://b.local" }),
		})?.localShardId).toBe("inno-agent-0");
		// Without sharding env, HOSTNAME alone does not enable routing.
		expect(readDurableShardConfig({ HOSTNAME: "inno-agent-1" })).toBeNull();
	});

	it("expands a shard URL template over a peer list or StatefulSet ordinals", () => {
		const authEnv = { HOSTNAME: "inno-0" };
		const byIds = readDurableShardConfig({
			...authEnv,
			INNO_DURABLE_SHARD_URL_TEMPLATE: "http://{id}.inno-headless:3000",
			INNO_DURABLE_SHARD_IDS: "inno-0, inno-1",
		});
		expect(byIds?.targets).toEqual({
			"inno-0": "http://inno-0.inno-headless:3000",
			"inno-1": "http://inno-1.inno-headless:3000",
		});
		const byOrdinals = readDurableShardConfig({
			...authEnv,
			INNO_DURABLE_SHARD_URL_TEMPLATE: "http://{id}.inno-headless:3000",
			INNO_DURABLE_SHARD_PREFIX: "inno", INNO_DURABLE_SHARD_COUNT: "3",
		});
		expect(Object.keys(byOrdinals?.targets ?? {})).toEqual(["inno-0", "inno-1", "inno-2"]);
		expect(() => readDurableShardConfig({
			...authEnv,
			INNO_DURABLE_SHARD_URL_TEMPLATE: "http://fixed:3000",
			INNO_DURABLE_SHARD_IDS: "inno-0",
		})).toThrow(/\{id\}/);
		expect(() => readDurableShardConfig({
			...authEnv,
			INNO_DURABLE_SHARD_URL_TEMPLATE: "http://{id}:3000",
			INNO_DURABLE_SHARD_URLS: "{}",
			INNO_DURABLE_SHARD_IDS: "inno-0",
		})).toThrow(/not both/);
		expect(() => readDurableShardConfig({
			...authEnv, HOSTNAME: "other",
			INNO_DURABLE_SHARD_URL_TEMPLATE: "http://{id}:3000",
			INNO_DURABLE_SHARD_IDS: "inno-0",
		})).toThrow(/missing from/);
	});

	it("selects a stable sorted shard from the verified tenant ID", () => {
		const config = shardConfig("worker-a", "http://a.local", "http://b.local");
		const reversed = { ...config, targets: { "worker-b": "http://b.local", "worker-a": "http://a.local" } };
		const assignments = Array.from({ length: 40 }, (_, index) => `tenant-${index}`);
		expect(assignments.map((tenantId) => selectDurableShard(tenantId, config)))
			.toEqual(assignments.map((tenantId) => selectDurableShard(tenantId, reversed)));
		expect(new Set(assignments.map((tenantId) => selectDurableShard(tenantId, config)))).toEqual(new Set(["worker-a", "worker-b"]));
	});

	it("forwards the untouched body and cookie to the verified tenant owner", async () => {
		let received: { body: string; cookie?: string; forwarded?: string; url?: string } | undefined;
		const owner = createServer((req, res) => {
			let body = "";
			req.setEncoding("utf-8");
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				received = {
					body,
					cookie: req.headers.cookie,
					forwarded: req.headers["x-inno-durable-forwarded"] as string | undefined,
					url: req.url,
				};
				res.writeHead(201, { "Content-Type": "application/json", "x-owner": "worker-b" });
				res.end(JSON.stringify({ accepted: true }));
			});
		});
		const ownerOrigin = await listen(owner);
		const tenantId = Array.from({ length: 100 }, (_, index) => `tenant-${index}`)
			.find((id) => selectDurableShard(id, shardConfig("worker-a", "http://a.local", "http://b.local")) === "worker-b")!;
		let sourceOrigin = "";
		const source = createServer((req, res) => {
			void forwardDurableTenantRequest(req, res, {
				tenantId, userId: "verified-user", role: "owner",
			}, shardConfig("worker-a", sourceOrigin, ownerOrigin)).then((routedReq) => {
				if (!routedReq) return;
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("served locally");
			});
		});
		sourceOrigin = await listen(source);
		const response = await fetch(`${sourceOrigin}/api/chat/stream?turn=1`, {
			method: "POST",
			headers: { Cookie: "session_token=verified", "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "durable work" }),
		});
		expect(response.status).toBe(201);
		expect(response.headers.get("x-inno-durable-shard")).toBe("worker-b");
		expect(response.headers.get("x-owner")).toBe("worker-b");
		expect(await response.json()).toEqual({ accepted: true });
		expect(received).toEqual({
			body: JSON.stringify({ prompt: "durable work" }),
			cookie: "session_token=verified",
			forwarded: "1",
			url: "/api/chat/stream?turn=1",
		});
	});

	/** Source server that routes every request through forwardDurableTenantRequest
	 * and reports local service when the router returns a request to serve. */
	function sourceServer(localShardId: string, targets: Record<string, string>,
		tenantId: string, resolveOwner?: (sessionId: string) => Promise<string | { owner: string | null; affinity?: string | null } | null>): Promise<string> {
		const tenant = { tenantId, userId: "verified-user", role: "owner" as const };
		const source = createServer((req, res) => {
			void forwardDurableTenantRequest(req, res, tenant, { localShardId, targets }, resolveOwner)
				.then(async (routedReq) => {
					if (!routedReq) return;
					let body = "";
					routedReq.setEncoding("utf-8");
					routedReq.on("data", (chunk) => { body += chunk; });
					routedReq.on("end", () => {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ served: "local", body }));
					});
				});
		});
		return listen(source);
	}

	/** A tenant id that hashes to `shard` under the two-worker config. */
	function tenantOn(shard: string, targets: Record<string, string>): string {
		const config = { localShardId: shard, targets };
		const id = Array.from({ length: 200 }, (_, index) => `tenant-${index}`)
			.find((candidate) => selectDurableShard(candidate, config) === shard);
		if (!id) throw new Error(`no test tenant hashes to ${shard}`);
		return id;
	}

	it("routes session requests to the live recorded owner instead of the tenant hash", async () => {
		let ownerHit = "";
		const owner = createServer((req, res) => {
			ownerHit = req.url ?? "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ served: "worker-b" }));
		});
		const ownerOrigin = await listen(owner);
		const targets = { "worker-a": "http://127.0.0.1:1", "worker-b": ownerOrigin };
		const tenantId = tenantOn("worker-a", targets);
		const source = await sourceServer("worker-a", targets, tenantId, async () => "worker-b");

		for (const path of ["/api/sessions/ses-1", "/api/chat/status/ses-1", "/api/btw/state/ses-1"]) {
			const response = await fetch(`${source}${path}`, { method: "GET" });
			expect(response.status).toBe(200);
			expect(response.headers.get("x-inno-durable-shard")).toBe("worker-b");
			expect(await response.json()).toEqual({ served: "worker-b" });
			expect(ownerHit).toBe(path);
		}
	});

	it("extracts the session id from the request body and buffers it for the owner", async () => {
		let received = "";
		const owner = createServer((req, res) => {
			req.setEncoding("utf-8");
			req.on("data", (chunk) => { received += chunk; });
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ served: "worker-b" }));
			});
		});
		const ownerOrigin = await listen(owner);
		const targets = { "worker-a": "http://127.0.0.1:1", "worker-b": ownerOrigin };
		const tenantId = tenantOn("worker-a", targets);
		const source = await sourceServer("worker-a", targets, tenantId, async (sessionId) =>
			sessionId === "ses-body" ? "worker-b" : null);

		const body = JSON.stringify({ sessionId: "ses-body", prompt: "routed by body" });
		const response = await fetch(`${source}/api/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-inno-durable-shard")).toBe("worker-b");
		expect(received).toBe(body);
	});

	it("prefers the last-claiming worker for an idle session over the tenant hash", async () => {
		let ownerHit = "";
		const affinity = createServer((req, res) => {
			ownerHit = req.url ?? "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ served: "worker-b" }));
		});
		const affinityOrigin = await listen(affinity);
		const targets = { "worker-a": "http://127.0.0.1:1", "worker-b": affinityOrigin };
		const tenantId = tenantOn("worker-a", targets);
		const source = await sourceServer("worker-a", targets, tenantId, async () => ({ owner: null, affinity: "worker-b" }));

		const response = await fetch(`${source}/api/sessions/ses-1`, { method: "GET" });
		expect(response.status).toBe(200);
		expect(response.headers.get("x-inno-durable-shard")).toBe("worker-b");
		expect(await response.json()).toEqual({ served: "worker-b" });
		expect(ownerHit).toBe("/api/sessions/ses-1");
	});

	it("falls back to local service when the session target is unreachable", async () => {
		const targets = { "worker-a": "http://127.0.0.1:1", "worker-b": "http://127.0.0.1:2" };
		const tenantId = tenantOn("worker-b", targets);
		// No live owner: hash target worker-b is a dead port → local fallback.
		const source = await sourceServer("worker-a", targets, tenantId, async () => null);
		const body = JSON.stringify({ sessionId: "ses-2", prompt: "takeover" });
		const response = await fetch(`${source}/api/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ served: "local", body });
	});

	it("keeps tenant-level requests on the hash and answers 502 when it is down", async () => {
		const targets = { "worker-a": "http://127.0.0.1:1", "worker-b": "http://127.0.0.1:2" };
		const tenantId = tenantOn("worker-b", targets);
		const source = await sourceServer("worker-a", targets, tenantId, async () => null);
		const response = await fetch(`${source}/api/settings`, { method: "GET" });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ code: "durable_shard_unavailable" });
	});
});
