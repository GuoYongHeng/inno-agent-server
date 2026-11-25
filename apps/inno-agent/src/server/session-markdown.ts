import type { SessionMessageSummary, SessionSummary } from "./session-model.js";


/** Format an ISO date string for display; returns "—" on invalid input. */
function safeFormatDate(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	return new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Pretty JSON.stringify with a fallback for non-serializable values. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Serialize a parsed session (summary + merged messages) into a review-friendly
 * Markdown document. User turns become `## 🧑 用户`, assistant turns become
 * `## 🤖 助手`; thinking traces and tool calls are folded into `<details>` so
 * the linear reading flow stays clean while the full trace remains available.
 *
 * Images are inlined as data URLs so the exported file is self-contained.
 */
export function sessionToMarkdown(
	summary: SessionSummary,
	messages: SessionMessageSummary[],
): string {
	const lines: string[] = [];
	const title = summary.name?.trim() || "未命名对话";
	lines.push(`# ${title}`, "");
	const createdAt = safeFormatDate(summary.createdAt);
	const updatedAt = safeFormatDate(summary.updatedAt);
	const channels = summary.channels.length > 0 ? summary.channels.join("、") : "—";
	lines.push(
		`> 共 ${messages.length} 条消息 · 渠道：${channels}`,
		`> 创建：${createdAt} · 更新：${updatedAt}`,
		`> 导出：${new Date().toISOString()}`,
		"",
		"---",
		"",
	);
	for (const msg of messages) {
		const time = safeFormatDate(new Date(msg.timestamp).toISOString());
		if (msg.role === "user") {
			lines.push(`## 🧑 用户`, "");
			lines.push(`*${time}*`, "");
		} else {
			lines.push(`## 🤖 助手`, "");
			lines.push(`*${time}*`, "");
		}
		if (msg.content.trim()) {
			lines.push(msg.content.trim(), "");
		}
		if (msg.images && msg.images.length > 0) {
			for (const img of msg.images) {
				if (img.previewUrl) {
					lines.push(`![image](${img.previewUrl})`, "");
				}
			}
		}
		if (msg.thinking && msg.thinking.trim()) {
			lines.push(
				"<details><summary>💭 思考过程</summary>",
				"",
				msg.thinking.trim(),
				"",
				"</details>",
				"",
			);
		}
		if (msg.tools && msg.tools.length > 0) {
			for (const tool of msg.tools) {
				const tag = tool.isError ? "❌" : "🔧";
				lines.push(
					`<details><summary>${tag} 工具调用：${tool.toolName}</summary>`,
					"",
					"**参数：**",
					"",
					"```json",
					safeStringify(tool.args),
					"```",
					"",
				);
				if (tool.result !== undefined) {
					lines.push("**结果：**", "", "```json", safeStringify(tool.result), "```", "");
				}
				lines.push("</details>", "");
			}
		}
	}
	return lines.join("\n");
}
