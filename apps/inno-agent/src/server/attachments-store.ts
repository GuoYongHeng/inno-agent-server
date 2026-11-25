import { updateTenantState, type TenantStateKv } from "../tenants/state-store.js";
import type { ChatAttachments } from "./attachments.js";
import type { SessionMessageSummary } from "./session-model.js";

/**
 * Sidecar persistence for chat attachment metadata.
 *
 * The PI SDK owns the session JSONL and only stores the user's raw prompt, so
 * bubble bindings / loose attachments are kept in a sidecar JSON keyed by
 * session ID (per-session `tenant_state` rows). Entries are recorded when a chat turn is accepted and merged
 * back into the message list served by GET /api/sessions/:id, matched FIFO by
 * prompt content (the SDK persists the prompt verbatim, so content equality is
 * a stable join key; repeated identical prompts consume entries in order).
 */

export interface SessionAttachmentEntry {
	promptContent: string;
	attachments?: ChatAttachments;
	/** Durable inline images restored as workspace previews, including for
	 * text-only models whose committed model input omits native image blocks. */
	images?: Array<{ mimeType: string; workspacePath: string }>;
	timestamp: number;
	/** Workspace that contained the attached files when the turn was accepted. */
	workspaceId?: string;
	/** Durable request ID deduplicates sidecar metadata on HTTP retries. */
	requestId?: string;
}

export type SessionAttachmentsMetadata = Record<string, SessionAttachmentEntry[]>;

const attachmentsKey = (sessionId: string) => `attachments:${sessionId}`;

/** Read the recorded attachment entries of one session. */
export async function readSessionAttachments(kv: TenantStateKv, sessionId: string): Promise<SessionAttachmentEntry[]> {
	return (await kv.get<SessionAttachmentEntry[]>(attachmentsKey(sessionId))) ?? [];
}

/** Record the attachment metadata for one accepted chat turn. */
export function recordSessionAttachments(
	kv: TenantStateKv,
	sessionId: string,
	entry: SessionAttachmentEntry,
): Promise<void> {
	return updateTenantState<SessionAttachmentEntry[], void>(kv, attachmentsKey(sessionId), (current) => {
		const existing = current ?? [];
		if (entry.requestId && existing.some((candidate) => candidate.requestId === entry.requestId)) {
			return { next: current, result: undefined };
		}
		return { next: [...existing, entry], result: undefined };
	});
}

/** Drop all attachment metadata for a deleted session. */
export function clearSessionAttachments(kv: TenantStateKv, sessionId: string): Promise<void> {
	return kv.delete(attachmentsKey(sessionId));
}

/**
 * Merge recorded attachment metadata into a session's user messages. Each
 * pending entry attaches to the first not-yet-matched user message whose
 * content equals the recorded prompt. Messages without a match pass through
 * untouched, so sessions without attachments are zero-cost.
 */
export async function mergeSessionAttachments(
	kv: TenantStateKv,
	sessionId: string,
	messages: SessionMessageSummary[],
): Promise<SessionMessageSummary[]> {
	const entries = await readSessionAttachments(kv, sessionId);
	if (entries.length === 0) return messages;
	const pending = [...entries];
	return messages.map((message) => {
		if (message.role !== "user" || pending.length === 0) return message;
		const index = pending.findIndex((entry) => entry.promptContent === message.content);
		if (index === -1) return message;
		const [entry] = pending.splice(index, 1);
		return {
			...message,
			...(entry.attachments ? { attachments: entry.attachments } : {}),
			...(entry.images?.length && entry.workspaceId ? {
				images: entry.images.map((image) => ({
					mimeType: image.mimeType,
					previewUrl: `/api/workspace/raw?workspaceId=${encodeURIComponent(entry.workspaceId!)}&path=${encodeURIComponent(image.workspacePath)}`,
				})),
			} : {}),
		};
	});
}
