import type { UserInput } from "@earendil-works/pi-durable";
import { formatNativeImageMarker } from "../server/inline-images.js";

/**
 * Model input that is safe to journal and to commit into durable entries.
 * Vision bytes stay in `.chat-images/` (object storage); the transcript keeps a
 * path marker that `beforeRequest` expands only for the provider call.
 */
export function buildDurableUserInput(
	prompt: string,
	parts: {
		nativeImages?: ReadonlyArray<{ workspacePath: string; mimeType: string }>;
		fallbackContext?: string;
		attachmentContext?: string;
		recallContext?: string;
	},
): UserInput {
	const marker = parts.nativeImages?.length ? formatNativeImageMarker(parts.nativeImages) : "";
	if (!marker && !parts.fallbackContext && !parts.attachmentContext && !parts.recallContext) return prompt;
	const content: Exclude<UserInput, string> = [{ type: "text", text: prompt }];
	if (marker) content.push({ type: "text", text: marker });
	if (parts.fallbackContext) content.push({ type: "text", text: parts.fallbackContext });
	if (parts.attachmentContext) content.push({ type: "text", text: parts.attachmentContext });
	if (parts.recallContext) content.push({ type: "text", text: parts.recallContext });
	return content;
}
