import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { migrateAuthDatabase } from "../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { selectDurableShard, type DurableShardConfig } from "./durable-tenant-router.js";
import { durableStorageLockKey } from "./store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SECRET = "durable-shard-integration-secret-at-least-32-characters";
type WorkerId = "worker-a" | "worker-b";
interface Worker {
	id: WorkerId;
	home: string;
	origin: string;
	child?: ChildProcess;
	output: string;
}

let postgres: TemporaryPostgres;
let objectStoreDir = "";
let provider: HttpServer;
let sidecar: HttpServer;
let providerOrigin = "";
let sidecarOrigin = "";
let publicOrigin = "";
let shardConfig: DurableShardConfig;
const workers: Record<WorkerId, Worker> = {
	"worker-a": { id: "worker-a", home: "", origin: "", output: "" },
	"worker-b": { id: "worker-b", home: "", origin: "", output: "" },
};

async function freePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolveListen, reject) => listener.listen(0, "127.0.0.1", resolveListen).once("error", reject));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Missing free port");
	const port = address.port;
	await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
	return port;
}

async function startWorker(worker: Worker): Promise<void> {
	worker.output = "";
	worker.child = spawn(process.execPath, ["--import", "tsx", resolve(root, "apps/inno-agent/src/server.ts")], {
		cwd: root,
		env: {
			...process.env,
			INNO_HOME: worker.home,
			INNO_CONFIG_DIR: join(worker.home, "config"),
			INNO_DATA_DIR: join(worker.home, "data"),
			INNO_SKILLS_DIR: join(worker.home, "skills"),
			INNO_WORKSPACE_DIR: join(worker.home, "workspace"),
			INNO_PORT: new URL(worker.origin).port,
			INNO_HOST: "127.0.0.1",
			INNO_AUTH_MODE: "better-auth",
			INNO_MULTI_USER_ENABLED: "true",
			INNO_DURABLE_ENABLED: "true",
			INNO_DURABLE_SHARD_ID: worker.id,
			INNO_DURABLE_SHARD_URLS: JSON.stringify(shardConfig.targets),
			INNO_DURABLE_STORAGE_LEASE_MS: "2000",
			INNO_DURABLE_FORWARD_TIMEOUT_MS: "3000",
			INNO_OBJECT_STORAGE_PROVIDER: "fs",
			INNO_OBJECT_STORAGE_DIR: objectStoreDir,
			DATABASE_URL: postgres.databaseUrl,
			BETTER_AUTH_SECRET: SECRET,
			BETTER_AUTH_URL: publicOrigin,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	worker.child.stdout?.on("data", (chunk) => { worker.output += chunk; });
	worker.child.stderr?.on("data", (chunk) => { worker.output += chunk; });
	const deadline = Date.now() + 20_000;
	while (true) {
		if (worker.child.exitCode !== null) throw new Error(`${worker.id} exited during startup: ${worker.output}`);
		try {
			if ((await fetch(`${worker.origin}/health`)).ok) return;
		} catch {}
		if (Date.now() > deadline) throw new Error(`${worker.id} startup timed out: ${worker.output}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
}

async function api(worker: Worker, cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
	const response = await fetch(`${worker.origin}${path}`, {
		...init,
		headers: {
			Cookie: cookie,
			Origin: publicOrigin,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
	if (response.status >= 400) {
		console.error(`[api ${worker.id} ${init.method ?? "GET"} ${path}] ${response.status}: ${await response.clone().text()}`);
		console.error(`--- ${worker.id} output tail ---\n${worker.output.slice(-3000)}`);
	}
	return response;
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	provider = createHttpServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			// "shard-slow" prompts keep the model call in flight so the owning
			// worker still holds the storage lease while the test freezes it.
			const respond = () => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					`data: ${JSON.stringify({ id: "shard-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model", choices: [{ index: 0, delta: { role: "assistant", content: "shard response" }, finish_reason: null }] })}`,
					"",
					`data: ${JSON.stringify({ id: "shard-stub", object: "chat.completion.chunk", created: 0, model: "tenant-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
					"",
					"data: [DONE]",
					"",
					"",
				].join("\n"));
			};
			if (body.includes("shard-slow")) setTimeout(respond, 4_000);
			else respond();
		});
	});
	await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
	providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
	sidecar = createHttpServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolveListen) => sidecar.listen(0, "127.0.0.1", resolveListen));
	sidecarOrigin = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
	const [portA, portB] = await Promise.all([freePort(), freePort()]);
	workers["worker-a"].origin = `http://127.0.0.1:${portA}`;
	workers["worker-b"].origin = `http://127.0.0.1:${portB}`;
	publicOrigin = workers["worker-a"].origin;
	shardConfig = {
		localShardId: "worker-a",
		targets: { "worker-a": workers["worker-a"].origin, "worker-b": workers["worker-b"].origin },
	};
	objectStoreDir = await mkdtemp(join(tmpdir(), "inno-objects-"));
	for (const worker of Object.values(workers)) {
		worker.home = await mkdtemp(join(tmpdir(), `inno-${worker.id}-`));
		await mkdir(join(worker.home, "config"), { recursive: true });
		await writeFile(join(worker.home, "config", "config.json"), JSON.stringify({
			defaultProvider: "dummy",
			defaultModel: "dummy-model",
			providers: { dummy: { baseUrl: "http://127.0.0.1:9", apiKey: "unused", api: "openai-completions", models: [{ id: "dummy-model" }] } },
		}));
	}
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: publicOrigin,
	}));
	await Promise.all(Object.values(workers).map(startWorker));
}, 180_000);

