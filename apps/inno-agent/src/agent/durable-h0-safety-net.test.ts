import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig } from "../config.js";
import { WorkspaceFileEnv } from "./durable-env.js";
import { findOrphanedSessionData, removeOrphanedSessionData } from "./durable-orphans.js";
import { DurableSessionService } from "./durable-session-service.js";
import { createDurableMemoryRegistrations } from "./durable-memory.js";

/**
 * H0 safety net (docs/DURABLE_ROADMAP.md): behaviour of the file-backed session
 * catalog and the workspace file boundary under concurrency and crashes. Tests
 * regression-test the defects found there (K1 symlink race, K2 catalog writes).
 */

const roots: string[] = [];
const services: DurableSessionService[] = [];
const req = { headers: {} } as IncomingMessage;

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "inno-h0-"));
	roots.push(value);
	return value;
}

function makeService(base: string): DurableSessionService {
	const service = new DurableSessionService({
		dataDir: base,
		getLocalConfig: () => normalizeConfig({
			defaultProvider: "p",
			defaultModel: "m",
			providers: { p: { baseUrl: "http://x.invalid/v1", apiKey: "k", models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000 }] } },
		}),
		enabled: true,
		resolveWorkspaceDir: () => base,
	});
	services.push(service);
	return service;
}

const durableRoot = (base: string) => join(base, "durable");

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session catalog concurrency (single process)", () => {
	it("keeps every create and rename when operations interleave", async () => {
		const service = makeService(root());
		const ids = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
			await Promise.resolve();
			return service.create(req, { workspaceId: `w${i}` }).id;
		}));
		await Promise.all(ids.map(async (id, i) => {
			await Promise.resolve();
			service.rename(req, id, `name-${i}`);
		}));
		const listed = service.list(req);
		expect(new Set(listed.map((s) => s.id)).size).toBe(40);
		expect(listed.map((s) => s.name).sort()).toEqual(ids.map((_, i) => `name-${i}`).sort());
	});

	it("two service instances over one data dir do not lose updates within a process", () => {
		const base = root();
		const a = makeService(base);
		const b = makeService(base);
		for (let i = 0; i < 20; i++) {
			a.create(req, { workspaceId: "a" });
			b.create(req, { workspaceId: "b" });
		}
		expect(a.list(req)).toHaveLength(40);
	});
});

describe("session create/delete crash windows", () => {
	it("create writes only the catalog record; no storage exists until the runtime opens", () => {
		const base = root();
		const session = makeService(base).create(req, { workspaceId: "w" });
		expect(existsSync(join(durableRoot(base), "storage", session.id))).toBe(false);
		expect(findOrphanedSessionData(durableRoot(base))).toEqual([]);
	});

	it("a completed delete leaves no orphan data", async () => {
		const base = root();
		const service = makeService(base);
		const session = service.create(req, { workspaceId: "w" });
		mkdirSync(join(durableRoot(base), "storage", session.id), { recursive: true });
		writeFileSync(join(durableRoot(base), "storage", session.id, "session.sqlite"), "x");
		mkdirSync(join(durableRoot(base), "questions", session.id), { recursive: true });
		await service.delete(req, session.id);
		expect(service.list(req)).toEqual([]);
		expect(findOrphanedSessionData(durableRoot(base))).toEqual([]);
	});

	it("a crash between the catalog write and data removal leaves an orphan that the checker finds and repairs", () => {
		const base = root();
		const service = makeService(base);
		const keep = service.create(req, { workspaceId: "w" });
		const gone = service.create(req, { workspaceId: "w" });
		for (const id of [keep.id, gone.id]) {
			mkdirSync(join(durableRoot(base), "storage", id), { recursive: true });
			writeFileSync(join(durableRoot(base), "storage", id, "session.sqlite"), "x");
		}
		mkdirSync(join(durableRoot(base), "permissions", gone.id), { recursive: true });
		// Simulate delete()'s order: catalog record first, data afterwards, crash in between.
		const catalogPath = join(durableRoot(base), "sessions.json");
		const records = (JSON.parse(readFileSync(catalogPath, "utf-8")) as Array<{ id: string }>).filter((r) => r.id !== gone.id);
		writeFileSync(catalogPath, JSON.stringify(records));

		const orphans = findOrphanedSessionData(durableRoot(base));
		expect(orphans.map((o) => o.sessionId)).toEqual([gone.id]);
		expect(orphans[0]!.paths).toHaveLength(2);
		expect(removeOrphanedSessionData(durableRoot(base))).toEqual([gone.id]);
		expect(existsSync(join(durableRoot(base), "storage", gone.id))).toBe(false);
		expect(existsSync(join(durableRoot(base), "storage", keep.id))).toBe(true);
	});

	it("refuses to classify orphans when the catalog is unreadable", () => {
		const base = root();
		const service = makeService(base);
		const session = service.create(req, { workspaceId: "w" });
		mkdirSync(join(durableRoot(base), "storage", session.id), { recursive: true });
		writeFileSync(join(durableRoot(base), "sessions.json"), "{not json");
		expect(() => findOrphanedSessionData(durableRoot(base))).toThrow(/refusing to classify/);
		expect(existsSync(join(durableRoot(base), "storage", session.id))).toBe(true);
	});
});

