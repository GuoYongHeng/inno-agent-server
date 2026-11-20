import { createHash } from "node:crypto";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { FileRecoveryStore, SerialQueue, type RecoveryRecordStore } from "./recovery-store.js";
import type {
	AuthorizerVerdict,
	PermissionDecision,
	PermissionResponseStatus,
} from "./permission-types.js";

export interface DurablePermissionBinding {
	turnId: string;
	emit?: (event: Record<string, unknown> & { type: string }) => void;
	/** Non-streaming and headless callers deny mutations instead of parking. */
	noUi?: boolean;
}

export interface DurablePermissionAsk {
	toolName: string;
	path: string;
	preview?: string;
}

interface DurablePermissionRecord extends DurablePermissionAsk {
	operationId: string;
	toolCallId: string;
	requestId: string;
	sessionId: string;
	turnId: string;
	createdAt: string;
	result?: {
		decision: PermissionDecision;
		reason?: string;
	};
}

interface PermissionWaiter {
	resolve: (verdict: AuthorizerVerdict) => void;
}

export interface PendingDurablePermission {
	requestId: string;
	sessionId: string;
	turnId: string;
	toolName: string;
	path: string;
	preview?: string;
	createdAt: string;
}

const NO_UI_REASON =
	"Permission prompt unavailable (no streaming web UI). The workspace mutation was denied; " +
	"explain what you wanted to do and ask the user to retry in a streaming session.";

