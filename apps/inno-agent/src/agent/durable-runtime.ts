import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	type ConversationId,
	type EntryId,
	type ModelRef,
	type Registry,
	type SettledSubmissionRecord,
	type SnapshotEvent,
	type SubmissionId,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { SandboxExecutionEnv } from "../sandbox/sandbox-env.js";
import type { SandboxRuntimeBinding } from "../sandbox/sandbox-session.js";
import { pruneCompletedChannelOutboxForIdleSession } from "../channels/channel-outbox.js";
import { logger } from "../logger.js";
import { WorkspaceFileEnv } from "./durable-env.js";
import { withNativeImageFallback } from "./native-image-fallback.js";
import { createDurableChannelRegistrations, type DurableChannelToolOptions } from "./durable-channels.js";
import { createDurableMemoryRegistrations, type DurableMemoryToolOptions } from "./durable-memory.js";
import { createDurableOcrRegistrations, type DurableOcrToolOptions } from "./durable-ocr.js";
import {
	withDurableCommandPermission,
	withDurableWorkspacePermission,
	type DurablePermissionBinding,
	type DurablePermissionStore,
} from "./durable-permissions.js";
import {
	createDurableQuestionRegistrations,
	type DurableQuestionBinding,
	type DurableQuestionStore,
	type DurableQuestionToolOptions,
} from "./durable-questions.js";

// Keep the original extension ID stable for existing durable registries.
const WORKSPACE_EXTENSION_NAME = "inno.read-only";
const MEMORY_EXTENSION_NAME = "inno.memory";
const OCR_EXTENSION_NAME = "inno.ocr";
const EXTRA_EXTENSION_NAME = "inno.extra";
const CHANNEL_EXTENSION_NAME = "inno.channels";
const QUESTION_EXTENSION_NAME = "inno.questions";
export const DURABLE_RECOVERY_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Durable SQLite is single-owner. This guard covers accidental double-open in
 * one process; deployment routing must still prevent cross-process owners. */
const openStoragePaths = new Set<string>();

export type DurableBranchErrorCode = "entry_not_found" | "session_busy";

export class DurableBranchError extends Error {
	constructor(readonly code: DurableBranchErrorCode, message: string) {
		super(message);
		this.name = "DurableBranchError";
	}
}

export class DurableStorageOwnerError extends Error {
	constructor(readonly storagePath: string) {
		super(`Durable storage already has an open owner: ${storagePath}`);
		this.name = "DurableStorageOwnerError";
	}
}

type AgentConfig = Parameters<Conversation["configure"]>[0];

/** What a session sends to the model besides its messages, for context accounting. */
export interface DurableContextInfo {
	readonly instructions: string;
	readonly tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
}

export interface DurableSessionRuntimeOptions {
	storagePath: string;
	models: Models;
	model: ModelRef;
	instructions?: string;
	workspaceDir?: string;
	/** Workspace-contained read/write/edit tools. Shell and other mutations stay disabled. */
	workspaceTools?: boolean;
	/** Tenant-local, replay-safe L2/L3 memory tools. */
	memory?: DurableMemoryToolOptions;
	/** Remote OCR recovery checkpoints; submission remains at-least-once. */
	ocr?: DurableOcrToolOptions;
	/** Persistent file-delivery outbox; external sends remain at-least-once. */
	channels?: DurableChannelToolOptions;
	/** Restart-safe workspace write/edit approvals. */
	permissions?: DurablePermissionStore;
	/** Restart-safe web questions; accepted answers persist before resumption. */
	questions?: DurableQuestionToolOptions;
	/** The conversation this session continues in. Omitted: the root conversation.
	 * Editing an earlier message continues in a fork, and the catalog remembers it. */
	conversationId?: string;
	/** Additional native tools (document parsing, web search, scheduler). They keep
	 * the default non-replayable policy: after a crash the model gets an
	 * `interrupted` result instead of a silent re-execution. */
	extraTools?: ToolRegistration[];
	/** Completed recovery-record retention; cleanup runs only with no live work. */
	recoveryRetentionMs?: number;
	registry?: Registry;
	/** Run shell and file tools inside this remote sandbox instead of on the host. */
	sandbox?: SandboxRuntimeBinding;
}

export interface DurableSubmission {
	id: SubmissionId;
}

export type DurableSubmissionResult = {
	id: SubmissionId;
	status: "done";
	answer: AssistantMessage;
	text: string;
} | {
	id: SubmissionId;
	status: "unanswered";
	reason: string;
	detail?: SettledSubmissionRecord["detail"];
};