describe("workspace file boundary under a check/use race", () => {
	/** Swap `f` for a symlink to `target` right after the containment check passed. */
	function raceEnv(workspace: string, target: string) {
		const env = new WorkspaceFileEnv(workspace);
		const original = (env as unknown as { contained: (p: string) => unknown }).contained.bind(env);
		(env as unknown as { contained: (p: string) => unknown }).contained = (path: string) => {
			const result = original(path);
			try {
				unlinkSync(join(workspace, "f"));
				symlinkSync(target, join(workspace, "f"));
			} catch { /* already swapped */ }
			return result;
		};
		return env;
	}

	// Regression for K1: containment used to be checked on the path and the file
	// then opened by path, so a link swapped in between escaped the workspace (a
	// stress probe leaked ~7 of 7800 reads). Reads and writes now open the
	// resolved path with O_NOFOLLOW and verify the opened descriptor.
	it("does not follow a symlink swapped in after the containment check (read)", async () => {
		const base = root();
		const workspace = join(base, "ws");
		mkdirSync(workspace);
		writeFileSync(join(base, "secret.txt"), "SECRET");
		writeFileSync(join(workspace, "f"), "ok");
		const result = await raceEnv(workspace, join(base, "secret.txt")).readTextFile("f", BACKGROUND_CONTEXT);
		expect(result.ok && result.value === "SECRET").toBe(false);
	});

	it("does not write through a symlink swapped in after the containment check (write)", async () => {
		const base = root();
		const workspace = join(base, "ws");
		mkdirSync(workspace);
		writeFileSync(join(base, "victim.txt"), "untouched");
		writeFileSync(join(workspace, "f"), "ok");
		await raceEnv(workspace, join(base, "victim.txt")).writeFile("f", "overwritten", BACKGROUND_CONTEXT);
		expect(readFileSync(join(base, "victim.txt"), "utf-8")).toBe("untouched");
	});
});

describe("workspace file boundary stress", () => {
	it("never leaks outside content while the target flips between file and symlink", async () => {
		const base = root();
		const workspace = join(base, "ws");
		mkdirSync(workspace);
		writeFileSync(join(base, "secret.txt"), "SECRET");
		writeFileSync(join(workspace, "f"), "ok");
		const env = new WorkspaceFileEnv(workspace);
		let stop = false;
		const flipper = (async () => {
			while (!stop) {
				try {
					unlinkSync(join(workspace, "f"));
					symlinkSync(join(base, "secret.txt"), join(workspace, "f"));
					unlinkSync(join(workspace, "f"));
					writeFileSync(join(workspace, "f"), "ok");
				} catch { /* racing the reader */ }
				await new Promise((resolve) => setImmediate(resolve));
			}
		})();
		let leaks = 0;
		const end = Date.now() + 1500;
		while (Date.now() < end) {
			const result = await env.readTextFile("f", BACKGROUND_CONTEXT);
			if (result.ok && result.value === "SECRET") leaks++;
		}
		stop = true;
		await flipper;
		expect(leaks).toBe(0);
	});
});

describe("replay-safe tool audit", () => {
	/**
	 * Every tool declared `replay: "safe"` must have an idempotency basis. A
	 * wrongly-safe tool is re-run after a crash (duplicate side effects); a
	 * wrongly-unsafe one only fails that single call, so keep this list minimal
	 * and add to it only with a stated reason.
	 *
	 * Memory group (agent/durable-memory.ts):
	 * - get_learner_context, assess_learning_prerequisites, review_learner_profile,
	 *   l2_query, l2_lint, l3_recall: read-only.
	 * - record_learning_event, record_learning_evidence, patch_learner_profile,
	 *   update_learner_profile: persisted operation marker keyed session+toolCallId
	 *   (durable-memory.test.ts "once across stable-call retries").
	 * - l2_archive: content-hash dedupe plus resumable manifest records
	 *   (l2-tools.test.ts "deduplicates repeated content", "resumes an incomplete
	 *   manifest record"); deterministic, no nested model call.
	 * Outside this group (audited in docs/DURABLE_ROADMAP.md H0 results):
	 * ask_user_question / write+edit approval: persisted decision by stable call ID;
	 * ocr_image: persisted remote job-ID checkpoint (submit window at-least-once);
	 * send_file_to_channel: persistent outbox (send window at-least-once).
	 */
	it("pins the memory tools that may be marked replay-safe", () => {
		const base = root();
		const tools = createDurableMemoryRegistrations({
			sessionId: "durable-audit",
			learnerDataDir: join(base, "learner"),
			l2DataDir: join(base, "l2"),
			workspaceDir: base,
			l1Enabled: true,
			l2Enabled: true,
		});
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"assess_learning_prerequisites",
			"get_learner_context",
			"l2_archive",
			"l2_lint",
			"l2_query",
			"patch_learner_profile",
			"record_learning_event",
			"record_learning_evidence",
			"review_learner_profile",
			"update_learner_profile",
		]);
		expect(tools.every((tool) => tool.replay === "safe")).toBe(true);
	});
});
