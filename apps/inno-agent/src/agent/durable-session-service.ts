import { incCounter, observeMs } from "../utils/metrics.js";
import type { SandboxManager, SandboxRuntimeBinding } from "../sandbox/sandbox-session.js";
import {
	DURABLE_ID_PATTERN,
	FileSessionCatalog,
	type DurableSessionPatch,
	type DurableSessionRecord,
	type SessionCatalog,
} from "./session-catalog.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { ImageContent } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { InnoConfig } from "../config.js";
import { deleteChannelOutboxForSession } from "../channels/channel-outbox.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { resolveCurrentTenantConfig } from "../tenants/config.js";
import { runInTenantContext, runWithoutTenantContext } from "../tenants/current.js";
import { getRequestTenant } from "../tenants/http.js";
import { resolveRequestTenantDataRoot } from "../tenants/paths.js";
import type { DurableStorageLock, TenantStore } from "../tenants/store.js";
import { TOPIC_UPGRADE_MESSAGE_THRESHOLD, type SessionMessageSummary, type SessionSummary } from "../server/session-model.js";
import {
	buildAttachmentContext,
	parseChatAttachments,
	validateChatAttachments,
	type ChatAttachments,
} from "../server/attachments.js";
import {
	clearSessionAttachments,
	mergeSessionAttachments,
	recordSessionAttachments,
} from "../server/attachments-store.js";
import { clearWorkspaceActivity, markWorkspaceTrackingIncomplete, recordWorkspaceAttachmentActivity, recordWorkspaceFileAccess } from "../server/workspace-activity-store.js";
import { buildImagePathsHint, parseInlineImages, persistInlineImages } from "../server/inline-images.js";
import { fallbackTopicFromMessages, generateSessionTopicWithCompletion } from "../server/session-topic.js";
import {
	completeConfiguredDurableChat,
	completeConfiguredDurablePrompt,
	createConfiguredDurableModels,
	type DurableChatTurn,
} from "./durable-models.js";
import { buildDurableInstructions } from "./durable-memory.js";
import { durableEntriesToMessages } from "./durable-projection.js";
import { DurablePermissionStore, type PendingDurablePermission } from "./durable-permissions.js";
import { DurableQuestionStore } from "./durable-questions.js";
import { DurableStreamStore } from "./durable-stream-store.js";
import { DurableSessionRuntime } from "./durable-runtime.js";
import type { PersistedQuestion, QuestionBridgeResult, QuestionResponseStatus } from "./question-types.js";
import type { PermissionDecision, PermissionResponseStatus } from "./permission-types.js";
import { INNO_SYSTEM_PROMPT } from "./system-prompt.js";
import { buildWorkspaceContextSections } from "./workspace-context.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { buildDurableContextUsage, unavailableContextUsage, type UsageMessage } from "./context-usage.js";
import type { SessionContextUsage } from "../shared/context-usage.js";
import { createDocumentTools } from "./document-tools.js";
import { buildGlobalSkillsSection } from "./skills.js";
import { createTavilyTools } from "./tavily-tools.js";
import { formatRecallForPrompt, ScopedL3Memory } from "../memory/l3/l3-tools.js";
import { logger } from "../logger.js";


export type { DurableSessionRecord } from "./session-catalog.js";

export interface DurableSessionSummary extends SessionSummary {
	runtime: "durable";
	archived: boolean;
	/** The model this session currently uses. */
	model: { provider: string; id: string };
}

export interface DurableSessionLease {
	runtime: DurableSessionRuntime;
	release(): Promise<void>;
}

export interface PreparedDurableAttachments {
	attachments: ChatAttachments;
	context: string;
	workspaceId: string;
	workspaceRoot: string;
}

export interface PreparedDurableImages {
	nativeImages: ImageContent[];
	images: Array<{ mimeType: string; workspacePath: string }>;
	fallbackContext: string;
	workspaceId: string;
	workspaceRoot: string;
}

interface RuntimeEntry {
	runtime: DurableSessionRuntime;
	storageLock?: DurableStorageLock;
	references: number;
	closePromise?: Promise<void>;
}

interface OpenedRuntime {
	runtime: DurableSessionRuntime;
	storageLock?: DurableStorageLock;
}

export interface DurableSessionServiceOptions {
	dataDir: string;
	getLocalConfig: () => InnoConfig;
	enabled: boolean;
	resolveWorkspaceDir: (sessionId: string, fallbackWorkspaceId: string) => string | undefined;
	/** Lazy because the server's channel registry is built during agent bootstrap. */
	getChannelRegistry?: () => ChannelRegistry | undefined;
	/** Shared skills directory. Enabled skills are listed in every session's
	 * instructions and read through the session's `read` tool. */
	skillsDir?: string;
	/** Lazy for the same reason: job stores are created during server bootstrap. */
	getSchedulerTools?: () => ToolRegistration[];
	tenantStore?: TenantStore | null;
	/** PostgreSQL catalog for authenticated tenants; without it every scope uses `sessions.json`. */
	pgCatalog?: SessionCatalog;
	/** When set, every session runs its shell and file tools in a remote sandbox. */
	getSandboxManager?: () => SandboxManager | undefined;
	openRuntime?: typeof DurableSessionRuntime.open;
	completeTopic?: typeof completeConfiguredDurablePrompt;
	completeChat?: typeof completeConfiguredDurableChat;
}

