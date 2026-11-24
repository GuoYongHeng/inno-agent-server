import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import type { TenantStore } from "../tenants/store.js";
import { FakeTenantStore, ctxA } from "../workspace/fake-tenant-store.js";
import { ObjectWorkspaceStore } from "../workspace/object-workspace-store.js";
import { LocalWorkspaceFileAccess } from "../workspace/local-workspace-file-access.js";
import { StoreWorkspaceFileAccess } from "../workspace/store-workspace-file-access.js";
import type { WorkspaceFileAccess } from "../workspace/workspace-files.js";
import type { WorkspaceStore } from "../workspace/workspace-store.js";
import { ChannelRegistry } from "../channels/channel.js";
import { createChannelTools } from "../channels/channel-tools.js";
import { createDocumentTools } from "./document-tools.js";
import { buildWorkspaceContextSections, buildWorkspaceContextSectionsFrom } from "./workspace-context.js";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { readManifest } from "../memory/l2/manifest-store.js";
import type { L2Memory } from "../memory/l2/l2-memory.js";

const parseDocumentMock = vi.hoisted(() => vi.fn());
const screenshotDocumentMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const summarizeContentMock = vi.hoisted(() => vi.fn());
const generateRichWikiPagesMock = vi.hoisted(() => vi.fn());

vi.mock("../memory/l2/document-parser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../memory/l2/document-parser.js")>();
	return { ...actual, parseDocument: parseDocumentMock, screenshotDocument: screenshotDocumentMock };
});
vi.mock("../memory/l2/summarizer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../memory/l2/summarizer.js")>();
	return { ...actual, summarizeContent: summarizeContentMock };
});
vi.mock("../memory/l2/wiki-generator.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../memory/l2/wiki-generator.js")>();
	return { ...actual, generateRichWikiPages: generateRichWikiPagesMock };
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	parseDocumentMock.mockReset();
	summarizeContentMock.mockReset();
	generateRichWikiPagesMock.mockReset();
	vi.unstubAllGlobals();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-wfa-parity-"));
	tempDirs.push(dir);
	return dir;
}

/** Same logical workspace in a local dir and an ObjectWorkspaceStore. */
async function seedPair(files: Record<string, string>, dirs: string[] = []) {
	const root = join(tempDir(), "ws");
	mkdirSync(root, { recursive: true });
	const tenants = new FakeTenantStore();
	const objects = new MemoryObjectStore();
	const store = new ObjectWorkspaceStore({ objects, store: tenants as unknown as TenantStore, context: ctxA });
	for (const rel of dirs) {
		mkdirSync(join(root, ...rel.split("/")), { recursive: true });
		await store.mkdir("ws-1", rel);
	}
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, ...rel.split("/"));
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, content);
		await store.write("ws-1", rel, new TextEncoder().encode(content));
	}
	return {
		root,
		local: new LocalWorkspaceFileAccess({ root }) as WorkspaceFileAccess,
		stored: new StoreWorkspaceFileAccess({ store, workspaceId: "ws-1", modelRoot: root }) as WorkspaceFileAccess,
		objectStore: store as WorkspaceStore,
	};
}

const executeTool = (tool: { execute: (...args: never[]) => unknown }, params: Record<string, unknown>, callId = "call-1") =>
	(tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>)(
		params,
		{ callId, output: () => undefined, details: async () => undefined },
		{ abortSignal: undefined },
	);

/** Compare tool results ignoring paths that legitimately differ (real vs temp). */
function comparable(result: { content?: Array<{ type: string; text?: string }>; output?: Array<{ type: string; text?: string }>; details: Record<string, unknown> }) {
	const { filePath: _fp, ...details } = result.details;
	const chunks = result.content ?? result.output ?? [];
	return { text: chunks.map((c) => c.text ?? "").join("\n"), details };
}

