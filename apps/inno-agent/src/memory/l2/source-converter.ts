import { randomUUID } from "node:crypto";
import { l2Store, type L2Target } from "./l2-backend.js";
import type { RawSourceType } from "./types.js";
import { logger } from "../../logger.js";

/**
 * Convert raw content to extracted markdown and save to extracted/.
 * Returns the relative path from the L2 root.
 */
export async function convertToExtracted(
	target: L2Target,
	title: string,
	content: string,
	sourceType: RawSourceType,
): Promise<string> {
	const markdown = convertContent(content, sourceType);
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const filename = `${slug}-${randomUUID().slice(0, 6)}.md`;
	const rel = `extracted/${filename}`;
	await l2Store(target).writeText(rel, markdown);
	return rel;
}

function convertContent(content: string, sourceType: RawSourceType): string {
	switch (sourceType) {
		case "text":
		case "markdown":
			return content;
		case "conversation":
			return formatConversation(content);
		case "pdf":
		case "word":
		case "image":
			// 文本已由 LiteParse 在上游提取，此处直接透传
			return content;
	}
}

/**
 * Format a conversation snippet into readable markdown.
 * Supports JSON array [{role, content}] or plain text.
 */
function formatConversation(content: string): string {
	try {
		const messages = JSON.parse(content) as Array<{ role: string; content: string }>;
		if (Array.isArray(messages)) {
			const formatted = messages
				.filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
				.map((m) => `**${m.role}**: ${m.content}`)
				.join("\n\n");
			if (formatted) return formatted;
		}
	} catch (err) {
		logger.warn({ err }, "failed to parse conversation JSON, treating as plain text");
		// Not JSON, treat as plain text conversation
	}
	return content;
}
