import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { FileRecoveryStore, SerialQueue, canonicalJson, type RecoveryRecordStore } from "./recovery-store.js";
import type { PersistedQuestion, QuestionBridgeResult, QuestionResponseStatus } from "./question-types.js";
import { QuestionParamsSchema, type QuestionnaireResult } from "./ask-user-question/types.js";
import { buildQuestionnaireResponse, buildToolResult } from "./ask-user-question/response-envelope.js";
import { validateQuestionnaire } from "./ask-user-question/validate-questionnaire.js";

export interface DurableQuestionBinding {
	turnId: string;
	emit?: (event: Record<string, unknown> & { type: string }) => void;
	/** Non-streaming callers have no question UI and resolve new asks as no_ui. */
	noUi?: boolean;
}

interface DurableQuestionRecord extends PersistedQuestion {
	operationId: string;
	toolCallId: string;
	result?: QuestionBridgeResult;
}

interface QuestionWaiter {
	resolve: (result: QuestionBridgeResult) => void;
}

function operationHash(operationId: string): string {
	return createHash("sha256").update(operationId).digest("hex");
}

function validRecord(record: DurableQuestionRecord, sessionId: string): boolean {
	return record.sessionId === sessionId && Boolean(record.operationId)
		&& record.questionId === `durable-question-${operationHash(record.operationId)}`;
}

/** Tenant/session-local question state. Answers are committed before the
 * in-memory waiter is released, so a crash cannot lose an accepted response.
 * Records live in a {@link RecoveryRecordStore} (files locally, PostgreSQL when
 * authenticated); the store's own operations are serialised because an async
 * backend, unlike synchronous file code, can interleave two callers. */
export class DurableQuestionStore {
	private binding: DurableQuestionBinding | null = null;
	private readonly waiters = new Map<string, QuestionWaiter>();
	private readonly presented = new Set<string>();
	private readonly queue = new SerialQueue();
	private readonly records_: RecoveryRecordStore;

	/** `records` is a directory of JSON files (local mode, tests) or a recovery store. */
	constructor(
		readonly sessionId: string,
		records: string | RecoveryRecordStore,
	) {
		this.records_ = typeof records === "string" ? new FileRecoveryStore(() => records) : records;
	}

	private async load(operationId: string): Promise<DurableQuestionRecord | undefined> {
		const record = await this.records_.get<DurableQuestionRecord>(this.sessionId, operationHash(operationId));
		if (!record) return undefined;
		if (record.operationId !== operationId || record.sessionId !== this.sessionId
			|| record.questionId !== `durable-question-${operationHash(operationId)}`
			|| !record.turnId || !record.createdAt || !record.toolCallId) {
			throw new Error("Durable question record does not match the tool call");
		}
		return record;
	}

	private async records(): Promise<DurableQuestionRecord[]> {
		return (await this.records_.list<DurableQuestionRecord>(this.sessionId)).map((entry) => {
			if (!validRecord(entry.value, this.sessionId)) throw new Error("Invalid durable question record");
			return entry.value;
		});
	}