function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function createWorkspaceFileTools(permissions?: DurablePermissionStore, sandbox?: SandboxRuntimeBinding) {
	const write = createWriteTool();
	const edit = createEditTool();
	const tools: ToolRegistration[] = [
		createReadTool(),
		permissions ? withDurableWorkspacePermission(write, permissions) : write,
		permissions ? withDurableWorkspacePermission(edit, permissions) : edit,
	];
	if (sandbox) {
		const bash = createBashTool();
		tools.push(sandbox.requireApproval && permissions ? withDurableCommandPermission(bash, permissions) : bash);
	}
	return tools;
}

/** Tools that read or write the HOST workspace by path. With a sandbox, what the
 * agent just made lives in the sandbox, so bring it to the host first. */
const HOST_PATH_TOOLS = new Set(["parse_document", "l2_archive", "ocr_image", "send_file_to_channel"]);

function pullBeforeHostPathTools(tools: ToolRegistration[], sandbox?: SandboxRuntimeBinding): ToolRegistration[] {
	if (!sandbox) return tools;
	return tools.map((tool) => HOST_PATH_TOOLS.has(tool.name)
		? {
			...tool,
			async execute(args, api, context) {
				await sandbox.pullToHost();
				return tool.execute(args, api, context);
			},
		}
		: tool);
}

function createSessionRegistry(
	workspaceTools: boolean,
	memory?: DurableMemoryToolOptions,
	ocr?: DurableOcrToolOptions,
	channels?: DurableChannelToolOptions,
	questionTools: ToolRegistration[] = [],
	permissions?: DurablePermissionStore,
	extraTools: ToolRegistration[] = [],
	sandbox?: SandboxRuntimeBinding,
): Registry {
	const registry = createRegistry();
	if (workspaceTools) {
		registry.install(defineExtension({
			name: WORKSPACE_EXTENSION_NAME,
			tools: createWorkspaceFileTools(permissions, sandbox),
		}));
	}
	if (memory) {
		registry.install(defineExtension({
			name: MEMORY_EXTENSION_NAME,
			tools: pullBeforeHostPathTools(createDurableMemoryRegistrations(memory), sandbox),
		}));
	}
	if (ocr) {
		registry.install(defineExtension({
			name: OCR_EXTENSION_NAME,
			tools: pullBeforeHostPathTools(createDurableOcrRegistrations(ocr), sandbox),
		}));
	}
	if (channels) {
		registry.install(defineExtension({
			name: CHANNEL_EXTENSION_NAME,
			tools: pullBeforeHostPathTools(createDurableChannelRegistrations(channels), sandbox),
		}));
	}
	if (questionTools.length > 0) {
		registry.install(defineExtension({
			name: QUESTION_EXTENSION_NAME,
			tools: questionTools,
		}));
	}
	if (extraTools.length > 0) {
		registry.install(defineExtension({
			name: EXTRA_EXTENSION_NAME,
			tools: pullBeforeHostPathTools(extraTools, sandbox),
		}));
	}
	return registry;
}

/**
 * Narrow pi-durable host used by new opt-in sessions. It deliberately does not
 * implement or imitate PI SessionManager JSONL storage.
 */
export class DurableSessionRuntime {
	private constructor(
		readonly storagePath: string,
		private readonly harness: Harness,
		private rootConversation: Conversation,
		private readonly ownsStoragePath: string,
		private readonly permissions?: DurablePermissionStore,
		private readonly questions?: DurableQuestionStore,
		readonly contextInfo: DurableContextInfo = { instructions: "", tools: [] },
		private readonly agentConfig: AgentConfig = {},
		private readonly sandbox?: SandboxRuntimeBinding,
	) {}