/** Re-enter the verified tenant for tools that read tenant-scoped stores, since
 * pi-durable may resume a tool outside the original HTTP request's async context. */
function bindToolsToTenant(
	tools: ToolRegistration[],
	tenant: ReturnType<typeof getRequestTenant>,
	tenantStore: TenantStore | null | undefined,
): ToolRegistration[] {
	if (!tenant) return tools;
	if (!tenantStore) throw new Error("Authenticated durable tools require a tenant store");
	return tools.map((tool) => ({
		...tool,
		execute: (params, api, context) => runInTenantContext(tenant, tenantStore, () => tool.execute(params, api, context)),
	}));
}

function bindChannelRegistry(
	req: IncomingMessage,
	registry: ChannelRegistry,
	tenantStore: TenantStore | null | undefined,
): ChannelRegistry {
	const tenant = getRequestTenant(req);
	if (!tenant) return registry;
	if (!tenantStore) throw new Error("Authenticated durable channels require a tenant store");
	const run = <T>(operation: () => T): T => runInTenantContext(tenant, tenantStore, operation);
	// Channel tool lookups re-enter the verified tenant even when pi-durable
	// resumes outside the original HTTP request's async context.
	return {
		all: () => run(() => registry.all()),
		get: (name) => run(() => registry.get(name)),
		getDefaultTarget: (name) => run(() => registry.getDefaultTarget(name)),
	} as ChannelRegistry;
}

const SIDE_QUESTION_SYSTEM_PROMPT = [
	"你是学习对话的“旁注问答”通道。学生正在主线学习对话中,临时向你提了一个顺带的问题。",
	"规则:基于提供的对话片段回答;简洁直接,不要把回答扩展成一节新课;不要声称自己查阅了资料或运行了程序(你没有工具);",
	"如果问题与对话片段无关,直接回答问题本身即可;如果片段缺失或不足,明说“主对话里还没有相关信息”。",
	"用中文回答,除非学生用其他语言提问。",
].join("\n");

export class DurableModelNotFoundError extends Error {
	constructor(provider: string, modelId: string) {
		super(`Configured model not found: ${provider}/${modelId}`);
		this.name = "DurableModelNotFoundError";
	}
}

export class DurableRuntimeDisabledError extends Error {
	constructor() {
		super("Durable sessions are disabled.");
		this.name = "DurableRuntimeDisabledError";
	}
}

export class DurableSessionBusyError extends Error {
	constructor(message = "Durable session still has an active operation") {
		super(message);
		this.name = "DurableSessionBusyError";
	}
}

function toSummary(record: DurableSessionRecord): DurableSessionSummary {
	return {
		id: record.id,
		name: record.name,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		messageCount: record.messageCount,
		preview: record.preview,
		channels: [record.origin ?? "web"],
		origin: record.origin ?? "web",
		hasTopic: record.name !== "新对话",
		topicPendingUpgrade: record.topicGenerated === true
			&& record.topicUpgraded !== true
			&& record.messageCount >= TOPIC_UPGRADE_MESSAGE_THRESHOLD,
		runtime: "durable",
		archived: record.archived,
		model: { provider: record.provider, id: record.modelId },
	};
}

/** Application catalog and owner for opt-in durable Web sessions. The catalog is
 * tenant-rooted metadata; committed conversation history stays in pi-durable
 * SQLite and is never represented as a legacy SessionManager JSONL file. */
export class DurableSessionService {
	private readonly fileCatalog = new FileSessionCatalog((req) => this.catalogPath(req));
	private readonly runtimes = new Map<string, RuntimeEntry>();
	private readonly openings = new Map<string, Promise<OpenedRuntime>>();
	private readonly questionStores = new Map<string, DurableQuestionStore>();
	private readonly permissionStores = new Map<string, DurablePermissionStore>();
	private readonly topicGenerations = new Map<string, Promise<DurableSessionSummary>>();
	private readonly openRuntime: typeof DurableSessionRuntime.open;
	private closing = false;

	constructor(private readonly options: DurableSessionServiceOptions) {
		this.openRuntime = options.openRuntime ?? DurableSessionRuntime.open;
	}

	get enabled(): boolean { return this.options.enabled; }

	private root(req: IncomingMessage): string {
		return join(resolveRequestTenantDataRoot(req, this.options.dataDir), "durable");
	}

	private catalogPath(req: IncomingMessage): string {
		return join(this.root(req), "sessions.json");
	}

	private storagePath(req: IncomingMessage, id: string): string {
		return join(this.root(req), "storage", id, "session.sqlite");
	}

	private runtimeKey(req: IncomingMessage, id: string): string {
		return join(this.root(req), "storage", id);
	}

