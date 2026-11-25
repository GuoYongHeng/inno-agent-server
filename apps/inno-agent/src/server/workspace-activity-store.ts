import { isAbsolute, relative, resolve } from "node:path";
import { updateTenantState, type TenantStateKv } from "../tenants/state-store.js";
import { isWithin } from "../utils/path-safety.js";
import { normalizeWorkspaceRelativePath, WORKSPACE_IGNORES } from "./file-helpers.js";
import type { ChatAttachments } from "./attachments.js";
import { readSessionAttachments } from "./attachments-store.js";

/**
 * The workspace activity sidecar deliberately stores metadata only.  It never
 * stores a file's contents, tool output, or prompt text.
 */
export type WorkspaceFileAccess = "read" | "write" | "read_write";
type ToolWorkspaceAccess = WorkspaceFileAccess | "unknown" | "none";

export interface WorkspaceFileActivity {
	sessionId: string;
	workspaceId: string;
	path: string;
	access: WorkspaceFileAccess;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface WorkspaceActivitySession {
	files: WorkspaceFileActivity[];
	trackingIncomplete?: boolean;
}

const activityKey = (sessionId: string) => `activity:${sessionId}`;

/** Remove metadata for a deleted session without touching any workspace file. */
export function clearWorkspaceActivity(kv: TenantStateKv, sessionId: string): Promise<void> {
	if (!sessionId) return Promise.resolve();
	return kv.delete(activityKey(sessionId));
}

function normalizeRecordedPath(workspaceRoot: string, rawPath: string): string | null {
	const value = rawPath.trim().replace(/^[`"']|[`"']$/g, "");
	if (!value || value.length > 500 || value.includes("\0") || /^\w[\w+.-]*:\/\//i.test(value)) return null;

	let normalized: string;
	if (isAbsolute(value)) {
		const absolute = resolve(value);
		const root = resolve(workspaceRoot);
		if (!isWithin(root, absolute)) return null;
		normalized = relative(root, absolute).replaceAll("\\", "/");
	} else {
		normalized = normalizeWorkspaceRelativePath(value);
	}

	if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
	const parts = normalized.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || WORKSPACE_IGNORES.has(part))) return null;
	return normalized;
}

function mergeAccess(a: WorkspaceFileAccess, b: WorkspaceFileAccess): WorkspaceFileAccess {
	if (a === b) return a;
	return "read_write";
}

/** Record one or more known paths for a session turn. */
export async function recordWorkspaceFileAccess(
	kv: TenantStateKv,
	input: {
		sessionId: string;
		workspaceId: string;
		workspaceRoot: string;
		paths: string[];
		access: WorkspaceFileAccess;
		seenAt?: string;
	},
): Promise<void> {
	if (!input.sessionId || !input.workspaceId || input.paths.length === 0) return;
	const now = input.seenAt ?? new Date().toISOString();
	await updateTenantState<WorkspaceActivitySession, void>(kv, activityKey(input.sessionId), (current) => {
		const session: WorkspaceActivitySession = current ?? { files: [] };
		const seen = new Set<string>();
		for (const rawPath of input.paths) {
			const path = normalizeRecordedPath(input.workspaceRoot, rawPath);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			const existing = session.files.find((item) => item.workspaceId === input.workspaceId && item.path === path);
			if (existing) {
				existing.access = mergeAccess(existing.access, input.access);
				existing.lastSeenAt = now;
			} else {
				session.files.push({
					sessionId: input.sessionId,
					workspaceId: input.workspaceId,
					path,
					access: input.access,
					firstSeenAt: now,
					lastSeenAt: now,
				});
			}
		}
		return { next: session, result: undefined };
	});
}

/** Mark that one or more historical accesses could not be classified safely. */
export async function markWorkspaceTrackingIncomplete(kv: TenantStateKv, sessionId: string): Promise<void> {
	if (!sessionId) return;
	await updateTenantState<WorkspaceActivitySession, void>(kv, activityKey(sessionId), (current) => {
		const session: WorkspaceActivitySession = current ?? { files: [] };
		if (session.trackingIncomplete) return { next: current, result: undefined };
		return { next: { ...session, trackingIncomplete: true }, result: undefined };
	});
}

const PATH_KEYS = new Set([
	"path", "filePath", "file_path", "filename", "fileName", "mainFile", "main_file",
	"paths", "files", "filePaths", "file_paths",
	"targetPath", "target_path", "newPath", "new_path", "outputPath", "output_path",
	"sourcePath", "source_path", "oldPath", "old_path", "destination", "dest", "to",
	"inputPath", "input_path", "outputFile", "output_file",
]);

function isPathKey(key: string): boolean {
	return PATH_KEYS.has(key) || /(?:^|_)(?:path|file|filename|destination|source|target)(?:$|_)/i.test(key);
}

function collectExplicitPaths(value: unknown, keyHint: string, paths: string[], seen: WeakSet<object>, depth: number): void {
	if (depth > 7 || value == null) return;
	if (typeof value === "string") {
		if (isPathKey(keyHint)) paths.push(value);
		return;
	}
	if (typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectExplicitPaths(item, keyHint, paths, seen, depth + 1);
		return;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		collectExplicitPaths(child, key, paths, seen, depth + 1);
	}
}

function toolAccess(toolName: string): ToolWorkspaceAccess {
	const name = toolName.toLowerCase();
	if (["ask_user_question", "todo", "question", "permission", "skill", "compact"].includes(name)) return "none";
	if (/(^|[_-])(write|edit|patch|create|save|rename|move|delete|remove|upload)([_-]|$)/.test(name)
		|| name === "apply_patch" || name === "create_practice_lab") return "write";
	if (/(^|[_-])(read|open|cat|grep|find|glob|list|parse|search|stat|inspect)([_-]|$)/.test(name)) return "read";
	if (name === "bash" || name === "shell" || name === "exec" || name.includes("terminal")) return "unknown";
	return "unknown";
}

function extractToolActivity(toolName: string, args: unknown): {
	paths: string[];
	access: ToolWorkspaceAccess;
	incomplete: boolean;
} {
	let parsed = args;
	if (typeof args === "string") {
		try {
			parsed = JSON.parse(args);
		} catch {
			// Partial/indirect JSON is not a reliable path record. Never inspect
			// shell command text for paths.
			parsed = undefined;
		}
	}
	const paths: string[] = [];
	if (parsed !== undefined) collectExplicitPaths(parsed, "", paths, new WeakSet<object>(), 0);
	const access = toolAccess(toolName);
	return {
		paths,
		access,
		incomplete: access !== "none" && (access === "unknown" || (args !== undefined && args !== null && parsed === undefined)),
	};
}

/**
 * Record paths exposed directly in a tool call.  Bash/shell command strings
 * are intentionally not parsed: a command can mention a path without
 * actually reading it, and guessing here would make the migration list less
 * trustworthy.
 */
export async function recordToolWorkspaceActivity(
	kv: TenantStateKv,
	input: {
		sessionId: string;
		workspaceId: string;
		workspaceRoot: string;
		toolName: string;
		args?: unknown;
		seenAt?: string;
	},
): Promise<void> {
	const { paths, access, incomplete } = extractToolActivity(input.toolName, input.args);
	if (incomplete) await markWorkspaceTrackingIncomplete(kv, input.sessionId);
	if (paths.length === 0 || access === "unknown" || access === "none") return;
	await recordWorkspaceFileAccess(kv, {
		...input,
		paths,
		access,
	});
}

export function recordWorkspaceAttachmentActivity(
	kv: TenantStateKv,
	input: { sessionId: string; workspaceId: string; workspaceRoot: string; attachments: ChatAttachments; seenAt?: string },
): Promise<void> {
	return recordWorkspaceFileAccess(kv, {
		...input,
		paths: attachmentPaths(input.attachments),
		access: "read",
	});
}

function attachmentPaths(attachments: ChatAttachments): string[] {
	return [
		...attachments.loose.map((file) => file.path),
		...attachments.bindings.flatMap((binding) => binding.files.map((file) => file.path)),
	];
}

function addEphemeralActivity(
	map: Map<string, WorkspaceFileActivity>,
	entry: WorkspaceFileActivity,
): void {
	const key = `${entry.workspaceId}\0${entry.path}`;
	const current = map.get(key);
	if (!current) {
		map.set(key, { ...entry });
		return;
	}
	current.access = mergeAccess(current.access, entry.access);
	current.firstSeenAt = current.firstSeenAt < entry.firstSeenAt ? current.firstSeenAt : entry.firstSeenAt;
	current.lastSeenAt = current.lastSeenAt > entry.lastSeenAt ? current.lastSeenAt : entry.lastSeenAt;
}

async function legacyAttachmentActivities(
	kv: TenantStateKv,
	sessionId: string,
	workspaceId: string,
	workspaceRoot: string,
): Promise<{ files: WorkspaceFileActivity[]; incomplete: boolean; hasAttachments: boolean }> {
	const entries = await readSessionAttachments(kv, sessionId);
	const map = new Map<string, WorkspaceFileActivity>();
	let incomplete = false;
	for (const entry of entries) {
		if (typeof entry.workspaceId !== "string" || !entry.workspaceId) {
			incomplete = true;
			continue;
		}
		if (entry.workspaceId !== workspaceId) continue;
		const attachments = entry.attachments;
		if (!attachments) continue;
		const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		const seenAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
		for (const rawPath of attachmentPaths(attachments)) {
			const path = normalizeRecordedPath(workspaceRoot, rawPath);
			if (!path) continue;
			addEphemeralActivity(map, { sessionId, workspaceId, path, access: "read", firstSeenAt: seenAt, lastSeenAt: seenAt });
		}
	}
	return { files: [...map.values()], incomplete, hasAttachments: entries.length > 0 };
}

/**
 * Read current and best-effort fallback activity for a session/workspace. The
 * attachment-derived fallback intentionally reports incomplete tracking when
 * a session has no explicit activity record, because attachments alone do not
 * show every file the agent touched.
 */
export async function getWorkspaceFileActivities(
	kv: TenantStateKv,
	input: {
		sessionId: string;
		workspaceId: string;
		workspaceRoot: string;
		hasSessionHistory?: boolean;
	},
): Promise<{ files: WorkspaceFileActivity[]; trackingIncomplete: boolean }> {
	const map = new Map<string, WorkspaceFileActivity>();
	const current = await kv.get<WorkspaceActivitySession>(activityKey(input.sessionId));
	const currentFiles = current?.files.filter((entry) => entry.workspaceId === input.workspaceId) ?? [];
	for (const entry of currentFiles) addEphemeralActivity(map, entry);
	const legacyAttachments = await legacyAttachmentActivities(kv, input.sessionId, input.workspaceId, input.workspaceRoot);
	for (const entry of legacyAttachments.files) addEphemeralActivity(map, entry);
	const currentIncomplete = current?.trackingIncomplete === true;
	// Only treat attachment metadata as a fallback when no current activity
	// record exists; otherwise every successfully tracked turn would be marked
	// incomplete merely because it also has attachments.
	const hasCurrentActivity = currentFiles.length > 0;
	const legacyOnly = !hasCurrentActivity && legacyAttachments.hasAttachments;
	const trackingIncomplete = currentIncomplete
		|| legacyAttachments.incomplete
		|| legacyOnly
		|| (input.hasSessionHistory === true && !current && !legacyOnly);
	return { files: [...map.values()], trackingIncomplete };
}