describe("WorkspaceFileAccess tool parity (local dir vs object store)", () => {
	it("parse_document returns identical results on both impls", async () => {
		const { root, local, stored } = await seedPair({ "docs/note.pdf": "pdf-bytes" });
		parseDocumentMock.mockResolvedValue({ pageCount: 1, text: "parsed text", pages: [{ pageNumber: 1, text: "parsed text" }] });

		const run = (files: WorkspaceFileAccess) => executeTool(
			createDocumentTools({ restrictToWorkspace: true, workspaceDir: root, files })[0] as never,
			{ filePath: "docs/note.pdf" },
		);
		expect(comparable(await run(local))).toEqual(comparable(await run(stored)));

		const reject = (files: WorkspaceFileAccess) => executeTool(
			createDocumentTools({ restrictToWorkspace: true, workspaceDir: root, files })[0] as never,
			{ filePath: "../escape.pdf" },
		);
		expect(comparable(await reject(local))).toEqual(comparable(await reject(stored)));

		const missing = (files: WorkspaceFileAccess) => executeTool(
			createDocumentTools({ restrictToWorkspace: true, workspaceDir: root, files })[0] as never,
			{ filePath: "nope.pdf" },
		);
		expect(comparable(await missing(local))).toEqual(comparable(await missing(stored)));
	});


	it("send_file_to_channel returns identical results on both impls", async () => {
		const { root, local, stored } = await seedPair({ "report.txt": "hello channel" });
		const sent: string[] = [];
		const makeTool = (files?: WorkspaceFileAccess) => {
			const registry = new ChannelRegistry();
			registry.register({
				name: "feishu",
				verify: async () => true,
				parse: async () => null,
				reply: async () => {},
				push: async () => {},
				sendFile: async (_target: unknown, filePath: string) => { sent.push(readFileSync(filePath, "utf-8")); },
			});
			registry.setDefaultTarget({ channel: "feishu", chatId: "chat-1" });
			return createChannelTools({ channelRegistry: registry, workspaceDir: root, files })[0];
		};
		const a = await executeTool(makeTool(local) as never, { filePath: "report.txt", channel: "feishu" });
		const b = await executeTool(makeTool(stored) as never, { filePath: "report.txt", channel: "feishu" });
		expect(comparable(a)).toEqual(comparable(b));
		expect(sent).toEqual(["hello channel", "hello channel"]);

		const rejA = await executeTool(makeTool(local) as never, { filePath: "../x.txt", channel: "feishu" });
		const rejB = await executeTool(makeTool(stored) as never, { filePath: "../x.txt", channel: "feishu" });
		expect(comparable(rejA)).toEqual(comparable(rejB));
	});

	it("workspace context sections are identical across impls and the sync builder", async () => {
		const { root, local, stored } = await seedPair(
			{ "agent.md": "这是工作区说明", ".skills/demo/SKILL.md": "---\nname: demo\ndescription: 演示技能\n---\n内容" },
		);
		const syncSections = buildWorkspaceContextSections(root);
		const localSections = await buildWorkspaceContextSectionsFrom(local);
		const storeSections = await buildWorkspaceContextSectionsFrom(stored);
		expect(localSections).toEqual(syncSections);
		// Store impl materializes .skills into a temp dir, so skill <location>
		// paths differ legitimately; everything else must be identical.
		const stripLocations = (sections: string[]) => sections.map((s) => s.replace(/<location>[^<]*<\/location>/g, "<location>LOC</location>"));
		expect(stripLocations(storeSections)).toEqual(stripLocations(syncSections));
	});

	it("l2_archive file branch produces identical outcomes on both impls", async () => {
		const { root, local, stored } = await seedPair({ "sources/lesson.pdf": "%PDF-bytes" });
		parseDocumentMock.mockResolvedValue({ pageCount: 1, text: "解析出的资料文本", pages: [{ pageNumber: 1, text: "解析出的资料文本" }] });
		summarizeContentMock.mockResolvedValue({ title: "资料", summary: "摘要", keywords: [], folderSuggestion: "folder" });
		generateRichWikiPagesMock.mockResolvedValue([]);
		const fakeMemory = (dir: string) => ({ dataDir: dir, indexPageByPath: vi.fn().mockResolvedValue(undefined) }) as unknown as L2Memory;

		const run = async (files: WorkspaceFileAccess) => {
			const l2Root = join(tempDir(), "l2");
			const tool = createL2Tools(l2Root, undefined, fakeMemory(l2Root), () => root, true, false, undefined, () => files)[0];
			const result = await executeTool(tool as never, {
				title: "资料", filePath: "sources/lesson.pdf", sourceType: "pdf",
			});
			const manifest = await readManifest(l2Root);
			const rawContent = manifest[0]?.rawPath ? readFileSync(join(l2Root, manifest[0].rawPath), "utf-8") : null;
			return { result, rawContent };
		};

		// Archive IDs and raw file names embed random suffixes.
		const normalize = (r: ReturnType<typeof comparable>) => ({
			...r,
			details: Object.fromEntries(Object.entries(r.details).map(([k, v]) => [
				k,
				typeof v === "string"
					? v.replace(/l2src_[a-z0-9]+/g, "ID").replace(/raw\/uploads\/\S+/g, "RAW").replace(/wiki\/\S+\.md/g, "WIKI")
					: v,
			])),
			text: r.text
				.replace(/l2src_[a-z0-9]+/g, "ID")
				.replace(/raw\/uploads\/\S+/g, "RAW")
				.replace(/wiki\/\S+\.md/g, "WIKI"),
		});
		const localRun = await run(local);
		const storeRun = await run(stored);
		expect(normalize(comparable(localRun.result))).toEqual(normalize(comparable(storeRun.result)));
		expect(localRun.rawContent).toBe("%PDF-bytes");
		expect(storeRun.rawContent).toBe("%PDF-bytes");
		expect(parseDocumentMock).toHaveBeenCalledTimes(2);
	});
});