	private questionDir(req: IncomingMessage, id: string): string {
		return join(this.root(req), "questions", id);
	}

	private permissionDir(req: IncomingMessage, id: string): string {
		return join(this.root(req), "permissions", id);
	}

	private permissionStore(req: IncomingMessage, id: string): DurablePermissionStore {
		const key = this.runtimeKey(req, id);
		let store = this.permissionStores.get(key);
		if (!store) {
			store = new DurablePermissionStore(id, this.permissionDir(req, id));
			this.permissionStores.set(key, store);
		}
		return store;
	}

	private questionStore(req: IncomingMessage, id: string): DurableQuestionStore {
		const key = this.runtimeKey(req, id);
		let store = this.questionStores.get(key);
		if (!store) {
			store = new DurableQuestionStore(id, this.questionDir(req, id));
			this.questionStores.set(key, store);
		}
		return store;
	}

	streamStore(req: IncomingMessage): DurableStreamStore {
		return new DurableStreamStore(join(this.root(req), "streams"));
	}

	pendingQuestion(req: IncomingMessage, id: string): PersistedQuestion | undefined {
		return this.questionStore(req, id).pendingQuestion();
	}

	pendingPermission(req: IncomingMessage, id: string): PendingDurablePermission | undefined {
		return this.permissionStore(req, id).pendingPermission();
	}

	respondPermission(req: IncomingMessage, id: string, input: {
		turnId: string;
		requestId: string;
		decision: PermissionDecision;
		reason?: string;
	}): PermissionResponseStatus {
		return this.permissionStore(req, id).respond(input);
	}

	cancelPermissionTurn(req: IncomingMessage, id: string, turnId: string): number {
		return this.permissionStore(req, id).cancelTurn(turnId);
	}

	respondQuestion(req: IncomingMessage, id: string, input: {
		turnId: string;
		questionId: string;
		result: QuestionBridgeResult;
	}): QuestionResponseStatus {
		return this.questionStore(req, id).respond(input);
	}

	cancelQuestionTurn(req: IncomingMessage, id: string, turnId: string): number {
		return this.questionStore(req, id).cancelTurn(turnId);
	}

	/** Hold an owner until the accepted decision and any following model response
	 * are committed. Without an active SSE this still resumes in the background. */
	async resumeAfterInteraction(req: IncomingMessage, id: string): Promise<void> {
		const lease = await this.lease(req, id);
		try {
			await lease.runtime.waitForIdle();
		} finally {
			await lease.release();
		}
	}

	async resumeAfterQuestion(req: IncomingMessage, id: string): Promise<void> {
		return this.resumeAfterInteraction(req, id);
	}

	async resumeAfterPermission(req: IncomingMessage, id: string): Promise<void> {
		return this.resumeAfterInteraction(req, id);
	}

	async abort(req: IncomingMessage, id: string, turnId: string): Promise<void> {
		const lease = await this.lease(req, id);
		try {
			// Resolve the application-owned card while this turn still owns the
			// runtime, then persist pi-durable's abort marks before releasing it.
			this.permissionStore(req, id).cancelTurn(turnId);
			this.questionStore(req, id).cancelTurn(turnId);
			await lease.runtime.abort();
		} finally {
			await lease.release();
		}
	}

	private catalogFor(req: IncomingMessage): SessionCatalog {
		return getRequestTenant(req) && this.options.pgCatalog ? this.options.pgCatalog : this.fileCatalog;
	}

	async get(req: IncomingMessage, id: string): Promise<DurableSessionRecord | undefined> {
		if (!DURABLE_ID_PATTERN.test(id)) return undefined;
		return this.catalogFor(req).get(req, id);
	}

	async list(req: IncomingMessage): Promise<DurableSessionSummary[]> {
		return (await this.catalogFor(req).list(req)).map(toSummary)
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}

	async create(req: IncomingMessage, input: { workspaceId: string; origin?: "web" | "scheduler" }): Promise<DurableSessionSummary> {
		if (!this.options.enabled) throw new DurableRuntimeDisabledError();
		if (this.closing) throw new Error("Durable session service is shutting down");
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		if (!config.defaultProvider || !config.defaultModel) {
			throw new Error("Configure a provider and default model before creating a durable session");
		}
		// Validate the selected model now, without opening a network connection.
		const provider = config.providers[config.defaultProvider];
		if (!provider?.models.some((model) => model.id === config.defaultModel)) {
			throw new Error(`Configured durable model not found: ${config.defaultProvider}/${config.defaultModel}`);
		}
		const now = new Date().toISOString();
		const record: DurableSessionRecord = {
			id: `durable-${randomUUID()}`,
			workspaceId: input.workspaceId,
			name: "新对话",
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
			preview: "",
			provider: config.defaultProvider,
			modelId: config.defaultModel,
			origin: input.origin ?? "web",
			archived: false,
		};
		await this.catalogFor(req).insert(req, record);
		return toSummary(record);
	}

