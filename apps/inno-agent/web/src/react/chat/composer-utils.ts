import type { ChatImageRef } from "../../api/chat.js";

export const PASTE_COLLAPSE_LINES = 20;
export const PASTE_COLLAPSE_CHARS = 2000;
const COMPOSER_MIN_LINES = 2;
const COMPOSER_MAX_LINES = 8;

export interface PendingPasteBlock {
	id: number;
	text: string;
}

/**
 * A staged composer attachment. `local` items carry the OS File until send
 * time; `workspace` items reference an existing workspace file and bind/attach instantly.
 */
export interface PendingUpload {
	/** Stable identity for React keys — survives removal of earlier chips. */
	id: number;
	fileName: string;
	/** Workspace-relative path: upload target for local files, existing path for workspace files. */
	path: string;
	/** Present for files selected from the OS; retained for local previews. */
	file?: File;
	source: "local" | "workspace";
	/** Upload lifecycle for local files; workspace items stay "ready". */
	status: "ready" | "uploading" | "failed";
	/** 0-100 upload progress for local files. */
	pct: number;
}

let pendingUploadSeq = 0;

export function localPendingUpload(file: File): PendingUpload {
	return {
		id: ++pendingUploadSeq,
		fileName: file.name,
		path: file.name.replace(/[\\/?%*:|"<>]/g, "_").trim() || `upload-${Date.now()}`,
		file,
		source: "local",
		status: "ready",
		pct: 0,
	};
}

export function workspacePendingUpload(path: string): PendingUpload {
	const name = path.split("/").pop() ?? path;
	return { id: ++pendingUploadSeq, fileName: name, path, source: "workspace", status: "ready", pct: 100 };
}

export function pendingUploadId(): number {
	return ++pendingUploadSeq;
}

/** Flatten a workspace tree into file rows (depth-first, stable order). */
export function flattenWorkspaceFiles(
	node: { type: string; children?: Array<{ name: string; path: string; type: string; children?: unknown[] }> },
	out: Array<{ name: string; path: string }> = [],
	limit = 60,
): Array<{ name: string; path: string }> {
	for (const child of node.children ?? []) {
		if (out.length >= limit) return out;
		if (child.type === "file") out.push({ name: child.name, path: child.path });
		else if (child.type === "directory" && child.children) {
			flattenWorkspaceFiles(child as never, out, limit);
		}
	}
	return out;
}

/** Local file waiting to be uploaded to object storage. The chat request sends only the resulting path. */
export type PreparedInlineImage = {
	file: File;
	name: string;
	mimeType: string;
	previewUrl: string;
};

function parseCssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Resize using the browser's actual wrapped-text height and keep the caret stable. */
export function resizeComposerTextarea(el: HTMLTextAreaElement): number {
	const styles = window.getComputedStyle(el);
	const fontSize = parseCssPixels(styles.fontSize) || 14;
	const lineHeight = parseCssPixels(styles.lineHeight) || fontSize * 1.25;
	const verticalPadding = parseCssPixels(styles.paddingTop) + parseCssPixels(styles.paddingBottom);
	const verticalBorder = parseCssPixels(styles.borderTopWidth) + parseCssPixels(styles.borderBottomWidth);
	const minHeight = Math.ceil(lineHeight * COMPOSER_MIN_LINES + verticalPadding + verticalBorder);
	const maxHeight = Math.ceil(lineHeight * COMPOSER_MAX_LINES + verticalPadding + verticalBorder);
	const selectionStart = el.selectionStart;
	const selectionEnd = el.selectionEnd;
	const previousHeight = el.style.height;
	const previousOverflowY = el.style.overflowY;

	// Reset before measuring so shrinking after delete/cut/undo is symmetrical
	// with growth. scrollHeight is the browser's actual wrapped-text height.
	el.style.height = "auto";
	const contentHeight = el.scrollHeight + verticalBorder;
	const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
	const nextHeightStyle = `${nextHeight}px`;
	const nextOverflowY = contentHeight > maxHeight ? "auto" : "hidden";
	const layoutChanged = previousHeight !== nextHeightStyle || previousOverflowY !== nextOverflowY;
	el.style.height = nextHeightStyle;
	el.style.overflowY = nextOverflowY;
	el.style.overflowX = "hidden";

	// Re-applying the existing selection lets the browser keep the caret in
	// view after the textarea changes between intrinsic and scrollable height.
	if (layoutChanged && document.activeElement === el && selectionStart >= 0 && selectionEnd >= 0) {
		const restoreSelection = () => {
			if (document.activeElement === el) el.setSelectionRange(selectionStart, selectionEnd);
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(restoreSelection);
		else restoreSelection();
	}

	return minHeight;
}

export function isLargeTextPaste(text: string): boolean {
	const lineCount = text.split(/\r\n|\r|\n/).length;
	return lineCount > PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS;
}

export function prepareInlineImage(file: File): PreparedInlineImage {
	return {
		file,
		name: file.name || "image",
		mimeType: file.type || "image/png",
		previewUrl: URL.createObjectURL(file),
	};
}

export function chatImageObjectPath(mimeType: string): string {
	const ext = mimeType === "image/jpeg" ? ".jpg"
		: mimeType === "image/webp" ? ".webp"
		: mimeType === "image/gif" ? ".gif"
		: ".png";
	const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `.chat-images/${id}${ext}`;
}

export function toChatImageRef(path: string, image: PreparedInlineImage): ChatImageRef {
	return { workspacePath: path, mimeType: image.mimeType, previewUrl: image.previewUrl };
}
