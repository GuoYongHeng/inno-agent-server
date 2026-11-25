import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildImagePathsHint,
	expandNativeImageMarkers,
	formatNativeImageMarker,
	parseChatImageRefs,
	parseInlineImages,
	persistInlineImages,
	prependImagePathsHint,
} from "./inline-images.js";

describe("inline chat images", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "inno-inline-images-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("accepts workspace image references and rejects inline bytes", () => {
		expect(parseChatImageRefs([{ workspacePath: ".chat-images/a.png", mimeType: "image/png" }])).toEqual([
			{ workspacePath: ".chat-images/a.png", mimeType: "image/png" },
		]);
		expect(parseChatImageRefs([{ data: "aW1hZ2U=", mimeType: "image/png" }])).toBeNull();
		expect(() => parseChatImageRefs([{ workspacePath: "../secret.png", mimeType: "image/png" }])).toThrow(/chat-images/);
		expect(() => parseChatImageRefs([{ workspacePath: ".chat-images/a.png", mimeType: "image/png", data: "aW1hZ2U=" }])).toThrow(/references/);
	});

	it("parses only well-formed image payloads", () => {
		expect(parseInlineImages([
			{ data: "aW1hZ2U=", mimeType: "image/png" },
			{ data: 1, mimeType: "image/png" },
			null,
		])).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		expect(parseInlineImages("no")).toEqual([]);
	});

	it("reuses durable paths for identical retries without overwriting changed bytes", () => {
		const images = parseInlineImages([{ data: "Zmlyc3Q=", mimeType: "image/png" }]);
		const first = persistInlineImages(images, workspace, "request-1");
		const retry = persistInlineImages(images, workspace, "request-1");
		expect(retry).toEqual(first);
		expect(readdirSync(join(workspace, ".chat-images"))).toHaveLength(1);
		expect(readFileSync(join(workspace, first[0]), "utf8")).toBe("first");

		const changed = persistInlineImages(parseInlineImages([{ data: "c2Vjb25k", mimeType: "image/png" }]), workspace, "request-1");
		expect(changed[0]).not.toBe(first[0]);
		expect(readFileSync(join(workspace, first[0]), "utf8")).toBe("first");
		expect(readFileSync(join(workspace, changed[0]), "utf8")).toBe("second");
	});

	it("builds the workspace-path image hint without changing the legacy prompt format", () => {
		const hint = buildImagePathsHint([".chat-images/a.png"]);
		expect(hint).toContain("用户本轮上传了 1 张图片");
		expect(hint).toContain(".chat-images/a.png");
		expect(prependImagePathsHint("总结图片", [".chat-images/a.png"])).toBe(`${hint}\n\n总结图片`);
		expect(prependImagePathsHint("plain", [])).toBe("plain");
	});

	it("stores a path marker and expands it from workspace bytes for one request", async () => {
		const images = parseInlineImages([{ data: "aW1hZ2U=", mimeType: "image/png" }]);
		const paths = persistInlineImages(images, workspace, "vision-1");
		const marker = formatNativeImageMarker([{ workspacePath: paths[0]!, mimeType: "image/png" }]);
		expect(marker).not.toContain("aW1hZ2U=");
		const messages = [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "text", text: marker }] }];
		const expanded = await expandNativeImageMarkers(messages, async (relPath) => {
			expect(relPath).toBe(paths[0]);
			return readFileSync(join(workspace, relPath)).toString("base64");
		});
		expect(expanded?.[0]?.content).toEqual([
			{ type: "text", text: "看图" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		]);
		expect(await expandNativeImageMarkers(messages, async () => undefined)).toEqual([{
			role: "user",
			content: [{ type: "text", text: "看图" }],
		}]);
	});
});
