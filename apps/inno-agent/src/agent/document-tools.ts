import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parseDocument, screenshotDocument, DocumentParseError } from "../memory/l2/document-parser.js";
import { logger } from "../logger.js";
import { formatNativeImageMarker, persistInlineImages } from "../server/inline-images.js";
import { defineInnoTool } from "./inno-tool.js";
import { LocalWorkspaceFileAccess } from "../workspace/local-workspace-file-access.js";
import type { WorkspaceFileAccess } from "../workspace/workspace-files.js";

export interface DocumentToolOptions {
	restrictToWorkspace?: boolean;
	/** Session workspace. Durable sessions pass it explicitly; the legacy adapter
	 * supplies the session cwd instead. */
	workspaceDir?: string;
	/** Workspace file access seam; defaults to a local access over workspaceDir. */
	files?: WorkspaceFileAccess;
}

/**
 * Create document parsing tools for the Inno Agent.
 */
export function createDocumentTools(options: DocumentToolOptions = {}): ToolRegistration[] {
	const parseDocumentTool = defineInnoTool({
		name: "parse_document",
		label: "解析文档",
		description:
			"解析 PDF、Word、Excel、PPT 或图片文件，提取文本内容。" +
			"用户想查看文件内容、提取文本、或需要先预览再决定是否归档时调用。" +
			"支持格式：.pdf, .docx, .xlsx, .pptx, .png, .jpg, .jpeg, .gif, .webp, .tiff",
		parameters: Type.Object({
			filePath: Type.String({ description: "文件路径（绝对路径或相对于工作目录的路径）" }),
			includePageDetails: Type.Optional(
				Type.Boolean({
					description: "为 true 时返回每页的文本，默认只返回合并后的全文",
				}),
			),
			includeScreenshots: Type.Optional(
				Type.Boolean({
					description: "为 true 时返回每页的 PNG 截图（仅 PDF 支持），默认 false",
				}),
			),
		}),
		async execute(params, api) {
			const typed = params;
			const reportProgress = (text: string, _phase: string): void => {
				try {
					api.output(text);
				} catch {
					// Progress reporting is best-effort and must never fail parsing.
				}
			};

			// The tool context is session-scoped. The process environment points at
			// the runtime's default workspace and can be different from the
			// workspace bound to the current chat session.
			const workspaceDir = options.workspaceDir || process.env.INNO_WORKSPACE_DIR || process.cwd();
			const files = options.files
				?? new LocalWorkspaceFileAccess({ root: workspaceDir });
			let resolvedPath: string;
			let relPath: string | undefined;
			if (options.restrictToWorkspace) {
				const rel = files.toRelative(typed.filePath);
				if (!rel) {
					return {
						content: [{ type: "text" as const, text: "文件路径必须位于当前工作区内，且不能通过符号链接指向工作区外。" }],
						details: { error: "outside_workspace", filePath: typed.filePath, pageCount: 0, textLength: 0 },
					};
				}
				relPath = rel;
				resolvedPath = rel;
			} else {
				const pathCheck = {
					allowed: true as const,
					resolvedPath: isAbsolute(typed.filePath) ? typed.filePath : resolve(workspaceDir, typed.filePath),
				};
				resolvedPath = pathCheck.resolvedPath;
			}

			// Check file existence before attempting parse
			reportProgress("正在检查文件", "checking");
			if (relPath === undefined) {
				if (!existsSync(resolvedPath)) {
					return {
						content: [{ type: "text" as const, text: `文件不存在: ${typed.filePath}` }],
						details: { error: "file_not_found", filePath: resolvedPath, pageCount: 0, textLength: 0 },
					};
				}
			}

			// Parse document
			let parsed;
			try {
				reportProgress("正在解析文档", "parsing");
				if (relPath !== undefined) {
					const outcome = await files.withLocalFile(relPath, async (localPath) => {
						resolvedPath = localPath;
						return await parseDocument(localPath);
					});
					if (outcome === null) {
						return {
							content: [{ type: "text" as const, text: `文件不存在: ${typed.filePath}` }],
							details: { error: "file_not_found", filePath: typed.filePath, pageCount: 0, textLength: 0 },
						};
					}
					parsed = outcome;
				} else {
					parsed = await parseDocument(resolvedPath);
				}
				reportProgress(`已读取 ${parsed.pageCount} 页，正在整理内容`, "parsed");
			} catch (err) {
				logger.warn({ err, filePath: resolvedPath }, "parse_document tool: document parsing failed");
				const msg = err instanceof DocumentParseError
					? err.message
					: (err instanceof Error ? err.message : String(err));
				const code = err instanceof DocumentParseError ? err.code : "unknown";
				return {
					content: [{ type: "text" as const, text: `文档解析失败: ${msg}` }],
					details: { error: code, filePath: resolvedPath, pageCount: 0, textLength: 0 },
				};
			}

			// Build response
			const lines: string[] = [
				`文件: ${typed.filePath}`,
				`页数: ${parsed.pageCount}`,
				`文本长度: ${parsed.text.length} 字符`,
				"",
				"--- 提取文本 ---",
				parsed.text,
			];

			if (typed.includePageDetails && parsed.pages.length > 1) {
				lines.push("", "--- 逐页文本 ---");
				for (const page of parsed.pages) {
					lines.push(``, `[第 ${page.pageNumber} 页]`, page.text);
				}
			}

			const content: Array<{ type: "text"; text: string }> = [
				{ type: "text", text: lines.join("\n") },
			];

			// Screenshots stay on disk / object storage. The transcript keeps a path
			// marker; the generation hook expands it only for the provider request.
			if (typed.includeScreenshots) {
				try {
					reportProgress("正在生成页面截图", "screenshots");
					const takeShots = async (path: string) => await screenshotDocument(path);
					const screenshots = relPath !== undefined
						? await files.withLocalFile(relPath, (localPath) => takeShots(localPath)) ?? []
						: await takeShots(resolvedPath);
					const persisted = persistInlineImages(
						screenshots.map((shot) => ({
							type: "image" as const,
							data: shot.imageBuffer.toString("base64"),
							mimeType: "image/png",
						})),
						workspaceDir,
						`parse-document:${typed.filePath}:${screenshots.length}`,
					);
					const marker = formatNativeImageMarker(persisted.map((workspacePath) => ({ workspacePath, mimeType: "image/png" })));
					if (marker) content.push({ type: "text", text: marker });
				} catch (err) {
					logger.warn({ err }, "document screenshot generation failed");
					content.push({
						type: "text",
						text: "\n[截图生成失败，可能不支持该文件格式的截图]",
					});
				}
			}

			return {
				content,
				details: {
					filePath: resolvedPath,
					pageCount: parsed.pageCount,
					textLength: parsed.text.length,
				},
			};
		},
	});

	return [parseDocumentTool];
}
