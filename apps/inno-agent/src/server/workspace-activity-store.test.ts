import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getWorkspaceFileActivities,
	recordToolWorkspaceActivity,
	recordWorkspaceAttachmentActivity,
	recordWorkspaceFileAccess,
	clearWorkspaceActivity,
} from "./workspace-activity-store.js";
import { recordSessionAttachments } from "./attachments-store.js";
import { FileStateKv } from "../tenants/state-store.js";

let dir: string;
let root: string;
let kv: FileStateKv;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workspace-activity-"));
	root = join(dir, "workspace");
	mkdirSync(root, { recursive: true });
	kv = new FileStateKv(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("workspace activity sidecar", () => {
	it("merges read and write access without storing content", async () => {
		writeFileSync(join(root, "notes.md"), "secret content");
		await recordWorkspaceFileAccess(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, paths: ["notes.md"], access: "read" });
		await recordToolWorkspaceActivity(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, toolName: "write_file", args: { path: "notes.md" } });
		await recordWorkspaceAttachmentActivity(kv, {
			sessionId: "s1",
			workspaceId: "w1",
			workspaceRoot: root,
			attachments: { bindings: [], loose: [{ path: "notes.md", kind: "file", source: "workspace" }] },
		});
		expect(JSON.stringify(await kv.get("activity:s1"))).not.toContain("secret content");
		expect(await getWorkspaceFileActivities(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root })).toMatchObject({
			trackingIncomplete: false,
			files: [{ sessionId: "s1", workspaceId: "w1", path: "notes.md", access: "read_write" }],
		});
	});

	it("marks indirect shell access incomplete and ignores dependency paths", async () => {
		mkdirSync(join(root, "node_modules"), { recursive: true });
		writeFileSync(join(root, "node_modules", "ignored.js"), "x");
		await recordToolWorkspaceActivity(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, toolName: "bash", args: { command: "cat notes.md" } });
		await recordWorkspaceFileAccess(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, paths: ["node_modules/ignored.js", "agent.md"], access: "read" });
		const activity = await getWorkspaceFileActivities(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root });
		expect(activity.trackingIncomplete).toBe(true);
		expect(activity.files.map((file) => file.path)).toEqual(["agent.md"]);
	});

	it("falls back to recorded attachments and marks the estimate incomplete", async () => {
		writeFileSync(join(root, "legacy.md"), "old");
		await recordSessionAttachments(kv, "s1", {
			promptContent: "read it",
			attachments: { bindings: [], loose: [{ path: "legacy.md", kind: "file", source: "workspace" }] },
			timestamp: Date.parse("2026-09-17T00:00:00.000Z"),
			workspaceId: "w1",
		});
		const activity = await getWorkspaceFileActivities(kv, {
			sessionId: "s1",
			workspaceId: "w1",
			workspaceRoot: root,
			hasSessionHistory: true,
		});
		expect(activity.files).toEqual([expect.objectContaining({ path: "legacy.md", access: "read" })]);
		expect(activity.trackingIncomplete).toBe(true);
	});

	it("does not attribute attachments recorded for another or no workspace", async () => {
		writeFileSync(join(root, "same.md"), "current workspace");
		const attachments = { bindings: [], loose: [{ path: "same.md", kind: "file" as const, source: "workspace" as const }] };
		await recordSessionAttachments(kv, "s1", { promptContent: "a", attachments, timestamp: 1, workspaceId: "w2" });
		await recordSessionAttachments(kv, "s1", { promptContent: "b", attachments, timestamp: 2 });
		const activity = await getWorkspaceFileActivities(kv, {
			sessionId: "s1",
			workspaceId: "w1",
			workspaceRoot: root,
			hasSessionHistory: true,
		});
		expect(activity.files).toEqual([]);
		expect(activity.trackingIncomplete).toBe(true);
	});

	it("deletes the activity row with clearWorkspaceActivity", async () => {
		await recordWorkspaceFileAccess(kv, { sessionId: "s1", workspaceId: "w1", workspaceRoot: root, paths: ["a.md"], access: "write" });
		await clearWorkspaceActivity(kv, "s1");
		expect(await kv.get("activity:s1")).toBeUndefined();
	});
});