	private async update(req: IncomingMessage, id: string, update: DurableSessionPatch): Promise<DurableSessionRecord> {
		return this.catalogFor(req).update(req, id, update);
	}

	async rename(req: IncomingMessage, id: string, name: string): Promise<DurableSessionSummary> {
		return toSummary(await this.update(req, id, {
			name,
			topicGenerated: false,
			topicUpgraded: false,
			updatedAt: new Date().toISOString(),
		}));
	}

	/** Switch the model of one session. The catalog record is the source of truth
	 * when a runtime opens, so it changes first; an open runtime is then told to
	 * use the new model from its next request. A failure restores the old model. */
	async setModel(
		req: IncomingMessage,
		id: string,
		selection: { provider: string; modelId: string },
	): Promise<DurableSessionSummary> {
		const before = await this.get(req, id);
		if (!before) throw new Error("Durable session not found");
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		const provider = config.providers[selection.provider];
		if (!provider?.models.some((model) => model.id === selection.modelId)) {
			throw new DurableModelNotFoundError(selection.provider, selection.modelId);
		}
		if (before.provider === selection.provider && before.modelId === selection.modelId) return toSummary(before);
		const next = await this.update(req, id, { provider: selection.provider, modelId: selection.modelId });
		try {
			const lease = await this.lease(req, id);
			try {
				await lease.runtime.setModel({ provider: selection.provider, modelId: selection.modelId });
			} finally {
				await lease.release();
			}
		} catch (error) {
			await this.update(req, id, { provider: before.provider, modelId: before.modelId });
			throw error;
		}
		return toSummary(next);
	}

	/**
	 * Edit an earlier user message: continue the session in a fork that holds
	 * everything before it. The abandoned replies stay in the earlier conversation
	 * but leave the visible history. A pending question or approval of the
	 * abandoned branch is cancelled. If the process dies between creating the fork
	 * and recording it here, the session simply keeps its previous conversation.
	 */
	async branchBeforeMessage(
		req: IncomingMessage,
		id: string,
		entryId: string,
	): Promise<{ sessionId: string; replacedEntryId: string; branchMarkerId: string; sessionRevision: string }> {
		if (!await this.get(req, id)) throw new Error("Durable session not found");
		const pendingQuestion = this.questionStore(req, id).pendingQuestion();
		const pendingPermission = this.permissionStore(req, id).pendingPermission();
		const lease = await this.lease(req, id);
		let branched: { conversationId: string; replacedEntryId: string };
		try {
			// Validate and fork first: a rejected edit must not cancel anything.
			branched = await lease.runtime.branchBeforeUserMessage(entryId);
			if (pendingQuestion) this.questionStore(req, id).cancelTurn(pendingQuestion.turnId);
			if (pendingPermission) this.permissionStore(req, id).cancelTurn(pendingPermission.turnId);
			await this.update(req, id, { conversationId: branched.conversationId, updatedAt: new Date().toISOString() });
		} finally {
			await lease.release();
		}
		const detail = await this.snapshot(req, id);
		return {
			sessionId: id,
			replacedEntryId: branched.replacedEntryId,
			branchMarkerId: branched.conversationId,
			sessionRevision: detail.revision,
		};
	}

	/** Answer a "by the way" side question with the session's own model, outside
	 * the transcript and without tools. Returns "" when the model cannot answer. */
	async completeSideQuestion(
		req: IncomingMessage,
		id: string,
		input: {
			contextDigest: string;
			thread: ReadonlyArray<{ question: string; answer: string }>;
			question: string;
			signal?: AbortSignal;
		},
	): Promise<string> {
		const record = await this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		const complete = this.options.completeChat ?? completeConfiguredDurableChat;
		const turns: DurableChatTurn[] = [];
		if (input.contextDigest) turns.push({ role: "user", text: input.contextDigest });
		for (const exchange of input.thread) {
			turns.push({ role: "user", text: exchange.question }, { role: "assistant", text: exchange.answer });
		}
		turns.push({ role: "user", text: input.question });
		return complete(config, { provider: record.provider, modelId: record.modelId }, {
			systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
			turns,
			...(input.signal ? { signal: input.signal } : {}),
		});
	}

	/** Context-window usage for one session, from the committed conversation. */
	async contextUsage(req: IncomingMessage, id: string): Promise<SessionContextUsage> {
		const record = await this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		const model = config.providers[record.provider]?.models.find((candidate) => candidate.id === record.modelId);
		if (!model) return unavailableContextUsage(id, "unavailable");
		const lease = await this.lease(req, id);
		try {
			const messages = await lease.runtime.contextMessages();
			return buildDurableContextUsage(id, {
				contextWindow: model.contextWindow,
				instructions: lease.runtime.contextInfo.instructions,
				tools: lease.runtime.contextInfo.tools,
				messages: messages as readonly UsageMessage[],
			});
		} finally {
			await lease.release();
		}
	}

	async setArchived(req: IncomingMessage, id: string, archived: boolean): Promise<DurableSessionSummary> {
		return toSummary(await this.update(req, id, { archived, updatedAt: new Date().toISOString() }));
	}