	private async save(record: DurableQuestionRecord): Promise<void> {
		await this.records_.put(this.sessionId, operationHash(record.operationId), record);
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
			type: "question",
			questionId: record.questionId,
			params: record.params,
			toolCallId: record.toolCallId,
		});
	}

	async bindTurn(binding: DurableQuestionBinding): Promise<void> {
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

	async ask(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
	): Promise<QuestionBridgeResult> {
		const operationId = `ask_user_question:${this.sessionId}:${toolCallId}`;
		const hash = operationHash(operationId);
		const settled = await this.queue.run(async (): Promise<{ result: QuestionBridgeResult } | { pending: true }> => {
			let record = await this.load(operationId);
			if (record && canonicalJson(record.params) !== canonicalJson(params)) {
				throw new Error("Durable question arguments changed for the same tool call");
			}
			record ??= {
				operationId,
				toolCallId,
				questionId: `durable-question-${hash}`,
				sessionId: this.sessionId,
				turnId: this.binding?.turnId ?? `durable-turn-${hash.slice(0, 24)}`,
				params,
				createdAt: new Date().toISOString(),
			};
			if (record.result) return { result: record.result };
			if (this.binding?.noUi) {
				const result: QuestionBridgeResult = { answers: [], cancelled: true, error: "no_ui" };
				await this.save({ ...record, result });
				return { result };
			}
			await this.save(record);
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Question wait aborted");
			return { pending: true };
		});
		if ("result" in settled) return settled.result;
		return new Promise<QuestionBridgeResult>((resolve, reject) => {
			this.waiters.set(operationId, { resolve });
			signal.addEventListener("abort", () => {
				if (!this.waiters.delete(operationId)) return;
				reject(signal.reason instanceof Error ? signal.reason : new Error("Question wait aborted"));
			}, { once: true });
			// Register the waiter before exposing the card so even a synchronous
			// response resolves this execution instead of stranding it.
			this.queue.run(() => this.presentLocked(operationId)).catch((error) => {
				if (this.waiters.delete(operationId)) reject(error);
			});
		});
	}

	private async respondLocked(input: {
		turnId: string;
		questionId: string;
		result: QuestionBridgeResult;
	}): Promise<QuestionResponseStatus> {
		const record = (await this.records()).find((item) => item.questionId === input.questionId);
		if (!record) return "not_found";
		if (record.turnId !== input.turnId) return "scope_mismatch";
		if (record.result) return "already_resolved";
		const completed = { ...record, result: input.result };
		// Persistence precedes waiter release and the SSE resolved event.
		await this.save(completed);
		this.binding?.emit?.({
			type: "question_resolved",
			questionId: record.questionId,
			cancelled: input.result.cancelled,
			...(input.result.error ? { error: input.result.error } : {}),
		});
		const waiter = this.waiters.get(record.operationId);
		if (waiter) {
			this.waiters.delete(record.operationId);
			waiter.resolve(input.result);
		}
		return "accepted";
	}

	respond(input: {
		turnId: string;
		questionId: string;
		result: QuestionBridgeResult;
	}): Promise<QuestionResponseStatus> {
		return this.queue.run(() => this.respondLocked(input));
	}

	async pendingQuestion(): Promise<PersistedQuestion | undefined> {
		const record = (await this.queue.run(() => this.records())).find((item) => !item.result);
		if (!record) return undefined;
		return {
			questionId: record.questionId,
			sessionId: record.sessionId,
			turnId: record.turnId,
			params: record.params,
			createdAt: record.createdAt,
		};
	}

	/** Delete completed answers only after the durable runtime proves this session
	 * has no live work that could replay the original ask_user_question call. */
	pruneCompletedForIdleSession(completedBefore: number): Promise<number> {
		return this.queue.run(async () => {
			let removed = 0;
			for (const entry of await this.records_.list<DurableQuestionRecord>(this.sessionId)) {
				if (!entry.value.result || entry.updatedAt > completedBefore) continue;
				await this.records_.delete(this.sessionId, entry.key);
				removed += 1;
			}
			return removed;
		});
	}

	/** Cancellation is an explicit terminal answer, not an abandoned wait: a
	 * later reopen must not resurrect a card for the aborted turn. */
	cancelTurn(turnId: string): Promise<number> {
		return this.queue.run(async () => {
			let cancelled = 0;
			for (const record of await this.records()) {
				if (record.result || record.turnId !== turnId) continue;
				if (await this.respondLocked({
					turnId,
					questionId: record.questionId,
					result: { answers: [], cancelled: true },
				}) === "accepted") cancelled += 1;
			}
			return cancelled;
		});
	}
}

export interface DurableQuestionToolOptions {
	store: DurableQuestionStore;
	workspaceDir: string;
}

/** Replay-safe re-entry presents the same persisted question after reopen. A
 * completed response returns from disk without waiting for another answer. */
export async function createDurableQuestionRegistrations(
	options: DurableQuestionToolOptions,
): Promise<ToolRegistration[]> {
	const tool = defineTool({
		name: "ask_user_question",
		description: "Ask the user one or more questions with predefined options. Supports single-select, multi-select, free text input, and option previews.",
		parameters: QuestionParamsSchema,
		executionMode: "sequential",
		replay: "safe",
		async execute(params, api, context) {
			const validation = validateQuestionnaire(params);
			if (!validation.ok) {
				const result = buildToolResult(validation.message, {
					answers: [], cancelled: true, error: validation.error,
				});
				return { output: result.content, details: result.details as unknown as JsonValue };
			}
			const answer = await options.store.ask(api.callId, params, context.abortSignal ?? new AbortController().signal);
			const result = buildQuestionnaireResponse(answer as QuestionnaireResult, params);
			return { output: result.content, details: result.details as unknown as JsonValue };
		},
	});
	return [tool];
}