function operationHash(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

function approvalKey(toolName: string, path: string): string {
	return `${toolName}\0${path}`;
}

function verdict(record: DurablePermissionRecord): AuthorizerVerdict {
	if (record.result?.decision !== "deny") return { kind: "allow" };
	return {
		kind: "deny",
		reason: record.result.reason?.trim() || "Denied by the user. Do not retry this operation.",
	};
}

/** Tenant/session-local, replay-safe approvals. A response is committed before
 * the waiter or SSE resolved event is released. Session-wide approvals remain
 * process-local, while the decision for the original tool call survives reopen.
 * Records live in a {@link RecoveryRecordStore}; operations are serialised
 * because an async backend can interleave two callers. */
export class DurablePermissionStore {
	private binding: DurablePermissionBinding | null = null;
	private readonly waiters = new Map<string, PermissionWaiter>();
	private readonly presented = new Set<string>();
	private readonly sessionApprovals = new Set<string>();
	private readonly queue = new SerialQueue();
	private readonly recordStore: RecoveryRecordStore;

	/** `records` is a directory of JSON files (local mode, tests) or a recovery store. */
	constructor(
		readonly sessionId: string,
		records: string | RecoveryRecordStore,
	) {
		this.recordStore = typeof records === "string" ? new FileRecoveryStore(() => records) : records;
	}

	private async load(operationId: string): Promise<DurablePermissionRecord | undefined> {
		const record = await this.recordStore.get<DurablePermissionRecord>(this.sessionId, operationHash(operationId));
		if (!record) return undefined;
		if (record.operationId !== operationId || record.sessionId !== this.sessionId
			|| record.requestId !== `durable-permission-${operationHash(operationId)}`
			|| !record.turnId || !record.createdAt || !record.toolCallId) {
			throw new Error("Durable permission record does not match the tool call");
		}
		return record;
	}

	private async records(): Promise<DurablePermissionRecord[]> {
		return (await this.recordStore.list<DurablePermissionRecord>(this.sessionId)).map(({ value: record }) => {
			if (record.sessionId !== this.sessionId || !record.operationId
				|| record.requestId !== `durable-permission-${operationHash(record.operationId)}`) {
				throw new Error("Invalid durable permission record");
			}
			return record;
		});
	}

	private async save(record: DurablePermissionRecord): Promise<void> {
		await this.recordStore.put(this.sessionId, operationHash(record.operationId), record);
	}

	/** Show a pending card on the bound turn. Runs inside the queue and works on the stored record, never a stale copy. */
	private async presentLocked(operationId: string): Promise<void> {
		const binding = this.binding;
		if (!binding || binding.noUi || !binding.emit) return;
		let record = await this.load(operationId);
		if (!record || record.result) return;
		if (record.turnId !== binding.turnId) {
			record = { ...record, turnId: binding.turnId };
			await this.save(record);
		}
		const key = `${binding.turnId}:${record.operationId}`;
		if (this.presented.has(key)) return;
		this.presented.add(key);
		binding.emit({
			type: "permission_request",
			requestId: record.requestId,
			source: "tool_call",
			surface: record.toolName,
			value: record.path,
			toolName: record.toolName,
			path: record.path,
			preview: record.preview ?? null,
			turnId: record.turnId,
		});
	}

	async bindTurn(binding: DurablePermissionBinding): Promise<void> {
		this.binding = binding;
		if (binding.noUi) return;
		await this.queue.run(async () => {
			for (const record of await this.records()) {
				if (!record.result) await this.presentLocked(record.operationId);
			}
		});
	}

	unbindTurn(turnId?: string): void {
		if (turnId && this.binding?.turnId !== turnId) return;
		this.binding = null;
	}

	async authorize(
		toolCallId: string,
		ask: DurablePermissionAsk,
		signal: AbortSignal,
	): Promise<AuthorizerVerdict> {
		const operationId = `workspace_permission:${this.sessionId}:${toolCallId}`;
		// What is stored cannot hold NUL (PostgreSQL), so compare and persist the cleaned form.
		const clean = (text: string) => text.replaceAll("\0", "\ufffd");
		ask = { toolName: clean(ask.toolName), path: clean(ask.path), ...(ask.preview !== undefined ? { preview: clean(ask.preview) } : {}) };
		const key = approvalKey(ask.toolName, ask.path);
		const settled = await this.queue.run(async (): Promise<{ verdict: AuthorizerVerdict } | { pending: true }> => {
			let record = await this.load(operationId);
			if (record && (record.toolName !== ask.toolName || record.path !== ask.path
				|| record.preview !== ask.preview)) {
				throw new Error("Durable permission arguments changed for the same tool call");
			}
			if (record?.result) return { verdict: verdict(record) };
			if (!this.binding?.noUi && this.sessionApprovals.has(key)) return { verdict: { kind: "allow" } };
			record ??= {
				operationId,
				toolCallId,
				requestId: `durable-permission-${operationHash(operationId)}`,
				sessionId: this.sessionId,
				turnId: this.binding?.turnId ?? `durable-turn-${operationHash(operationId).slice(0, 24)}`,
				toolName: ask.toolName,
				path: ask.path,
				...(ask.preview !== undefined ? { preview: ask.preview } : {}),
				createdAt: new Date().toISOString(),
			};
			if (this.binding?.noUi) {
				const completed = {
					...record,
					result: { decision: "deny" as const, reason: NO_UI_REASON },
				};
				await this.save(completed);
				return { verdict: verdict(completed) };
			}
			await this.save(record);
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Permission wait aborted");
			return { pending: true };
		});
		if ("verdict" in settled) return settled.verdict;
		return new Promise<AuthorizerVerdict>((resolve, reject) => {
			this.waiters.set(operationId, { resolve });
			signal.addEventListener("abort", () => {
				if (!this.waiters.delete(operationId)) return;
				reject(signal.reason instanceof Error ? signal.reason : new Error("Permission wait aborted"));
			}, { once: true });
			// Register the waiter before exposing the card so an immediate response
			// resolves this execution instead of stranding it.
			this.queue.run(() => this.presentLocked(operationId)).catch((error) => {
				if (this.waiters.delete(operationId)) reject(error);
			});
		});
	}

	private async respondLocked(input: {
		turnId: string;
		requestId: string;
		decision: PermissionDecision;
		reason?: string;
	}): Promise<PermissionResponseStatus> {
		const record = (await this.records()).find((item) => item.requestId === input.requestId);
		if (!record) return "not_found";
		if (record.turnId !== input.turnId) return "scope_mismatch";
		if (record.result) return "already_resolved";
		const completed = {
			...record,
			result: {
				decision: input.decision,
				...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
			},
		};
		// Persistence precedes waiter release and the SSE resolved event.
		await this.save(completed);
		if (input.decision === "allow_session") this.sessionApprovals.add(approvalKey(record.toolName, record.path));
		const resolved = verdict(completed);
		this.binding?.emit?.({
			type: "permission_resolved",
			requestId: record.requestId,
			decision: input.decision,
			allowed: resolved.kind === "allow",
		});
		const waiter = this.waiters.get(record.operationId);
		if (waiter) {
			this.waiters.delete(record.operationId);
			waiter.resolve(resolved);
		}
		return "accepted";
	}

	respond(input: {
		turnId: string;
		requestId: string;
		decision: PermissionDecision;
		reason?: string;
	}): Promise<PermissionResponseStatus> {
		return this.queue.run(() => this.respondLocked(input));
	}

	async pendingPermission(): Promise<PendingDurablePermission | undefined> {
		const record = (await this.queue.run(() => this.records())).find((item) => !item.result);
		if (!record) return undefined;
		return {
			requestId: record.requestId,
			sessionId: record.sessionId,
			turnId: record.turnId,
			toolName: record.toolName,
			path: record.path,
			...(record.preview !== undefined ? { preview: record.preview } : {}),
			createdAt: record.createdAt,
		};
	}

	/** Cancellation is a persisted deny, so reopening cannot resurrect the card. */
	cancelTurn(turnId: string): Promise<number> {
		return this.queue.run(async () => {
			let cancelled = 0;
			for (const record of await this.records()) {
				if (record.result || record.turnId !== turnId) continue;
				if (await this.respondLocked({
					turnId,
					requestId: record.requestId,
					decision: "deny",
					reason: "Permission prompt closed (cancelled). The operation was denied.",
				}) === "accepted") cancelled += 1;
			}
			return cancelled;
		});
	}

	pruneCompletedForIdleSession(completedBefore: number): Promise<number> {
		return this.queue.run(async () => {
			let removed = 0;
			for (const entry of await this.recordStore.list<DurablePermissionRecord>(this.sessionId)) {
				if (!entry.value.result || entry.updatedAt > completedBefore) continue;
				await this.recordStore.delete(this.sessionId, entry.key);
				removed += 1;
			}
			return removed;
		});
	}
}

/** Wrap only workspace mutations. Reads stay silent; unsupported shell/delete/
 * rename capabilities remain absent rather than becoming approvable. */
export function withDurableWorkspacePermission(
	tool: ToolRegistration,
	store: DurablePermissionStore,
): ToolRegistration {
	return {
		...tool,
		// The approval wait must resume after reopen. As with other durable file
		// mutations, a crash after the write but before its result commit remains
		// an at-least-once side-effect window.
		replay: "safe",
		async execute(args, api, context) {
			const input = args as { path?: unknown };
			const path = typeof input.path === "string" ? input.path : "";
			const decision = await store.authorize(api.callId, {
				toolName: tool.name,
				path,
				preview: JSON.stringify(args).slice(0, 4_000),
			}, context.abortSignal ?? new AbortController().signal);
			if (decision.kind === "deny") {
				return {
					output: [{ type: "text", text: decision.reason ?? "Workspace mutation denied." }],
					isError: true,
				};
			}
			return tool.execute(args, api, context);
		},
	};
}

/**
 * Approval before a shell command runs in the sandbox. The decision is persisted
 * by the stable call ID, like workspace approvals, but the tool stays
 * non-replayable: a command is never silently run twice after a crash. If the
 * process dies while the card is open, the call returns `interrupted` and the
 * model may ask again. "Allow for this session" applies to the identical
 * command only.
 */
export function withDurableCommandPermission(
	tool: ToolRegistration,
	store: DurablePermissionStore,
): ToolRegistration {
	return {
		...tool,
		async execute(args, api, context) {
			const input = args as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			const decision = await store.authorize(api.callId, {
				toolName: tool.name,
				path: command.slice(0, 500),
				preview: command.slice(0, 4_000),
			}, context.abortSignal ?? new AbortController().signal);
			if (decision.kind === "deny") {
				return {
					output: [{ type: "text", text: decision.reason ?? "Command denied." }],
					isError: true,
				};
			}
			return tool.execute(args, api, context);
		},
	};
}
