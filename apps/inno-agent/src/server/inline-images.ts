import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { logger } from "../logger.js";
import { resolveContainedPath } from "../utils/path-safety.js";

export interface ChatImageRef {
	workspacePath: string;
	mimeType: string;
}

/** Browser uploads land in object storage first. The chat body may only name those files. */
export function parseChatImageRefs(raw: unknown): ChatImageRef[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const first = raw[0];
	if (!first || typeof first !== "object" || !("workspacePath" in first)) return null;
	const refs: ChatImageRef[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") throw new Error("Invalid chat image reference");
		const record = item as { data?: unknown; workspacePath?: unknown; mimeType?: unknown };
		if (typeof record.data === "string") throw new Error("Chat images must be workspace file references");
		const workspacePath = typeof record.workspacePath === "string" ? record.workspacePath.trim() : "";
		const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
		if (!workspacePath.startsWith(".chat-images/") || workspacePath.includes("..") || workspacePath.includes("\\")) {
			throw new Error(`Chat image path is not under .chat-images: ${workspacePath}`);
		}
		if (!mimeType.startsWith("image/")) throw new Error(`Chat image mime type is not an image: ${mimeType}`);
		refs.push({ workspacePath, mimeType });
	}
	return refs;
}

export function parseInlineImages(raw: unknown): ImageContent[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((image): image is { data: string; mimeType: string } => Boolean(
			image && typeof image === "object"
			&& typeof (image as { data?: unknown }).data === "string"
			&& typeof (image as { mimeType?: unknown }).mimeType === "string",
		))
		.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

function mimeTypeToExtension(mimeType: string): string {
	switch (mimeType) {
		case "image/png": return ".png";
		case "image/jpeg": return ".jpg";
		case "image/gif": return ".gif";
		case "image/webp": return ".webp";
		case "image/tiff": return ".tiff";
		case "image/bmp": return ".bmp";
		default: return ".png";
	}
}

/** Persist inline chat images where workspace file tools can read them. A
 * durable content key makes retries idempotent without overwriting a file when
 * a client incorrectly reuses a request ID with different bytes. */
export function persistInlineImages(images: ImageContent[], workspaceRoot: string, contentKey?: string): string[] {
	if (images.length === 0) return [];
	const chatImagesDir = resolveContainedPath(workspaceRoot, ".chat-images");
	if (!chatImagesDir) {
		logger.warn({ workspaceRoot }, "skipping inline image persistence: .chat-images escapes the workspace");
		return [];
	}
	try {
		if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
	} catch (err) {
		logger.warn({ err }, "failed to create .chat-images dir");
		return [];
	}
	const timestamp = Date.now();
	const paths: string[] = [];
	images.forEach((image, index) => {
		const filenameKey = contentKey
			? createHash("sha256").update(`${contentKey}:${index}:${image.data}`).digest("hex").slice(0, 24)
			: `${timestamp}`;
		const filename = `${filenameKey}-${index}${mimeTypeToExtension(image.mimeType)}`;
		try {
			writeFileSync(join(chatImagesDir, filename), Buffer.from(image.data, "base64"));
			paths.push(`.chat-images/${filename}`);
		} catch (err) {
			logger.warn({ err, filename }, "failed to persist inline image");
		}
	});
	return paths;
}

/** Workspace-path record of this turn's uploads, committed with the durable input. */
export function buildImagePathsHint(imagePaths: string[]): string {
	if (imagePaths.length === 0) return "";
	const list = imagePaths.map((path) => `- ${path}`).join("\n");
	return `[用户本轮上传了 ${imagePaths.length} 张图片，已保存到工作区：\n${list}]`;
}

export function prependImagePathsHint(prompt: string, imagePaths: string[]): string {
	const hint = buildImagePathsHint(imagePaths);
	return hint ? `${hint}\n\n${prompt}` : prompt;
}

export function isImagePathsHint(text: string): boolean {
	return text.startsWith("[用户本轮上传了 ");
}

const NATIVE_IMAGE_MARKER_START = "[inno-native-images]";
const NATIVE_IMAGE_MARKER_END = "[/inno-native-images]";

/** Path + mime list stored in the durable transcript instead of base64 image bytes. */
export function formatNativeImageMarker(images: ReadonlyArray<{ workspacePath: string; mimeType: string }>): string {
	const lines = images
		.filter((image) => image.workspacePath.startsWith(".chat-images/") && !image.workspacePath.includes(".."))
		.map((image) => `${image.workspacePath}\t${image.mimeType}`);
	if (lines.length === 0) return "";
	return `${NATIVE_IMAGE_MARKER_START}\n${lines.join("\n")}\n${NATIVE_IMAGE_MARKER_END}`;
}

export function isNativeImageMarker(text: string): boolean {
	return text.startsWith(`${NATIVE_IMAGE_MARKER_START}\n`) && text.trimEnd().endsWith(NATIVE_IMAGE_MARKER_END);
}

export function parseNativeImageMarker(text: string): Array<{ workspacePath: string; mimeType: string }> {
	if (!isNativeImageMarker(text)) return [];
	const body = text.trimEnd().slice(NATIVE_IMAGE_MARKER_START.length, -NATIVE_IMAGE_MARKER_END.length).trim();
	const images: Array<{ workspacePath: string; mimeType: string }> = [];
	for (const line of body.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab <= 0) continue;
		const workspacePath = line.slice(0, tab);
		const mimeType = line.slice(tab + 1);
		if (!workspacePath.startsWith(".chat-images/") || workspacePath.includes("..") || workspacePath.includes("\\")) continue;
		if (!mimeType.startsWith("image/")) continue;
		images.push({ workspacePath, mimeType });
	}
	return images;
}

type ContentMessage = { role: string; content: unknown };

/**
 * Replace native-image markers with image blocks for one provider request.
 * Returns undefined when nothing changed so callers keep the stored transcript.
 */
export async function expandNativeImageMarkers<T extends ContentMessage>(
	messages: readonly T[],
	load: (workspacePath: string, mimeType: string) => Promise<string | undefined>,
): Promise<T[] | undefined> {
	let changed = false;
	const next: T[] = [];
	for (const message of messages) {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) {
			next.push(message);
			continue;
		}
		const blocks: unknown[] = [];
		let messageChanged = false;
		for (const block of message.content as Array<{ type?: string; text?: string }>) {
			if (block?.type === "text" && typeof block.text === "string" && isNativeImageMarker(block.text)) {
				messageChanged = true;
				for (const image of parseNativeImageMarker(block.text)) {
					const data = await load(image.workspacePath, image.mimeType);
					if (!data) continue;
					blocks.push({ type: "image", data, mimeType: image.mimeType });
				}
				continue;
			}
			blocks.push(block);
		}
		if (!messageChanged) {
			next.push(message);
			continue;
		}
		changed = true;
		next.push({ ...message, content: blocks });
	}
	return changed ? next : undefined;
}
