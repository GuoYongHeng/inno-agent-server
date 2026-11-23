import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import { readWorkspaceTree, workspaceTreeFromStore } from "../server/routes/workspaces.js";
import type { WorkspaceTreeNode } from "../server/file-helpers.js";
import type { TenantContext, TenantStore, WorkspaceFileRow } from "../tenants/store.js";
import { LocalFsWorkspaceStore } from "./local-fs-workspace-store.js";
import { ObjectWorkspaceStore } from "./object-workspace-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Parity proof for the read-route migration: the unified walk-based tree must
 * reproduce the legacy `readWorkspaceTree` output on local mode, and the same
 * logical content through the object store must yield the same shape.
 */
describe("workspace tree parity", () => {
	/** Directory sizes are filesystem noise (0 in the manifest) — normalize away. */
	function normalized(nodes: WorkspaceTreeNode[]): Array<Record<string, unknown>> {
		return nodes.map(({ name, path, type, children }) => ({
			name, path, type, children: children ? normalized(children) : undefined,
		}));
	}
	function filesAndSizes(nodes: WorkspaceTreeNode[]): Array<Record<string, unknown>> {
		return nodes.map(({ name, path, type, size, children }) => ({
			name, path, type, size: type === "directory" ? 0 : size,
			children: children ? filesAndSizes(children) : undefined,
		}));
	}

	function fixtureWorkspace(): { dir: string; outside: string } {
		const root = mkdtempSync(join(tmpdir(), "inno-tree-parity-"));
		roots.push(root);
		const dir = join(root, "ws");
		const outside = join(root, "outside");
		mkdirSync(join(dir, "notes", "deep"), { recursive: true });
		mkdirSync(join(dir, "empty-folder"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(dir, "readme.md"), "# hi");
		writeFileSync(join(dir, "notes", "想法.txt"), "中文");
		writeFileSync(join(dir, "notes", "deep", "b.bin"), Buffer.from([1, 2, 3]));
		writeFileSync(join(outside, "secret.txt"), "secret");
		mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
		mkdirSync(join(dir, ".git"), { recursive: true });
		mkdirSync(join(dir, ".skills", "demo-skill"), { recursive: true });
		writeFileSync(join(dir, ".skills", "demo-skill", "SKILL.md"), "skill");
		// >200 entries in one directory: the legacy reader caps at 200.
		mkdirSync(join(dir, "crowded"), { recursive: true });
		for (let index = 0; index < 205; index++) {
			writeFileSync(join(dir, "crowded", `f${String(index).padStart(3, "0")}.txt`), String(index));
		}
		symlinkSync(join(dir, "notes"), join(dir, "notes-link"));
		symlinkSync(outside, join(dir, "escape-link"));
		symlinkSync(join(dir, "missing"), join(dir, "broken-link"));
		return { dir, outside };
	}

	it("the walk-based tree equals the legacy readWorkspaceTree on LocalFs (modulo dir size)", async () => {
		const { dir } = fixtureWorkspace();
		const store = new LocalFsWorkspaceStore({ resolveRoot: () => dir });
		const legacy = readWorkspaceTree(dir, dir);
		const viaStore = await workspaceTreeFromStore(store, "ws-1");

		// Escaping/broken symlinks: legacy emitted them as childless nodes; the
		// store hides them (the S1a rule — hidden everywhere, not just unreadable).
		const legacyVisible = normalized(legacy).filter(
			(node) => node.name !== "escape-link" && node.name !== "broken-link",
		);
		expect(normalized(viaStore)).toEqual(legacyVisible);
		// File sizes match; directory sizes differ by design (0 in the store).
		expect(filesAndSizes(viaStore)).toEqual(
			filesAndSizes(legacy.filter((node) => node.name !== "escape-link" && node.name !== "broken-link")),
		);
	});

	it("the same content through ObjectWorkspaceStore yields the same tree shape", async () => {
		const { dir } = fixtureWorkspace();
		const local = new LocalFsWorkspaceStore({ resolveRoot: () => dir });
		const localTree = await workspaceTreeFromStore(local, "ws-1");

		// Seed the same logical content (no symlinks — the manifest has none).
		const fake = new Map<string, WorkspaceFileRow>();
		const objects = new MemoryObjectStore();
		const context = { tenantId: "t-1" } as TenantContext;
		const store = new ObjectWorkspaceStore({
			objects,
			store: {
				async getWorkspaceFile(_c: TenantContext, _w: string, rel: string) { return fake.get(rel) ?? null; },
				async listWorkspaceFilesUnder(_c: TenantContext, _w: string, prefix: string, limit: number) {
					return [...fake.values()].filter((row) => row.relPath.startsWith(prefix)).slice(0, limit);
				},
				async summarizeWorkspacePrefix(_c: TenantContext, _w: string, prefix: string) {
					const rows = [...fake.values()].filter((row) => row.relPath.startsWith(prefix));
					return { count: rows.length, maxMtimeMs: Math.max(0, ...rows.map((row) => row.mtimeMs)) };
				},
				async putWorkspaceFile(_c: TenantContext, _w: string, row: WorkspaceFileRow) { fake.set(row.relPath, row); },
				async deleteWorkspaceFiles() { return []; },
				async moveWorkspaceFiles() { return []; },
				async deleteAllWorkspaceFiles() { /* noop */ },
			} as unknown as TenantStore,
			context,
		});
		for (const name of ["notes", "notes/deep", "empty-folder", "crowded", ".skills", ".skills/demo-skill"]) {
			await store.mkdir("ws-1", name);
		}
		await store.write("ws-1", "readme.md", new TextEncoder().encode("# hi"));
		await store.write("ws-1", "notes/想法.txt", new TextEncoder().encode("中文"));
		await store.write("ws-1", "notes/deep/b.bin", new Uint8Array([1, 2, 3]));
		await store.write("ws-1", ".skills/demo-skill/SKILL.md", new TextEncoder().encode("skill"));
		for (let index = 0; index < 205; index++) {
			await store.write("ws-1", `crowded/f${String(index).padStart(3, "0")}.txt`, new TextEncoder().encode(String(index)));
		}
		const objectTree = await workspaceTreeFromStore(store, "ws-1");

		// The object tree has no symlinks/ignored dirs; compare shape + file sizes.
		const expected = normalized(localTree)
			.filter((node) => node.name !== "notes-link");
		expect(normalized(objectTree)).toEqual(expected);
		expect(filesAndSizes(objectTree)).toEqual(
			filesAndSizes(localTree).filter((node) => node.name !== "notes-link"),
		);
	});
});
