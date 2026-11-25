import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordWorkspaceFileAccess } from "./workspace-activity-store.js";
import { FileStateKv } from "../tenants/state-store.js";
import { buildWorkspaceSwitchPreview, transferWorkspaceFiles } from "./workspace-switch.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";

let dir: string;
let dataDir: string;
let kv: FileStateKv;
let workspaceDir: string;
let registry: WorkspaceRegistry;
let sourceRoot: string;
let targetRoot: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workspace-switch-"));
	dataDir = join(dir, "data");
	kv = new FileStateKv(dataDir);
	workspaceDir = join(dir, "workspaces");
	registry = new WorkspaceRegistry(workspaceDir);
	registry.ensureBootstrapped();
	const source = registry.createWorkspace({ name: "源" });
	const target = registry.createWorkspace({ name: "目标" });
	registry.bindSession("session-1.jsonl", source.id);
	sourceRoot = registry.resolveWorkspaceDir(source.id)!;
	targetRoot = registry.resolveWorkspaceDir(target.id)!;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function preview() {
	const target = registry.listWorkspaces().find((workspace) => workspace.id !== registry.getSessionWorkspaceId("session-1.jsonl") && !workspace.isTemp);
	if (!target) throw new Error("target workspace missing");
	return buildWorkspaceSwitchPreview({
		kv,
		sessionId: "session-1.jsonl",
		hasSessionHistory: true,
		workspaceRegistry: registry,
		targetWorkspaceId: target.id,
	});
}

describe("workspace switch file safety", () => {
	it("copies and moves selected files while preserving relative paths", async () => {
		writeFileSync(join(sourceRoot, "nested.md"), "hello");
		await recordWorkspaceFileAccess(kv, { sessionId: "session-1.jsonl", workspaceId: registry.getSessionWorkspaceId("session-1.jsonl"), workspaceRoot: sourceRoot, paths: ["nested.md"], access: "read" });
		const currentPreview = await preview();
		const copied = transferWorkspaceFiles({ preview: currentPreview, sourceRoot, targetRoot, fileActions: { "nested.md": "copy" } });
		expect(copied[0]?.status).toBe("copied");
		expect(readFileSync(join(sourceRoot, "nested.md"), "utf8")).toBe("hello");
		expect(readFileSync(join(targetRoot, "nested.md"), "utf8")).toBe("hello");

		rmSync(join(targetRoot, "nested.md"));
		const moved = transferWorkspaceFiles({ preview: currentPreview, sourceRoot, targetRoot, fileActions: { "nested.md": "move" } });
		expect(moved[0]?.status).toBe("moved");
	});

	it("applies an independent action to each selected file and ignores none", async () => {
		writeFileSync(join(sourceRoot, "copy.md"), "copy me");
		writeFileSync(join(sourceRoot, "move.md"), "move me");
		writeFileSync(join(sourceRoot, "keep.md"), "keep me");
		const sourceId = registry.getSessionWorkspaceId("session-1.jsonl");
		await recordWorkspaceFileAccess(kv, { sessionId: "session-1.jsonl", workspaceId: sourceId, workspaceRoot: sourceRoot, paths: ["copy.md", "move.md", "keep.md"], access: "read_write" });
		const currentPreview = await preview();
		const result = transferWorkspaceFiles({
			preview: currentPreview,
			sourceRoot,
			targetRoot,
			fileActions: { "copy.md": "copy", "move.md": "move", "keep.md": "none" },
		});
		expect(result.map((file) => [file.path, file.action, file.status])).toEqual([
			["copy.md", "copy", "copied"],
			["move.md", "move", "moved"],
		]);
		expect(readFileSync(join(sourceRoot, "copy.md"), "utf8")).toBe("copy me");
		expect(() => readFileSync(join(sourceRoot, "move.md"), "utf8")).toThrow();
		expect(() => readFileSync(join(targetRoot, "keep.md"), "utf8")).toThrow();
	});

	it("skips conflicts without overwriting and reports unsafe/non-file entries", async () => {
		writeFileSync(join(sourceRoot, "same.md"), "source");
		writeFileSync(join(targetRoot, "same.md"), "target");
		mkdirSync(join(sourceRoot, "folder"));
		const outside = join(dir, "outside.txt");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(sourceRoot, "link.txt"));
		const sourceId = registry.getSessionWorkspaceId("session-1.jsonl");
		await recordWorkspaceFileAccess(kv, { sessionId: "session-1.jsonl", workspaceId: sourceId, workspaceRoot: sourceRoot, paths: ["same.md", "folder", "link.txt"], access: "write" });
		const currentPreview = await preview();
		expect(currentPreview.files.find((file) => file.path === "same.md")?.selectable).toBe(true);
		expect(currentPreview.files.find((file) => file.path === "folder")?.selectable).toBe(false);
		expect(currentPreview.files.find((file) => file.path === "link.txt")?.selectable).toBe(false);
		const result = transferWorkspaceFiles({ preview: currentPreview, sourceRoot, targetRoot, fileActions: { "same.md": "move", "folder": "move", "link.txt": "move" } });
		expect(result.find((file) => file.path === "same.md")?.status).toBe("conflict");
		expect(readFileSync(join(targetRoot, "same.md"), "utf8")).toBe("target");
		expect(result.filter((file) => file.status === "failed")).toHaveLength(2);
	});
});