afterAll(async () => {
	await Promise.all(Object.values(workers).map(async (worker) => {
		// A signal-killed child keeps exitCode === null; signalCode is the liveness signal.
		if (worker.child && worker.child.exitCode === null && worker.child.signalCode === null) {
			// SIGCONT first: SIGTERM pends on a stopped process and would hang the wait.
			worker.child.kill("SIGCONT");
			worker.child.kill("SIGTERM");
			await new Promise<void>((resolveExit) => worker.child!.once("exit", () => resolveExit()));
		}
		if (worker.home) await rm(worker.home, { recursive: true, force: true });
	}));
	if (objectStoreDir) await rm(objectStoreDir, { recursive: true, force: true });
	if (provider) {
		provider.closeAllConnections();
		await new Promise<void>((resolveClose) => provider.close(() => resolveClose()));
	}
	if (sidecar) {
		sidecar.closeAllConnections();
		await new Promise<void>((resolveClose) => sidecar.close(() => resolveClose()));
	}
	await postgres?.close();
}, 120_000);

it("routes a verified tenant and its durable stream to one owning worker", async () => {
	const email = "durable-shard@example.com";
	const registered = await fetch(`${publicOrigin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: publicOrigin },
		body: JSON.stringify({ name: "Durable shard", email, password: "durable-shard-password-123" }),
	});
	expect(registered.status).toBe(200);
	const cookie = registered.headers.get("set-cookie")?.split(";", 1)[0]!;
	// Personal tenants are provisioned on the first authenticated application
	// request, not by Better Auth's account endpoint itself.
	expect((await api(workers["worker-a"], cookie, "/api/sessions")).status).toBe(200);
	const pool = new Pool({ connectionString: postgres.databaseUrl });
	let tenantId: string;
	try {
		const result = await pool.query<{ id: string }>(
			'SELECT tenant.id FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id WHERE account.email = $1',
			[email],
		);
		tenantId = result.rows[0].id;
	} finally {
		await pool.end();
	}
	const ownerId = selectDurableShard(tenantId, shardConfig) as WorkerId;
	const nonOwnerId: WorkerId = ownerId === "worker-a" ? "worker-b" : "worker-a";
	const owner = workers[ownerId];
	const nonOwner = workers[nonOwnerId];

	const configured = await api(nonOwner, cookie, "/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify({
			providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-shard-secret",
			api: "openai-completions", makeDefault: true,
			models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
		}),
	});
	expect(configured.status, await configured.text()).toBe(200);
	expect(configured.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const created = await api(nonOwner, cookie, "/api/sessions", {
		method: "POST", body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: true } }),
	});
	expect(created.status).toBe(201);
	expect(created.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const session = await created.json() as { id: string; workspaceId: string };
	const tenantStorage = (worker: Worker) => join(worker.home, "data", "tenants", tenantId, "durable", "storage", session.id, "session.sqlite");
	expect(existsSync(tenantStorage(nonOwner))).toBe(false);

	// A session-scoped request without a recorded live owner still follows the
	// tenant hash; the receiving worker claims the storage lease as it opens the
	// session and becomes the recorded owner.
	const streamed = await api(nonOwner, cookie, "/api/chat/stream", {
		method: "POST",
		body: JSON.stringify({ sessionId: session.id, prompt: "durable shard prompt", clientRequestId: "durable-shard-request" }),
	});
	expect(streamed.status).toBe(200);
	expect(streamed.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const text = await streamed.text();
	expect(text).toContain("shard response");
	expect(text).toContain('"type":"done"');
	// Durable state lives in the tenant's PostgreSQL storage, not a per-worker file.
	const storageRows = new Pool({ connectionString: postgres.databaseUrl });
	try {
		const entries = await storageRows.query<{ n: string }>(
			"SELECT COUNT(*)::text AS n FROM ds_entries WHERE session_id = $1",
			[session.id],
		);
		expect(Number(entries.rows[0]!.n)).toBeGreaterThan(0);
	} finally {
		await storageRows.end();
	}
	// Session-scoped requests anywhere follow the live recorded owner, whether
	// the session id arrives in the URL or the request body.
	const detail = await api(nonOwner, cookie, `/api/sessions/${session.id}`);
	expect(detail.status).toBe(200);
	expect(detail.headers.get("x-inno-durable-shard")).toBe(ownerId);
	expect(await detail.json()).toMatchObject({ id: session.id, runtime: "durable" });
	const status = await api(owner, cookie, `/api/chat/status/${session.id}`);
	expect(status.status).toBe(200);
	await status.text();
	expect(existsSync(tenantStorage(nonOwner))).toBe(false);

	const bridgeToken = "durable-shard-bridge-token";
	const channels = await api(nonOwner, cookie, "/api/settings/channels", {
		method: "PUT",
		body: JSON.stringify({
			bridge: { token: bridgeToken },
			channels: { qq: { enabled: true, mode: "bridge", sidecarBaseUrl: sidecarOrigin } },
		}),
	});
	expect(channels.status).toBe(200);
	expect(channels.headers.get("x-inno-durable-shard")).toBe(ownerId);
	const callback = await fetch(`${nonOwner.origin}/api/bridge/messages`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bridgeToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ channel: "qq", messageId: "shard-inbound", chatId: "shard-chat", text: "bridge shard prompt" }),
	});
	expect(callback.status).toBe(200);
	expect(callback.headers.get("x-inno-durable-shard")).toBe(ownerId);
	let runs: Array<{ messageId: string; status: string }> = [];
	const deadline = Date.now() + 15_000;
	while (!runs.some((run) => run.messageId === "shard-inbound" && run.status === "success")) {
		const response = await api(nonOwner, cookie, "/api/channels/runs");
		expect(response.status).toBe(200);
		runs = await response.json() as Array<{ messageId: string; status: string }>;
		if (Date.now() > deadline) throw new Error(`Bridge callback did not finish on its owner: ${JSON.stringify(runs)}`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	const runLog = (worker: Worker) => join(worker.home, "data", "tenants", tenantId, "channels", "runs.jsonl");
	expect(existsSync(runLog(owner))).toBe(true);
	expect(existsSync(runLog(nonOwner))).toBe(false);

	// Takeover: kill the recorded owner mid-lease. The next session request is
	// still hashed toward it, but the dead worker is unreachable so the request
	// falls back to local service and claims the lease itself. The epoch only
	// ever increments on a successful claim, so its growth proves the takeover.
	const epochBefore = await new Pool({ connectionString: postgres.databaseUrl });
	let epoch = "0";
	try {
		const row = await epochBefore.query<{ lease_epoch: string }>(
			"SELECT lease_epoch::text AS lease_epoch FROM ds_metadata WHERE session_id = $1",
			[session.id],
		);
		epoch = row.rows[0]?.lease_epoch ?? "0";
	} finally {
		await epochBefore.end();
	}
	owner.child!.kill("SIGKILL");
	await new Promise<void>((resolveExit) => owner.child!.once("exit", () => resolveExit()));
	// PostgreSQL reaps the dead backend asynchronously; the advisory lock can
	// linger in pg_locks for a moment, during which a claim still sees a live
	// owner. Wait for it to disappear so the takeover is deterministic.
	const locksPool = new Pool({ connectionString: postgres.databaseUrl });
	try {
		const lockKey = BigInt(durableStorageLockKey(tenantId, session.id));
		const classid = Number(BigInt.asIntN(32, lockKey >> 32n));
		const objid = Number(BigInt.asIntN(32, lockKey));
		const lockDeadline = Date.now() + 10_000;
		while (true) {
			const held = await locksPool.query(
				"SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted",
				[classid, objid],
			);
			if (held.rowCount === 0) break;
			if (Date.now() > lockDeadline) throw new Error("dead owner's advisory lock was not released");
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	} finally {
		await locksPool.end();
	}
	const takenOver = await api(nonOwner, cookie, "/api/chat/stream", {
		method: "POST",
		body: JSON.stringify({ sessionId: session.id, prompt: "takeover prompt", clientRequestId: "durable-shard-takeover" }),
	});
	expect(takenOver.status).toBe(200);
	expect(takenOver.headers.get("x-inno-durable-shard")).toBeNull();
	const takeoverText = await takenOver.text();
	expect(takeoverText).toContain("shard response");
	expect(takeoverText).toContain('"type":"done"');
	const leaseRows = new Pool({ connectionString: postgres.databaseUrl });
	try {
		const lease = await leaseRows.query<{ lease_epoch: string }>(
			"SELECT lease_epoch::text AS lease_epoch FROM ds_metadata WHERE session_id = $1",
			[session.id],
		);
		expect(Number(lease.rows[0]?.lease_epoch)).toBeGreaterThan(Number(epoch));
	} finally {
		await leaseRows.end();
	}
	// Affinity: the idle session (no live owner) keeps routing to the worker
	// that last claimed its lease — the worker holding its local files.
	await startWorker(owner);
	const affinity = await api(owner, cookie, `/api/chat/status/${session.id}`);
	expect(affinity.status).toBe(200);
	expect(affinity.headers.get("x-inno-durable-shard")).toBe(nonOwnerId);
	await affinity.text();
}, 60_000);

it("takes over from a SIGSTOP zombie owner once its lease expires", async () => {
	// The previous test killed the hash owner (either worker); restart the dead one.
	await Promise.all(Object.values(workers).map(async (worker) => {
		if (worker.child && (worker.child.exitCode !== null || worker.child.signalCode !== null)) {
			await startWorker(worker);
		}
	}));
	const email = "durable-zombie@example.com";
	const registered = await fetch(`${publicOrigin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: publicOrigin },
		body: JSON.stringify({ name: "Durable zombie", email, password: "durable-zombie-password-123" }),
	});
	expect(registered.status).toBe(200);
	const cookie = registered.headers.get("set-cookie")?.split(";", 1)[0]!;
	expect((await api(workers["worker-b"], cookie, "/api/sessions")).status).toBe(200);
	const tenantPool = new Pool({ connectionString: postgres.databaseUrl });
	let tenantId: string;
	try {
		const result = await tenantPool.query<{ id: string }>(
			'SELECT tenant.id FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id WHERE account.email = $1',
			[email],
		);
		tenantId = result.rows[0].id;
	} finally {
		await tenantPool.end();
	}
	const ownerId = selectDurableShard(tenantId, shardConfig) as WorkerId;
	const nonOwnerId: WorkerId = ownerId === "worker-a" ? "worker-b" : "worker-a";
	const owner = workers[ownerId];
	const nonOwner = workers[nonOwnerId];
	const configured = await api(owner, cookie, "/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify({
			providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-shard-secret",
			api: "openai-completions", makeDefault: true,
			models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
		}),
	});
	expect(configured.status, await configured.text()).toBe(200);
	const created = await api(nonOwner, cookie, "/api/sessions", {
		method: "POST", body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: true } }),
	});
	const createdBody = await created.text();
	expect(created.status, createdBody).toBe(201);
	const session = JSON.parse(createdBody) as { id: string };

	// Keep the owner's lease live with an in-flight slow model turn, then freeze
	// it: the advisory lock survives SIGSTOP, so takeover must wait out the lease.
	const slowStream = api(nonOwner, cookie, "/api/chat/stream", {
		method: "POST",
		body: JSON.stringify({ sessionId: session.id, prompt: "shard-slow prompt", clientRequestId: "zombie-slow" }),
	});
	await new Promise((resolveWait) => setTimeout(resolveWait, 800));
	owner.child!.kill("SIGSTOP");
	let entryCount = "0";
	try {
		await new Promise((resolveWait) => setTimeout(resolveWait, 3_500));

		// The forward to the frozen owner stalls (its kernel still completes the
		// handshake), hits the headers timeout, and falls back to local service.
		// The successor restores the still-running turn's durable journal, so a
		// second prompt is refused instead of forking the conversation.
		const refused = await api(nonOwner, cookie, "/api/chat/stream", {
			method: "POST",
			body: JSON.stringify({ sessionId: session.id, prompt: "zombie takeover", clientRequestId: "zombie-takeover" }),
		});
		expect(refused.status, await refused.text()).toBe(409);
		expect(refused.headers.get("x-inno-durable-shard")).toBeNull();

		// Reconnecting the turn's event stream drives the takeover: the
		// successor claims the expired lease (SIGSTOP keeps the advisory lock,
		// so only the lease TTL gives way) and finishes the reacquired
		// submission locally. The durable turn id is server-generated, so it is
		// read back through the status endpoint first.
		const status = await api(nonOwner, cookie, `/api/chat/status/${session.id}`);
		const statusText = await status.text();
		expect(status.status, statusText).toBe(200);
		const statusBody = JSON.parse(statusText) as { found: boolean; stream?: { turnId?: string } };
		const turnId = statusBody.stream?.turnId;
		expect(turnId).toBeTruthy();
		const reattached = await api(nonOwner, cookie,
			`/api/chat/events/${session.id}?turnId=${turnId}&after=0`);
		const reattachedText = await reattached.text();
		expect(reattached.status, reattachedText).toBe(200);
		expect(reattached.headers.get("x-inno-durable-shard")).toBeNull();
		expect(reattachedText).toContain("shard response");
		expect(reattachedText).toContain('"type":"done"');
		// The claim bumped the fencing epoch; owner_worker is already cleared
		// again because the finished turn released its runtime reference.
		const entriesPool = new Pool({ connectionString: postgres.databaseUrl });
		try {
			const lease = await entriesPool.query<{ lease_epoch: string, n: string }>(
				`SELECT metadata.lease_epoch::text AS lease_epoch,
						(SELECT COUNT(*) FROM ds_entries WHERE session_id = $1)::text AS n
				 FROM ds_metadata metadata WHERE session_id = $1`,
				[session.id],
			);
			expect(Number(lease.rows[0]?.lease_epoch)).toBeGreaterThanOrEqual(2);
			entryCount = lease.rows[0]!.n;
		} finally {
			await entriesPool.end();
		}
	} finally {
		// Always unfreeze: a stopped child ignores SIGTERM and would hang teardown.
		owner.child!.kill("SIGCONT");
	}
	// The zombie's buffered model reply is fenced on its stale epoch, so it can
	// no longer write; the next heartbeat loses the epoch race and closes its
	// runtime. Wait a heartbeat window, then prove nothing was duplicated.
	const settled = await slowStream.then(
		(response) => ({ status: response.status, body: "" }),
		() => ({ status: 0, body: "" }),
	);
	expect([200, 0]).toContain(settled.status);
	await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
	const verifyPool = new Pool({ connectionString: postgres.databaseUrl });
	try {
		const after = await verifyPool.query<{ n: string, lease_epoch: string }>(
			`SELECT (SELECT COUNT(*) FROM ds_entries WHERE session_id = $1)::text AS n,
					metadata.lease_epoch::text AS lease_epoch
			 FROM ds_metadata metadata WHERE session_id = $1`,
			[session.id],
		);
		expect(after.rows[0]?.n).toBe(entryCount);
		expect(Number(after.rows[0]?.lease_epoch)).toBeGreaterThanOrEqual(2);
	} finally {
		await verifyPool.end();
	}

	// The revived worker must stay up — a fenced zombie degrades its session
	// runtime, not the whole process — and a fresh prompt is served normally.
	expect(owner.child!.exitCode).toBeNull();
	expect(owner.child!.signalCode).toBeNull();
	expect((await fetch(`${owner.origin}/health`)).ok).toBe(true);
	const revived = await api(nonOwner, cookie, "/api/chat/stream", {
		method: "POST",
		body: JSON.stringify({ sessionId: session.id, prompt: "post-resume prompt", clientRequestId: "zombie-post-resume" }),
	});
	const revivedText = await revived.text();
	expect(revived.status, revivedText).toBe(200);
	// The takeover worker recorded last_worker on its claim, so session
	// affinity keeps the request local instead of hashing it back.
	expect(revived.headers.get("x-inno-durable-shard")).toBeNull();
	expect(revivedText).toContain('"type":"done"');
}, 90_000);