	async markSchedulerOrigin(req: IncomingMessage, id: string): Promise<DurableSessionSummary> {
		return toSummary(await this.update(req, id, { origin: "scheduler", updatedAt: new Date().toISOString() }));
	}

	async noteSubmission(req: IncomingMessage, id: string, prompt: string): Promise<void> {
		const record = await this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const firstTopic = record.name === "新对话";
		const firstMessage: SessionMessageSummary = { role: "user", content: prompt, timestamp: Date.now() };
		await this.update(req, id, {
			preview: prompt.trim().slice(0, 200),
			name: firstTopic ? fallbackTopicFromMessages([firstMessage], toSummary(record)) : record.name,
			...(firstTopic ? { topicGenerated: true, topicUpgraded: false } : {}),
			updatedAt: new Date().toISOString(),
		});
	}

	generateTopic(req: IncomingMessage, id: string): Promise<DurableSessionSummary> {
		return this.generateTopicInternal(req, id, false);
	}

	/** Upgrade only an automatic preview once the conversation has enough context.
	 * The returned promise makes the fire-and-forget HTTP path deterministic in tests. */
	async maybeAutoGenerateTopic(req: IncomingMessage, id: string): Promise<void> {
		const record = await this.get(req, id);
		if (!record || record.topicGenerated !== true || record.topicUpgraded === true
			|| record.messageCount < TOPIC_UPGRADE_MESSAGE_THRESHOLD) return;
		try {
			await this.generateTopicInternal(req, id, true);
			const current = await this.get(req, id);
			if (current?.topicGenerated === true && current.topicUpgraded === true) {
				logger.info(`[auto-topic] ${id} → ${current.name} (durable upgraded)`);
			}
		} catch (error) {
			logger.warn({ err: error }, `auto-topic generation failed for ${id}`);
		}
	}

	private async generateTopicInternal(req: IncomingMessage, id: string, automatic: boolean): Promise<DurableSessionSummary> {
		const initial = await this.get(req, id);
		if (!initial) throw new Error("Durable session not found");
		const key = `${this.runtimeKey(req, id)}:topic`;
		const pending = this.topicGenerations.get(key);
		if (pending) return pending;
		// Capture the verified tenant's configuration before background work can
		// outlive its HTTP ALS scope. The catalog selection stays pinned even if
		// the tenant later changes their default model.
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		const complete = this.options.completeTopic ?? completeConfiguredDurablePrompt;
		let operation: Promise<DurableSessionSummary>;
		operation = (async () => {
			const detail = await this.snapshot(req, id);
			const before = await this.get(req, id);
			if (!before) throw new Error("Durable session not found");
			if (automatic && (before.topicGenerated !== true || before.topicUpgraded === true)) {
				return toSummary(before);
			}
			const expectedName = before.name;
			const topic = await generateSessionTopicWithCompletion(
				detail.summary,
				detail.messages,
				(prompt, maxTokens) => complete(config, { provider: before.provider, modelId: before.modelId }, prompt, maxTokens),
			);
			const current = await this.get(req, id);
			if (!current) throw new Error("Durable session not found");
			// A manual rename (or another writer) wins over an in-flight generation.
			if (current.name !== expectedName
				|| (automatic && (current.topicGenerated !== true || current.topicUpgraded === true))) {
				return toSummary(current);
			}
			return toSummary(await this.update(req, id, {
				name: topic,
				topicGenerated: true,
				topicUpgraded: true,
				updatedAt: new Date().toISOString(),
			}));
		})().finally(() => {
			if (this.topicGenerations.get(key) === operation) this.topicGenerations.delete(key);
		});
		this.topicGenerations.set(key, operation);
		return operation;
	}

	async prepareAttachments(req: IncomingMessage, id: string, raw: unknown): Promise<PreparedDurableAttachments | null> {
		const parsed = parseChatAttachments(raw);
		if (!parsed) return null;
		const record = await this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const workspaceRoot = this.options.resolveWorkspaceDir(id, record.workspaceId);
		if (!workspaceRoot) throw new Error(`Durable session workspace not found: ${record.workspaceId}`);
		const attachments = validateChatAttachments(parsed, workspaceRoot);
		const context = buildAttachmentContext(attachments);
		if (!context) return null;
		return { attachments, context, workspaceId: record.workspaceId, workspaceRoot };
	}

	async prepareImages(req: IncomingMessage, id: string, raw: unknown, requestId: string): Promise<PreparedDurableImages | null> {
		const parsed = parseInlineImages(raw);
		if (parsed.length === 0) return null;
		const record = await this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const workspaceRoot = this.options.resolveWorkspaceDir(id, record.workspaceId);
		if (!workspaceRoot) throw new Error(`Durable session workspace not found: ${record.workspaceId}`);
		const paths = persistInlineImages(parsed, workspaceRoot, requestId);
		if (paths.length !== parsed.length) throw new Error("Failed to persist every durable inline image");
		const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
		const model = config.providers[record.provider]?.models.find((candidate) => candidate.id === record.modelId);
		if (!model) throw new Error(`Configured durable model not found: ${record.provider}/${record.modelId}`);
		const native = model.input.includes("image");
		return {
			nativeImages: native ? parsed : [],
			images: parsed.map((image, index) => ({ mimeType: image.mimeType, workspacePath: paths[index] })),
			fallbackContext: buildImagePathsHint(paths),
			workspaceId: record.workspaceId,
			workspaceRoot,
		};
	}