	static async open(options: DurableSessionRuntimeOptions): Promise<DurableSessionRuntime> {
		const requestedPath = resolve(options.storagePath);
		await mkdir(dirname(requestedPath), { recursive: true });
		const storagePath = await realpath(requestedPath).catch(async () =>
			join(await realpath(dirname(requestedPath)), basename(requestedPath)));
		if (openStoragePaths.has(storagePath)) throw new DurableStorageOwnerError(storagePath);
		openStoragePaths.add(storagePath);
		try {
			const workspaceTools = options.workspaceTools === true;
			const questionTools = options.questions
				? await createDurableQuestionRegistrations(options.questions)
				: [];
			const registry = options.registry ?? createSessionRegistry(workspaceTools, options.memory, options.ocr, options.channels, questionTools, options.permissions, options.extraTools, options.sandbox);
			const memoryTools = options.memory ? createDurableMemoryRegistrations(options.memory) : [];
			const ocrTools = options.ocr ? createDurableOcrRegistrations(options.ocr) : [];
			const channelTools = options.channels ? createDurableChannelRegistrations(options.channels) : [];
			const tools = pullBeforeHostPathTools(
				[...memoryTools, ...ocrTools, ...channelTools, ...questionTools, ...(options.extraTools ?? [])],
				options.sandbox,
			);
			const harness = await Harness.open(
				await openNodeSqliteStorage(storagePath),
				{
					models: withNativeImageFallback(options.models),
					registry,
					env: options.sandbox
						? () => new SandboxExecutionEnv(options.sandbox!.backend, options.sandbox!.remoteRoot)
						: options.workspaceDir
							? () => new WorkspaceFileEnv(options.workspaceDir!)
							: undefined,
				},
				BACKGROUND_CONTEXT,
			);
			try {
				const agentConfig = {
					model: options.model,
					instructions: options.instructions,
					cwd: options.sandbox?.remoteRoot ?? options.workspaceDir,
					...(workspaceTools ? { tools: [...createWorkspaceFileTools(options.permissions, options.sandbox), ...tools] } : { tools }),
				};
				const root = await harness.root(BACKGROUND_CONTEXT, { agent: agentConfig });
				let rootConversation = root;
				if (options.conversationId) {
					const active = await harness.conversation(Number(options.conversationId) as ConversationId, BACKGROUND_CONTEXT);
					if (!active) throw new Error(`Durable conversation not found: ${options.conversationId}`);
					rootConversation = active;
				}
				// `harness.root()` applies `agent` only when it creates the root, and a fork keeps its
				// parent's agent as of the fork point. Re-apply the current model, instructions,
				// workspace and tools to the conversation this session continues in, so a session that
				// already exists sees newly registered tools, refreshed skills and instructions.
				await rootConversation.configure(agentConfig, BACKGROUND_CONTEXT);
				const inspection = await harness.inspect(BACKGROUND_CONTEXT);
				if (inspection.tasks.length === 0 && inspection.submissions.length === 0) {
					const retentionMs = Math.max(0, options.recoveryRetentionMs ?? DURABLE_RECOVERY_RECORD_RETENTION_MS);
					const completedBefore = Date.now() - retentionMs;
					try {
						if (options.channels) {
							pruneCompletedChannelOutboxForIdleSession(options.channels.outboxDir, options.channels.sessionId, completedBefore);
						}
						options.permissions?.pruneCompletedForIdleSession(completedBefore);
						options.questions?.store.pruneCompletedForIdleSession(completedBefore);
					} catch (error) {
						// Cleanup must never prevent an otherwise recoverable session opening.
						logger.warn({ err: error, storagePath }, "durable recovery-record retention failed (non-fatal)");
					}
				}
				harness.resume();
				const contextTools = [...(workspaceTools ? createWorkspaceFileTools(options.permissions, options.sandbox) : []), ...tools];
				return new DurableSessionRuntime(
					storagePath,
					harness,
					rootConversation,
					storagePath,
					options.permissions,
					options.questions?.store,
					{
						instructions: options.instructions ?? "",
						tools: contextTools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						})),
					},
					agentConfig,
					options.sandbox,
				);
			} catch (error) {
				await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			openStoragePaths.delete(storagePath);
			throw error;
		}
	}

	/** Admission is committed before this resolves. Reusing requestId in the same
	 * conversation returns the original durable submission. */
	async submit(content: UserInput, requestId: string): Promise<DurableSubmission> {
		if (!requestId.trim()) throw new Error("A durable requestId is required");
		await this.sandbox?.beforeTurn();
		const submission = await this.rootConversation.submit({
			type: "input",
			content,
			requestId,
		}, BACKGROUND_CONTEXT);
		return { id: submission.id };
	}

	async appendAssistantNotification(text: string, requestId: string): Promise<void> {
		if (!requestId.trim()) throw new Error("A durable requestId is required");
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "inno-background",
			provider: "inno",
			model: "scheduler",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const submission = await this.rootConversation.submit({
			type: "write",
			requestId,
			entry: { kind: AssistantEntry.kind, model: [message] },
		}, BACKGROUND_CONTEXT);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		if (settled.type !== "write" || settled.status !== "done") {
			throw new Error(`Durable assistant notification was not committed: ${settled.status}`);
		}
	}

	async waitForSubmission(id: SubmissionId, context: Context = BACKGROUND_CONTEXT): Promise<DurableSubmissionResult> {
		const submission = await this.harness.submission(id, context);
		if (!submission) throw new Error(`Durable submission not found: ${id}`);
		const settled = await submission.wait(context);
		await this.sandbox?.pullToHost();
		if (settled.status === "unanswered") {
			return {
				id,
				status: "unanswered",
				reason: settled.reason,
				...(settled.detail !== undefined ? { detail: settled.detail } : {}),
			};
		}
		if (settled.type !== "input") throw new Error(`Unexpected durable submission type: ${settled.type}`);
		const entry = await this.rootConversation.commit(
			(tx) => tx.entry(AssistantEntry, settled.answer),
			context,
		);
		const answer = entry?.model?.[0];
		if (!answer || answer.role !== "assistant") {
			throw new Error(`Durable answer entry is missing its assistant message: ${settled.answer}`);
		}
		return { id, status: "done", answer, text: textFromAssistant(answer) };
	}

	bindPermissionTurn(binding: DurablePermissionBinding): void {
		this.permissions?.bindTurn(binding);
	}

	unbindPermissionTurn(turnId?: string): void {
		this.permissions?.unbindTurn(turnId);
	}

	bindQuestionTurn(binding: DurableQuestionBinding): void {
		this.questions?.bindTurn(binding);
	}

	unbindQuestionTurn(turnId?: string): void {
		this.questions?.unbindTurn(turnId);
	}

	async waitForIdle(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.rootConversation.waitForIdle(context);
	}

	/** Persist the abort marks and wait for the ordinary run/tool scope to become
	 * idle. Reopening the storage will not resume this aborted submission. */
	async abort(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.rootConversation.abort(context);
	}

	/** Persist a model change for this conversation. pi-durable fixes a request's
	 * model when the request is prepared, so a running turn is unaffected and the
	 * new model applies from the next request. */
	async setModel(model: ModelRef, context: Context = BACKGROUND_CONTEXT): Promise<void> {
		await this.rootConversation.configure({ model }, context);
	}

	/** The conversation's committed model messages (user, assistant, tool results),
	 * for context accounting. */
	async contextMessages(): Promise<readonly unknown[]> {
		const snapshot = await this.snapshot();
		return snapshot.entries.flatMap((entry) => entry.model?.[0] ? [entry.model[0]] : []);
	}

	/** The conversation this runtime currently continues in. */
	get conversationId(): string {
		return String(this.rootConversation.id);
	}

	/**
	 * Continue the session in a new conversation that holds everything before the
	 * given user message, so that message and the replies after it are no longer
	 * part of the visible history or the model's context. The earlier conversation
	 * is left untouched. Refuses while the session has live work.
	 */
	async branchBeforeUserMessage(entryId: string): Promise<{ conversationId: string; replacedEntryId: string }> {
		const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
		if (inspection.tasks.length > 0 || inspection.submissions.length > 0) {
			throw new DurableBranchError("session_busy", "Cannot edit a message while the session is generating");
		}
		const stream = await watchEvents(this.harness, this.rootConversation.id, BACKGROUND_CONTEXT);
		let entries: SnapshotEvent["entries"];
		try {
			entries = stream.snapshot.entries;
		} finally {
			await stream.stop();
		}
		const index = entries.findIndex((entry) => String(entry.id) === entryId);
		const target = index >= 0 ? entries[index] : undefined;
		if (!target || target.model?.[0]?.role !== "user") {
			throw new DurableBranchError("entry_not_found", "Message entry not found");
		}
		const parent = index > 0 ? entries[index - 1] : undefined;
		const options = { ownership: { kind: "ownerless" as const }, agent: this.agentConfig };
		const next = parent
			? await this.rootConversation.fork(parent.id as EntryId, options, BACKGROUND_CONTEXT)
			: await this.harness.createConversation(options, BACKGROUND_CONTEXT);
		this.rootConversation = next;
		return { conversationId: String(next.id), replacedEntryId: entryId };
	}

	async snapshot(): Promise<SnapshotEvent> {
		const stream = await watchEvents(this.harness, this.rootConversation.id, BACKGROUND_CONTEXT);
		try {
			return stream.snapshot;
		} finally {
			await stream.stop();
		}
	}

	async watch(listener: (events: readonly AgentEvent[]) => Promise<void>): Promise<AgentEventStream> {
		const stream = await watchEvents(this.harness, this.rootConversation.id, BACKGROUND_CONTEXT);
		stream.start(async (events) => listener(events));
		return stream;
	}

	async close(): Promise<void> {
		try {
			this.permissions?.unbindTurn();
			this.questions?.unbindTurn();
			await this.harness.close(BACKGROUND_CONTEXT);
			await this.sandbox?.release();
		} finally {
			openStoragePaths.delete(this.ownsStoragePath);
		}
	}
}