it("restores a session's workspace files on the takeover worker", async () => {
	const email = "durable-workspace@example.com";
	const registered = await fetch(`${publicOrigin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: publicOrigin },
		body: JSON.stringify({ name: "Durable workspace", email, password: "durable-workspace-password-123" }),
	});
	expect(registered.status).toBe(200);
	const cookie = registered.headers.get("set-cookie")?.split(";", 1)[0]!;
	expect((await api(workers["worker-b"], cookie, "/api/sessions")).status).toBe(200);
	const tenantPool = new Pool({ connectionString: postgres.databaseUrl });
	let tenantId: string;
	try {
		const result = await tenantPool.query<{ id: string }>(
			'SELECT tenant.id FROM tenants tenant JOIN "user" account ON account.id = tenant.owner_user_id WHERE account.email = $1',
			[email],
		);
		tenantId = result.rows[0].id;
	} finally {
		await tenantPool.end();
	}
	const ownerId = selectDurableShard(tenantId, shardConfig) as WorkerId;
	const nonOwnerId: WorkerId = ownerId === "worker-a" ? "worker-b" : "worker-a";
	const owner = workers[ownerId];
	const nonOwner = workers[nonOwnerId];

	const configured = await api(nonOwner, cookie, "/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify({
			providerId: "shared", baseUrl: providerOrigin, apiKey: "durable-shard-secret",
			api: "openai-completions", makeDefault: true,
			models: [{ id: "tenant-model", name: "Tenant model", contextWindow: 32_000, maxTokens: 2_000 }],
		}),
	});
	expect(configured.status).toBe(200);
	const created = await api(nonOwner, cookie, "/api/sessions", {
		method: "POST", body: JSON.stringify({ runtime: "durable", newWorkspace: { isTemp: true } }),
	});
	expect(created.status).toBe(201);
	const session = await created.json() as { id: string; workspaceId: string };

	// A workspace upload lands on the hash owner and is mirrored into the
	// tenant's object-store replica (objects + workspace_files listing rows).
	const upload = await api(nonOwner, cookie, "/api/workspace/upload", {
		method: "POST",
		body: JSON.stringify({
			workspaceId: session.workspaceId,
			files: [{ path: "notes/research.txt", dataBase64: Buffer.from("workspace replica content").toString("base64") }],
		}),
	});
	expect(upload.status).toBe(201);
	const listingPool = new Pool({ connectionString: postgres.databaseUrl });
	try {
		const rows = await listingPool.query<{ files: string; dirs: string }>(
			`SELECT COUNT(*) FILTER (WHERE kind = 'file')::text AS files,
					COUNT(*) FILTER (WHERE kind = 'directory')::text AS dirs
			 FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2`,
			[tenantId, session.workspaceId],
		);
		expect(Number(rows.rows[0]?.files)).toBe(1);
		expect(Number(rows.rows[0]?.dirs)).toBe(1);
	} finally {
		await listingPool.end();
	}
	// The file only exists on the owner's disk.
	expect(existsSync(join(nonOwner.home, "workspace", ".tmp", `tmp-${tenantId}`, "notes", "research.txt"))).toBe(false);

	// Permanently kill the owner; the survivor takes the lease and must
	// reconstruct the workspace (registry row + files) before running.
	owner.child!.kill("SIGKILL");
	await new Promise<void>((resolveExit) => owner.child!.once("exit", () => resolveExit()));
	const locksPool = new Pool({ connectionString: postgres.databaseUrl });
	try {
		const lockKey = BigInt(durableStorageLockKey(tenantId, session.id));
		const classid = Number(BigInt.asIntN(32, lockKey >> 32n));
		const objid = Number(BigInt.asIntN(32, lockKey));
		const lockDeadline = Date.now() + 10_000;
		while (true) {
			const held = await locksPool.query(
				"SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted",
				[classid, objid],
			);
			if (held.rowCount === 0) break;
			if (Date.now() > lockDeadline) throw new Error("dead owner's advisory lock was not released");
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	} finally {
		await locksPool.end();
	}
	const takenOver = await api(nonOwner, cookie, "/api/chat/stream", {
		method: "POST",
		body: JSON.stringify({ sessionId: session.id, prompt: "workspace takeover prompt", clientRequestId: "workspace-takeover" }),
	});
	expect(takenOver.status).toBe(200);
	const takeoverText = await takenOver.text();
	expect(takeoverText).toContain('"type":"done"');

	// Opening the session materialized the replicated workspace and its files.
	const restored = join(nonOwner.home, "workspace", ".tmp", `tmp-${tenantId}`, "notes", "research.txt");
	expect(existsSync(restored)).toBe(true);
	expect(readFileSync(restored, "utf8")).toBe("workspace replica content");
}, 60_000);