	recordTurnMetadata(
		req: IncomingMessage,
		id: string,
		attachments: PreparedDurableAttachments | null,
		images: PreparedDurableImages | null,
		prompt: string,
		requestId: string,
	): void {
		if (!attachments && !images) return;
		const dataRoot = resolveRequestTenantDataRoot(req, this.options.dataDir);
		const workspaceId = attachments?.workspaceId ?? images?.workspaceId;
		recordSessionAttachments(dataRoot, id, {
			promptContent: prompt,
			...(attachments ? { attachments: attachments.attachments } : {}),
			...(images ? { images: images.images } : {}),
			timestamp: Date.now(),
			workspaceId,
			requestId,
		});
		if (attachments) {
			recordWorkspaceAttachmentActivity(dataRoot, {
				sessionId: id,
				workspaceId: attachments.workspaceId,
				workspaceRoot: attachments.workspaceRoot,
				attachments: attachments.attachments,
			});
		}
		if (images) {
			recordWorkspaceFileAccess(dataRoot, {
				sessionId: id,
				workspaceId: images.workspaceId,
				workspaceRoot: images.workspaceRoot,
				paths: images.images.map((image) => image.workspacePath),
				access: "write",
			});
		}
	}

	recordWorkspaceWriteActivity(
		req: IncomingMessage,
		id: string,
		workspaceId: string,
		workspaceRoot: string,
		paths: string[],
		trackingIncomplete: boolean,
	): void {
		const dataRoot = resolveRequestTenantDataRoot(req, this.options.dataDir);
		if (trackingIncomplete) markWorkspaceTrackingIncomplete(dataRoot, id);
		if (paths.length === 0) return;
		recordWorkspaceFileAccess(dataRoot, {
			sessionId: id,
			workspaceId,
			workspaceRoot,
			paths,
			access: "write",
		});
	}

	/** Build threshold-gated recall as separate model-only input. The visible
	 * prompt stays untouched and the current durable session is always excluded. */
	async prepareRecallContext(req: IncomingMessage, id: string, prompt: string): Promise<string> {
		if (!await this.get(req, id)) throw new Error("Durable session not found");
		try {
			const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
			if (config.memory?.l3Enabled === false || !prompt.trim()) return "";
			const scoped = new ScopedL3Memory(this.options.dataDir);
			const tenant = getRequestTenant(req);
			if (tenant && !this.options.tenantStore) throw new Error("Authenticated durable L3 recall requires a tenant store");
			const recall = () => scoped.recall(prompt, id);
			const results = tenant
				? await runInTenantContext(tenant, this.options.tenantStore!, recall)
				: await runWithoutTenantContext(recall);
			return formatRecallForPrompt(results);
		} catch (error) {
			logger.warn({ err: error, sessionId: id }, "durable L3 recall failed (non-fatal)");
			return "";
		}
	}

	private async indexL3Snapshot(
		req: IncomingMessage,
		id: string,
		messages: SessionMessageSummary[],
		revision: number,
	): Promise<void> {
		// Indexing continues while recall is disabled so re-enabling L3 has no gap.
		const scoped = new ScopedL3Memory(this.options.dataDir);
		const tenant = getRequestTenant(req);
		try {
			if (tenant) {
				if (!this.options.tenantStore) throw new Error("Authenticated durable L3 indexing requires a tenant store");
				await runInTenantContext(tenant, this.options.tenantStore, () => scoped.indexMessages(id, messages, revision));
			} else {
				await runWithoutTenantContext(() => scoped.indexMessages(id, messages, revision));
			}
		} catch (error) {
			// L3 is derived, best-effort state; committed history remains authoritative.
			logger.warn({ err: error, sessionId: id }, "failed to index durable history for L3");
		}
	}

	async appendAssistantNotification(req: IncomingMessage, id: string, text: string, requestId: string): Promise<void> {
		const lease = await this.lease(req, id);
		try {
			await lease.runtime.appendAssistantNotification(text, requestId);
			await this.snapshot(req, id);
		} finally {
			await lease.release();
		}
	}

