import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimePaths } from "../runtime.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import {
	instantiatePreset,
	listPresets,
	readPresetAgentMd,
	resolvePresetMeta,
} from "./preset-store.js";

describe("preset-store", () => {
	let root = "";

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	function setup(): { paths: RuntimePaths; workspaceDir: string } {
		root = mkdtempSync(join(tmpdir(), "inno-preset-"));
		const presetsDir = join(root, "presets");
		const workspaceDir = join(root, "workspace");
		mkdirSync(presetsDir, { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		const demo = join(presetsDir, "demo");
		mkdirSync(demo);
		writeFileSync(join(demo, "preset.json"), JSON.stringify({
			id: "demo",
			name: "Demo",
			description: "demo preset",
			skills: ["ppt-builder", "bad Id", "ppt-builder", 12],
		}));
		writeFileSync(join(demo, "agent.md"), "preset agent instructions");
		const paths = {
			codeDir: root,
			configDir: join(root, "config"),
			configPath: join(root, "config", "config.json"),
			skillsDir: join(root, "skills"),
			presetsDir,
			workspaceDir,
			webDistDir: join(root, "web"),
		} satisfies RuntimePaths;
		return { paths, workspaceDir };
	}

	it("parses skills and skips invalid entries", () => {
		const { paths } = setup();
		const meta = resolvePresetMeta(paths, "demo");
		expect(meta.skills).toEqual(["ppt-builder"]);
		expect(listPresets(paths)).toHaveLength(1);
		expect(readPresetAgentMd(paths, "demo")).toBe("preset agent instructions");
	});

	it("creates an empty preset workspace without copying agent.md", () => {
		const { paths, workspaceDir } = setup();
		const registry = new WorkspaceRegistry(workspaceDir);
		registry.ensureBootstrapped();
		const meta = resolvePresetMeta(paths, "demo");
		const ws = instantiatePreset(paths, registry, meta, "tenant-a");
		const dir = registry.resolveWorkspaceDir(ws.id)!;
		expect(existsSync(join(dir, "agent.md"))).toBe(false);
		expect(existsSync(join(dir, ".skills"))).toBe(false);
		expect(readFileSync(join(paths.presetsDir, "demo", "agent.md"), "utf-8")).toContain("preset agent");
		const again = instantiatePreset(paths, registry, meta, "tenant-a");
		expect(again.id).toBe(ws.id);
	});
});