	async snapshot(req: IncomingMessage, id: string): Promise<{
		summary: DurableSessionSummary;
		messages: ReturnType<typeof durableEntriesToMessages>;
		revision: string;
		pendingQuestion?: PersistedQuestion;
		pendingPermission?: PendingDurablePermission;
	}> {
		const lease = await this.lease(req, id);
		try {
			const snapshot = await lease.runtime.snapshot();
			const messages = mergeSessionAttachments(
				resolveRequestTenantDataRoot(req, this.options.dataDir),
				id,
				durableEntriesToMessages(snapshot.entries),
			);
			const record = await this.get(req, id);
			if (!record) throw new Error("Durable session not found");
			const lastMessageAt = messages.at(-1)?.timestamp;
			const updatedAt = lastMessageAt && lastMessageAt > Date.parse(record.updatedAt)
				? new Date(lastMessageAt).toISOString()
				: record.updatedAt;
			const next = await this.update(req, id, { messageCount: messages.length, updatedAt });
			const lastEntryId = snapshot.entries.at(-1)?.id ?? 0;
			await this.indexL3Snapshot(req, id, messages, lastEntryId);
			const pendingQuestion = this.pendingQuestion(req, id);
			const pendingPermission = this.pendingPermission(req, id);
			return {
				summary: toSummary(next),
				messages,
				revision: `durable:${lastEntryId}`,
				...(pendingQuestion ? { pendingQuestion } : {}),
				...(pendingPermission ? { pendingPermission } : {}),
			};
		} finally {
			await lease.release();
		}
	}

	private closeRuntimeEntry(entry: RuntimeEntry): Promise<void> {
		if (!entry.closePromise) {
			entry.closePromise = (async () => {
				try {
					await entry.runtime.close();
				} finally {
					await entry.storageLock?.release();
				}
			})();
		}
		return entry.closePromise;
	}

	async lease(req: IncomingMessage, id: string): Promise<DurableSessionLease> {
		if (!this.options.enabled) throw new DurableRuntimeDisabledError();
		if (this.closing) throw new Error("Durable session service is shutting down");
		const record = await this.get(req, id);
		if (!record) throw new Error("Durable session not found");
		const key = this.runtimeKey(req, id);
		let entry = this.runtimes.get(key);
		if (!entry) {
			let opening = this.openings.get(key);
			if (!opening) {
				opening = (async () => {
					const tenant = getRequestTenant(req);
					let storageLock: DurableStorageLock | undefined;
					if (tenant) {
						if (!this.options.tenantStore) throw new Error("Authenticated durable storage requires a tenant store");
						const lockStarted = performance.now();
						storageLock = await this.options.tenantStore.acquireDurableStorageLock(tenant, id) ?? undefined;
						observeMs("inno_advisory_lock_acquire_ms", performance.now() - lockStarted);
						if (!storageLock) {
							incCounter("inno_advisory_lock_busy_total");
							throw new DurableSessionBusyError("Durable session is owned by another worker");
						}
						incCounter("inno_advisory_lock_acquired_total");
					}
					try {
						const config = resolveCurrentTenantConfig(this.options.dataDir, this.options.getLocalConfig());
						const selection = await createConfiguredDurableModels(config, {
							provider: record.provider,
							modelId: record.modelId,
						});
						const workspaceDir = this.options.resolveWorkspaceDir(id, record.workspaceId);
						if (!workspaceDir) throw new Error(`Durable session workspace not found: ${record.workspaceId}`);
						const tenantDataRoot = resolveRequestTenantDataRoot(req, this.options.dataDir);
						const scopedL3 = new ScopedL3Memory(this.options.dataDir);
						const l3Memory = tenant
							? {
								recall: (query: string, excludeSessionId?: string) => runInTenantContext(
									tenant,
									this.options.tenantStore!,
									() => scopedL3.recall(query, excludeSessionId),
								),
							}
							: scopedL3;
						const memory = {
							sessionId: id,
							learnerDataDir: join(tenantDataRoot, "learner"),
							l2DataDir: join(tenantDataRoot, "l2"),
							workspaceDir,
							l1Enabled: config.memory?.l1Enabled !== false,
							l2Enabled: config.memory?.l2Enabled !== false,
							l3: { memory: l3Memory, enabled: config.memory?.l3Enabled !== false },
						};
						const ocr = {
							sessionId: id,
							checkpointDir: join(tenantDataRoot, "ocr"),
							workspaceDir,
							ocrApi: config.ocrApi,
						};
						const baseChannelRegistry = this.options.getChannelRegistry?.();
						const channels = baseChannelRegistry ? {
							sessionId: id,
							outboxDir: join(tenantDataRoot, "channels", "outbox"),
							workspaceDir,
							channelRegistry: bindChannelRegistry(req, baseChannelRegistry, this.options.tenantStore),
						} : undefined;
						const sandboxManager = this.options.getSandboxManager?.();
						const sandbox: SandboxRuntimeBinding | undefined = sandboxManager
							? await sandboxManager.bind({
								sessionId: id,
								...(tenant ? { tenantId: tenant.tenantId } : {}),
								...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
								hostWorkspaceDir: workspaceDir,
								...(this.options.skillsDir ? { hostSkillsDir: this.options.skillsDir } : {}),
								stateDir: join(this.root(req), "storage", id),
								persistSandboxId: async (sandboxId) => { await this.update(req, id, { sandboxId }); },
							})
							: undefined;
						const runtime = await this.openRuntime({
							storagePath: this.storagePath(req, id),
							...selection,
							...(record.conversationId ? { conversationId: record.conversationId } : {}),
							instructions: [
								buildDurableInstructions(INNO_SYSTEM_PROMPT, memory),
								sandbox?.promptSection,
								sandbox
									? sandbox.rebasePaths(buildGlobalSkillsSection(this.options.skillsDir) ?? "")
									: buildGlobalSkillsSection(this.options.skillsDir),
								...buildWorkspaceContextSections(workspaceDir).map((section) => sandbox ? sandbox.rebasePaths(section) : section),
							].filter((section): section is string => Boolean(section)).join("\n\n"),
							...(sandbox ? { sandbox } : {}),
							workspaceDir,
							workspaceTools: true,
							permissions: this.permissionStore(req, id),
							memory,
							ocr,
							channels,
							questions: {
								store: this.questionStore(req, id),
								workspaceDir,
							},
							extraTools: [
								...createDocumentTools({ restrictToWorkspace: true, workspaceDir }),
								...createTavilyTools({ current: config }),
								...bindToolsToTenant(this.options.getSchedulerTools?.() ?? [], tenant, this.options.tenantStore),
							],
						}).catch(async (error: unknown) => {
							await sandbox?.release().catch(() => undefined);
							throw error;
						});
						return { runtime, ...(storageLock ? { storageLock } : {}) };
					} catch (error) {
						await storageLock?.release().catch((releaseError) => {
							logger.error({ err: releaseError, sessionId: id }, "failed to release durable storage lock after open failure");
						});
						throw error;
					}
				})();
				this.openings.set(key, opening);
			}
			try {
				const opened = await opening;
				if (this.closing) {
					await opened.runtime.close().catch(() => undefined);
					await opened.storageLock?.release();
					throw new Error("Durable session service is shutting down");
				}
				entry = this.runtimes.get(key) ?? {
					runtime: opened.runtime,
					...(opened.storageLock ? { storageLock: opened.storageLock } : {}),
					references: 0,
				};
				this.runtimes.set(key, entry);
				const openedEntry = entry;
				opened.storageLock?.onLost(() => {
					incCounter("inno_advisory_lock_lost_total");
					if (this.runtimes.get(key) !== openedEntry) return;
					this.runtimes.delete(key);
					void this.closeRuntimeEntry(openedEntry).catch((error) => {
						logger.error({ err: error, sessionId: id }, "failed to close runtime after durable storage lock loss");
					});
				});
				if (this.runtimes.get(key) !== entry) {
					throw new DurableSessionBusyError("Durable session lost its storage ownership while opening");
				}
			} finally {
				this.openings.delete(key);
			}
		}
		entry.references += 1;
		const leasedEntry = entry;
		let released = false;
		return {
			runtime: entry.runtime,
			release: async () => {
				if (released) return;
				released = true;
				const current = this.runtimes.get(key);
				if (current !== leasedEntry) {
					await leasedEntry.closePromise;
					return;
				}
				current.references -= 1;
				if (current.references <= 0) {
					this.runtimes.delete(key);
					await this.closeRuntimeEntry(current);
				}
			},
		};
	}

	async delete(req: IncomingMessage, id: string): Promise<void> {
		const key = this.runtimeKey(req, id);
		if (this.openings.has(key) || (this.runtimes.get(key)?.references ?? 0) > 0) {
			throw new DurableSessionBusyError();
		}
		const entry = this.runtimes.get(key);
		if (entry) {
			this.runtimes.delete(key);
			await this.closeRuntimeEntry(entry);
		}
		const sandboxId = (await this.get(req, id))?.sandboxId;
		const sandboxManager = this.options.getSandboxManager?.();
		if (sandboxId && sandboxManager) await sandboxManager.destroy(sandboxId);
		await this.catalogFor(req).remove(req, id);
		this.questionStores.delete(key);
		this.permissionStores.delete(key);
		const dataRoot = resolveRequestTenantDataRoot(req, this.options.dataDir);
		clearSessionAttachments(dataRoot, id);
		clearWorkspaceActivity(dataRoot, id);
		await rm(join(this.root(req), "storage", id), { recursive: true, force: true });
		await rm(this.questionDir(req, id), { recursive: true, force: true });
		await rm(this.permissionDir(req, id), { recursive: true, force: true });
		this.streamStore(req).deleteSession(id);
		deleteChannelOutboxForSession(join(dataRoot, "channels", "outbox"), id);
	}

	async close(): Promise<void> {
		this.closing = true;
		await Promise.all([...this.openings.values()].map((opening) => opening.catch(() => undefined)));
		await Promise.all([...this.topicGenerations.values()].map((generation) => generation.catch(() => undefined)));
		const entries = [...this.runtimes.values()];
		this.runtimes.clear();
		this.openings.clear();
		this.questionStores.clear();
		this.permissionStores.clear();
		this.topicGenerations.clear();
		await Promise.all(entries.map((entry) => this.closeRuntimeEntry(entry).catch(() => undefined)));
	}
}
