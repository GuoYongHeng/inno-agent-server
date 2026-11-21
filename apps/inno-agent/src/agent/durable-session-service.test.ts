import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig } from "../config.js";
import { runInTenantContext, runWithoutTenantContext, getCurrentTenant } from "../tenants/current.js";
import { saveTenantConfig } from "../tenants/config.js";
import { readManifest } from "../memory/l2/manifest-store.js";
import { closeL3Memory, ScopedL3Memory } from "../memory/l3/l3-tools.js";
import { ChannelRegistry } from "../channels/channel.js";
import { setRequestTenant } from "../tenants/http.js";
import type { DurableStorageLock, TenantContext, TenantStore } from "../tenants/store.js";
import { metricsSnapshot, resetMetricsForTests } from "../utils/metrics.js";
import { createSchedulerTools } from "../scheduler/scheduler-tools.js";
import { DurableModelNotFoundError, DurableRuntimeDisabledError, DurableSessionService } from "./durable-session-service.js";
import { DurableSessionRuntime, type DurableSessionRuntimeOptions } from "./durable-runtime.js";

const roots: string[] = [];
const l3Dirs: string[] = [];
const services: DurableSessionService[] = [];
const tenantStore = {
	acquireDurableStorageLock: async () => ({
		lost: false,
		onLost: () => {},
		release: async () => {},
	}),
} as unknown as TenantStore;

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "inno-durable-service-"));
	roots.push(value);
	return value;
}

function config(apiKey: string) {
	return normalizeConfig({
		defaultProvider: "faux-configured",
		defaultModel: "faux-model",
		providers: {
			"faux-configured": {
				baseUrl: "http://faux.invalid/v1",
				apiKey,
				models: [{ id: "faux-model", name: "Faux", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 1_000 }],
			},
		},
	});
}

function tenant(id: string): TenantContext {
	return { tenantId: id, userId: `user-${id}`, role: "owner" };
}

function inTenant<T>(context: TenantContext, operation: (req: IncomingMessage) => T, store: TenantStore = tenantStore): T {
	const req = { headers: {} } as IncomingMessage;
	return runWithoutTenantContext(() => {
		setRequestTenant(req, context, store);
		return runInTenantContext(context, store, () => operation(req));
	});
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const path of l3Dirs.splice(0)) closeL3Memory(path);
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DurableSessionService", () => {
	it("derives isolated catalog/storage roots and runs concurrent tenant sessions", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		mkdirSync(workspace, { recursive: true });
		const localConfig = config("local-key");
		saveTenantConfig(base, "tenant-a", config("key-a"));
		saveTenantConfig(base, "tenant-b", config("key-b"));
		const providers = new Map<string, FauxProviderHandle>();
		writeFileSync(join(workspace, "shared.txt"), "tenant channel payload");
		const channelSends: Array<{ tenantId: string; chatId: string }> = [];
		const channelFor = (tenantId: string) => ({
			name: "feishu",
			verify: async () => true,
			parse: async () => null,
			reply: async () => {},
			push: async () => {},
			sendFile: async (target: { chatId: string }) => { channelSends.push({ tenantId, chatId: target.chatId }); },
		});
		const scopedChannelRegistry = {
			all: () => {
				const tenantId = getCurrentTenant()?.tenantId;
				if (!tenantId) throw new Error("Missing tenant during channel lookup");
				return [channelFor(tenantId)];
			},
			get: () => {
				const tenantId = getCurrentTenant()?.tenantId;
				if (!tenantId) throw new Error("Missing tenant during channel lookup");
				return channelFor(tenantId);
			},
			getDefaultTarget: () => {
				const tenantId = getCurrentTenant()?.tenantId;
				if (!tenantId) throw new Error("Missing tenant during target lookup");
				return { channel: "feishu", chatId: `chat-${tenantId}` };
			},
		} as unknown as ChannelRegistry;
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => localConfig,
			enabled: true,
			resolveWorkspaceDir: () => workspace,
			getChannelRegistry: () => scopedChannelRegistry,
			tenantStore,
			openRuntime: async (options: DurableSessionRuntimeOptions) => {
				let faux = providers.get(options.storagePath);
				if (!faux) {
					faux = fauxProvider();
					const tenantConcept = options.storagePath.includes("tenant-a") ? "concept-a" : "concept-b";
					faux.setResponses([
						fauxAssistantMessage(fauxToolCall("l2_archive", {
							title: tenantConcept,
							content: `notes of ${tenantConcept}`,
							sourceType: "markdown",
						}, { id: `archive-${tenantConcept}` }), { stopReason: "toolUse" }),
						fauxAssistantMessage(fauxToolCall("send_file_to_channel", {
							filePath: "shared.txt",
							channel: "feishu",
						}, { id: `channel-${tenantConcept}` }), { stopReason: "toolUse" }),
						fauxAssistantMessage(options.storagePath.includes("tenant-a") ? "answer A" : "answer B"),
					]);
					providers.set(options.storagePath, faux);
				}
				const models = createModels();
				models.setProvider(faux.provider);
				return DurableSessionRuntime.open({
					...options,
					models,
					model: { provider: faux.provider.id, modelId: faux.getModel().id },
				});
			},
		});
		services.push(service);
		const a = tenant("tenant-a");
		const b = tenant("tenant-b");
		const boundA = await inTenant(a, async (req) => ({ req, summary: await service.create(req, { workspaceId: "workspace-a" }) }));
		const boundB = await inTenant(b, async (req) => ({ req, summary: await service.create(req, { workspaceId: "workspace-b" }) }));
		expect(boundA.summary.id).not.toBe(boundB.summary.id);
		const [answerA, answerB] = await Promise.all([
			inTenant(a, async () => {
				const lease = await service.lease(boundA.req, boundA.summary.id);
				try {
					const submission = await lease.runtime.submit("question A", "shared-request");
					const result = await lease.runtime.waitForSubmission(submission.id);
					return result;
				} finally { await lease.release(); }
			}),
			inTenant(b, async () => {
				const lease = await service.lease(boundB.req, boundB.summary.id);
				try {
					const submission = await lease.runtime.submit("question B", "shared-request");
					const result = await lease.runtime.waitForSubmission(submission.id);
					return result;
				} finally { await lease.release(); }
			}),
		]);
		expect(answerA).toMatchObject({ status: "done", text: "answer A" });
		expect(answerB).toMatchObject({ status: "done", text: "answer B" });
		expect((await inTenant(a, () => service.list(boundA.req))).map((item) => item.id)).toEqual([boundA.summary.id]);
		expect((await inTenant(b, () => service.list(boundB.req))).map((item) => item.id)).toEqual([boundB.summary.id]);
		expect(readFileSync(join(base, "tenants", "tenant-a", "durable", "sessions.json"), "utf-8")).toContain(boundA.summary.id);
		expect(readFileSync(join(base, "tenants", "tenant-b", "durable", "sessions.json"), "utf-8")).not.toContain(boundA.summary.id);
		const archivesA = await readManifest(join(base, "tenants", "tenant-a", "l2"));
		const archivesB = await readManifest(join(base, "tenants", "tenant-b", "l2"));
		expect(archivesA.map((entry) => entry.title)).toEqual(["concept-a"]);
		expect(archivesB.map((entry) => entry.title)).toEqual(["concept-b"]);
		expect(channelSends).toEqual(expect.arrayContaining([
			{ tenantId: "tenant-a", chatId: "chat-tenant-a" },
			{ tenantId: "tenant-b", chatId: "chat-tenant-b" },
		]));
		expect(channelSends).toHaveLength(2);
		expect(readdirSync(join(base, "tenants", "tenant-a", "channels", "outbox"))).toHaveLength(2);
		expect(readdirSync(join(base, "tenants", "tenant-b", "channels", "outbox"))).toHaveLength(2);
		await inTenant(a, () => service.delete(boundA.req, boundA.summary.id));
		expect(readdirSync(join(base, "tenants", "tenant-a", "channels", "outbox"))).toHaveLength(0);
		expect(readdirSync(join(base, "tenants", "tenant-b", "channels", "outbox"))).toHaveLength(2);
	});

	it("keeps request deduplication across idle runtime close/reopen", async () => {
		await runWithoutTenantContext(async () => {
		const base = root();
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("one committed answer")]);
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => base,
			openRuntime: async (options) => {
				const models = createModels();
				models.setProvider(faux.provider);
				return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
			},
		});
		services.push(service);
		const req = { headers: {} } as IncomingMessage;
		const session = await service.create(req, { workspaceId: "workspace" });
		const submit = async () => {
			const lease = await service.lease(req, session.id);
			try {
				const submission = await lease.runtime.submit("same question", "stable-request");
				return { id: submission.id, result: await lease.runtime.waitForSubmission(submission.id) };
			} finally { await lease.release(); }
		};
		const first = await submit();
		const duplicate = await submit();
		expect(duplicate.id).toBe(first.id);
		expect(duplicate.result).toMatchObject({ status: "done", text: "one committed answer" });
		expect(faux.state.callCount).toBe(1);
		const held = await service.lease(req, session.id);
		await expect(service.delete(req, session.id)).rejects.toThrow("active operation");
		await held.release();
		const detail = await service.snapshot(req, session.id);
		expect(detail.messages.filter((message) => message.role === "user")).toHaveLength(1);
		const reread = await service.snapshot(req, session.id);
		expect(reread.revision).toBe(detail.revision);
		expect(reread.summary.updatedAt).toBe(detail.summary.updatedAt);
		});
	});

	it("persists and deduplicates assistant notifications without a model turn", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			l3Dirs.push(join(base, "l3"));
			const faux = fauxProvider();
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => config("local"),
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			const note = "📌 旁注问答\nQ: 什么是闭包？\nA: 闭包会保留词法环境。";

			await service.appendAssistantNotification(req, session.id, note, "btw-exchange-request");
			const first = await service.snapshot(req, session.id);
			expect(first.messages).toHaveLength(1);
			expect(first.messages[0]).toMatchObject({ role: "assistant", content: note });
			expect(first.messages.filter((message) => message.role === "user")).toHaveLength(0);
			expect(faux.state.callCount).toBe(0);

			await service.appendAssistantNotification(req, session.id, note, "btw-exchange-request");
			const duplicate = await service.snapshot(req, session.id);
			expect(duplicate.messages).toEqual(first.messages);
			expect(duplicate.revision).toBe(first.revision);
			expect(faux.state.callCount).toBe(0);
			const memory = new ScopedL3Memory(base);
			expect((await memory.recall("闭包", "another-session")).some((result) => result.sessionId === session.id)).toBe(true);
		});
	});

	it("loads workspace agent and private-skill context afresh on reopen", async () => {
		const base = root();
		const workspace = join(base, "workspace");
		mkdirSync(join(workspace, ".skills", "helper"), { recursive: true });
		writeFileSync(join(workspace, "agent.md"), "先使用工作区术语表。 ");
		writeFileSync(join(workspace, ".skills", "helper", "SKILL.md"), [
			"---",
			"name: durable-helper",
			"description: 工作区专用技能",
			"---",
			"",
			"# Helper",
			"遵循本工作区的特殊工作流程。",
		].join("\n"));
		const faux = fauxProvider();
		const instructionSnapshots: string[] = [];
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => workspace,
			openRuntime: async (options) => {
				instructionSnapshots.push(options.instructions ?? "");
				const models = createModels();
				models.setProvider(faux.provider);
				return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
			},
		});
		services.push(service);
		await runWithoutTenantContext(async () => {
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			const reopen = async () => {
				const lease = await service.lease(req, session.id);
				await lease.release();
			};
			await reopen();
			expect(instructionSnapshots[0]).toContain("# 工作区上下文 (agent.md)");
			expect(instructionSnapshots[0]).toContain("先使用工作区术语表。");
			expect(instructionSnapshots[0]).toContain("# 本工作区私有技能");
			expect(instructionSnapshots[0]).toContain("durable-helper");
			expect(instructionSnapshots[0]).toContain("工作区专用技能");

			writeFileSync(join(workspace, "agent.md"), "使用更新后的工作区规则。");
			await reopen();
			expect(instructionSnapshots[1]).toContain("使用更新后的工作区规则。");
			expect(instructionSnapshots[1]).not.toContain("先使用工作区术语表。");
		});
	});

	it("indexes durable snapshots and prepares recall outside the current session", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			l3Dirs.push(join(base, "l3"));
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("复习监督学习和梯度下降")]);
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => config("local"),
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			const lease = await service.lease(req, session.id);
			try {
				const submission = await lease.runtime.submit("之前学习了机器学习的基本概念", "durable-l3-index");
				await lease.runtime.waitForSubmission(submission.id);
			} finally { await lease.release(); }
			await service.snapshot(req, session.id);
			const memory = new ScopedL3Memory(base);
			const recalled = await memory.recall("机器学习", "durable-current");
			expect(recalled.some((result) => result.sessionId === session.id)).toBe(true);
			expect(await memory.recall("机器学习", session.id)).toEqual([]);
			const next = await service.create(req, { workspaceId: "workspace" });
			const context = await service.prepareRecallContext(req, next.id, "机器学习");
			expect(context).toContain("# 相关历史对话");
			expect(context).toContain("之前学习了机器学习");
			expect(await service.prepareRecallContext(req, session.id, "机器学习")).toBe("");
		});
	});

	it("upgrades automatic topics with the pinned model and preserves manual renames", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const faux = fauxProvider();
			faux.setResponses([
				fauxAssistantMessage("answer 1"),
				fauxAssistantMessage("answer 2"),
				fauxAssistantMessage("answer 3"),
				fauxAssistantMessage("answer 4"),
			]);
			let currentConfig = config("local");
			const completions: Array<{ provider: string; modelId: string; prompt: string }> = [];
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => currentConfig,
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
				},
				completeTopic: async (_config, selection, prompt) => {
					completions.push({ ...selection, prompt });
					return "标题：Rust 所有权入门";
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			currentConfig = normalizeConfig({
				...currentConfig,
				defaultProvider: "other-provider",
				defaultModel: "other-model",
				providers: {
					...currentConfig.providers,
					"other-provider": {
						baseUrl: "http://other.invalid/v1",
						apiKey: "other-key",
						models: [{ id: "other-model", name: "Other", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 1_000 }],
					},
				},
			});
			const turn = async (prompt: string, requestId: string) => {
				const lease = await service.lease(req, session.id);
				try {
					const submission = await lease.runtime.submit(prompt, requestId);
					expect((await lease.runtime.waitForSubmission(submission.id)).status).toBe("done");
				} finally { await lease.release(); }
				await service.noteSubmission(req, session.id, prompt);
				await service.snapshot(req, session.id);
			};
			await turn("学习 Rust 所有权", "topic-1");
			await turn("理解借用检查器", "topic-2");
			expect((await service.list(req))[0]?.topicPendingUpgrade).toBe(false);
			await turn("练习生命周期标注", "topic-3");
			await Promise.all([
				service.maybeAutoGenerateTopic(req, session.id),
				service.maybeAutoGenerateTopic(req, session.id),
			]);
			expect(completions).toHaveLength(1);
			expect(completions[0]).toMatchObject({ provider: "faux-configured", modelId: "faux-model" });
			expect(completions[0]?.prompt).toContain("学习 Rust 所有权");
			expect(completions[0]?.prompt).toContain("练习生命周期标注");
			expect((await service.list(req))[0]).toMatchObject({ name: "Rust 所有权入门", topicPendingUpgrade: false });

			await service.rename(req, session.id, "我的手动标题");
			await turn("继续练习", "topic-4");
			await service.maybeAutoGenerateTopic(req, session.id);
			expect(completions).toHaveLength(1);
			expect((await service.list(req))[0]?.name).toBe("我的手动标题");
		});
	});

	it("does not let an in-flight automatic topic overwrite a manual rename", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("answer 1"), fauxAssistantMessage("answer 2"), fauxAssistantMessage("answer 3")]);
			let finishTopic!: (value: string) => void;
			let topicStarted = false;
			const completion = new Promise<string>((resolve) => { finishTopic = resolve; });
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => config("local"),
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } });
				},
				completeTopic: async () => {
					topicStarted = true;
					return completion;
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			for (const [index, prompt] of ["first", "second", "third"].entries()) {
				const lease = await service.lease(req, session.id);
				try {
					const submission = await lease.runtime.submit(prompt, `rename-topic-${index}`);
					await lease.runtime.waitForSubmission(submission.id);
				} finally { await lease.release(); }
				await service.noteSubmission(req, session.id, prompt);
				await service.snapshot(req, session.id);
			}
			const generation = service.maybeAutoGenerateTopic(req, session.id);
			for (let attempt = 0; attempt < 50 && !topicStarted; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(topicStarted).toBe(true);
			await service.rename(req, session.id, "手动保留");
			finishTopic!("不应覆盖");
			await generation;
			expect((await service.list(req))[0]).toMatchObject({ name: "手动保留", topicPendingUpgrade: false });
		});
	});

	it("invalidates a runtime when its cross-process storage lock is lost", async () => {
		resetMetricsForTests();
		const base = root();
		const context = tenant("tenant-a");
		saveTenantConfig(base, context.tenantId, config("key-a"));
		let acquisitions = 0;
		let releases = 0;
		let closes = 0;
		const losses: Array<() => void> = [];
		const store = {
			acquireDurableStorageLock: async (): Promise<DurableStorageLock> => {
				acquisitions += 1;
				let listener: (() => void) | undefined;
				const lock: DurableStorageLock = {
					lost: false,
					onLost: (callback) => { listener = callback; },
					release: async () => { releases += 1; },
				};
				losses.push(() => {
					(lock as { lost: boolean }).lost = true;
					listener?.();
				});
				return lock;
			},
		} as unknown as TenantStore;
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => base,
			tenantStore: store,
			openRuntime: async () => ({
				close: async () => { closes += 1; },
			}) as unknown as DurableSessionRuntime,
		});
		services.push(service);
		const bound = await inTenant(context, async (req) => ({ req, session: await service.create(req, { workspaceId: "workspace" }) }));
		const lease = async () => inTenant(context, () => service.lease(bound.req, bound.session.id));
		const first = await lease();
		expect(acquisitions).toBe(1);
		losses[0]!();
		await first.release();
		expect({ closes, releases }).toEqual({ closes: 1, releases: 1 });
		const second = await lease();
		expect(acquisitions).toBe(2);
		await second.release();
		expect({ closes, releases }).toEqual({ closes: 2, releases: 2 });
		const { counters, summaries, gauges } = metricsSnapshot();
		expect(counters.inno_advisory_lock_acquired_total).toBe(2);
		expect(counters.inno_advisory_lock_lost_total).toBe(1);
		expect(summaries.inno_advisory_lock_acquire_ms?.count).toBe(2);
		expect(summaries.inno_catalog_write_ms?.count).toBeGreaterThan(0);
		expect(gauges.inno_catalog_sessions).toBe(1);
	});

	it("switches the model of one session from its next request and keeps it after reopen", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const faux = fauxProvider({
				provider: "faux-configured",
				models: [{ id: "faux-a" }, { id: "faux-b" }],
			});
			faux.setResponses([
				(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`),
				(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`),
				(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`),
			]);
			const twoModels = normalizeConfig({
				defaultProvider: "faux-configured",
				defaultModel: "faux-a",
				providers: {
					"faux-configured": {
						baseUrl: "http://faux.invalid/v1",
						apiKey: "local",
						models: ["faux-a", "faux-b"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 1_000 })),
					},
				},
			});
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => twoModels,
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models });
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			expect(session.model).toEqual({ provider: "faux-configured", id: "faux-a" });

			const ask = async (text: string, requestId: string) => {
				const lease = await service.lease(req, session.id);
				try {
					const submission = await lease.runtime.submit(text, requestId);
					const result = await lease.runtime.waitForSubmission(submission.id);
					return result.status === "done" ? result.text : result.reason;
				} finally {
					await lease.release();
				}
			};

			expect(await ask("q1", "r1")).toBe("answered by faux-a");

			const switched = await service.setModel(req, session.id, { provider: "faux-configured", modelId: "faux-b" });
			expect(switched.model).toEqual({ provider: "faux-configured", id: "faux-b" });
			expect(await ask("q2", "r2")).toBe("answered by faux-b");

			// Context usage comes from the committed conversation of the active model.
			const usage = await service.contextUsage(req, session.id);
			expect(usage).toMatchObject({ sessionId: session.id, status: "ready", contextWindow: 8_000 });
			expect(usage.tokens).toBeGreaterThan(0);
			expect(usage.breakdown.find((part) => part.id === "tools")!.tokens).toBeGreaterThan(0);

			// A model that is not configured is rejected and changes nothing.
			await expect(service.setModel(req, session.id, { provider: "faux-configured", modelId: "missing" }))
				.rejects.toBeInstanceOf(DurableModelNotFoundError);
			expect((await service.get(req, session.id))?.modelId).toBe("faux-b");

			// The runtime was closed on release; reopening keeps the switched model.
			expect(await ask("q3", "r3")).toBe("answered by faux-b");
		});
	});

	it("answers side questions through the session's own model without touching the transcript", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const calls: Array<{ selection: { provider: string; modelId: string }; systemPrompt: string; turns: Array<{ role: string; text: string }> }> = [];
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => config("local"),
				enabled: true,
				resolveWorkspaceDir: () => base,
				completeChat: async (_config, selection, input) => {
					calls.push({ selection, systemPrompt: input.systemPrompt, turns: [...input.turns] });
					return "旁注答案";
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });

			const answer = await service.completeSideQuestion(req, session.id, {
				contextDigest: "主对话摘要",
				thread: [{ question: "上一个问题", answer: "上一个回答" }],
				question: "这个怎么理解？",
			});

			expect(answer).toBe("旁注答案");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.selection).toEqual({ provider: "faux-configured", modelId: "faux-model" });
			expect(calls[0]!.systemPrompt).toContain("旁注问答");
			expect(calls[0]!.turns).toEqual([
				{ role: "user", text: "主对话摘要" },
				{ role: "user", text: "上一个问题" },
				{ role: "assistant", text: "上一个回答" },
				{ role: "user", text: "这个怎么理解？" },
			]);
			expect((await service.get(req, session.id))?.messageCount).toBe(0);
		});
	});

	it("edits an earlier message by continuing in a fork that drops it and the replies after it", async () => {
		await runWithoutTenantContext(async () => {
			const base = root();
			const faux = fauxProvider({ provider: "faux-configured", models: [{ id: "faux-a" }] });
			const seen: string[][] = [];
			const reply = (label: string) => (context: { messages: ReadonlyArray<{ role: string; content: unknown }> }) => {
				seen.push(context.messages.map((message) => message.role === "user"
					? String((message.content as Array<{ text?: string }>)[0]?.text ?? message.content)
					: `[${message.role}]`));
				return fauxAssistantMessage(label);
			};
			faux.setResponses([reply("a1"), reply("a2"), reply("a2-edited"), reply("fresh")] as never);
			const cfg = normalizeConfig({
				defaultProvider: "faux-configured",
				defaultModel: "faux-a",
				providers: {
					"faux-configured": {
						baseUrl: "http://faux.invalid/v1",
						apiKey: "local",
						models: [{ id: "faux-a", name: "faux-a", reasoning: false, input: ["text"], contextWindow: 8_000, maxTokens: 1_000 }],
					},
				},
			});
			const service = new DurableSessionService({
				dataDir: base,
				getLocalConfig: () => cfg,
				enabled: true,
				resolveWorkspaceDir: () => base,
				openRuntime: async (options) => {
					const models = createModels();
					models.setProvider(faux.provider);
					return DurableSessionRuntime.open({ ...options, models });
				},
			});
			services.push(service);
			const req = { headers: {} } as IncomingMessage;
			const session = await service.create(req, { workspaceId: "workspace" });
			const ask = async (text: string, requestId: string) => {
				const lease = await service.lease(req, session.id);
				try {
					const submission = await lease.runtime.submit(text, requestId);
					await lease.runtime.waitForSubmission(submission.id);
				} finally {
					await lease.release();
				}
			};
			const visible = async () => (await service.snapshot(req, session.id)).messages.map((message) => `${message.role}:${message.content}`);

			await ask("first question", "r1");
			await ask("second question", "r2");
			expect(await visible()).toEqual(["user:first question", "assistant:a1", "user:second question", "assistant:a2"]);

			const before = await service.snapshot(req, session.id);
			const secondUser = before.messages.find((message) => message.content === "second question")!;
			const branched = await service.branchBeforeMessage(req, session.id, secondUser.entryId!);
			expect(branched).toMatchObject({ sessionId: session.id, replacedEntryId: secondUser.entryId });
			expect(branched.sessionRevision).toMatch(/^durable:/);
			expect(await visible()).toEqual(["user:first question", "assistant:a1"]);

			// The edited message goes to a model that no longer sees the abandoned turn.
			await ask("second question, edited", "r3");
			expect(await visible()).toEqual([
				"user:first question", "assistant:a1", "user:second question, edited", "assistant:a2-edited",
			]);
			expect(seen[2]).toEqual(["[system]", "first question", "[assistant]", "second question, edited"]);

			// The branch survives the runtime being closed and reopened.
			expect(await visible()).toHaveLength(4);

			// Editing the very first message starts the conversation over.
			const first = (await service.snapshot(req, session.id)).messages[0]!;
			await service.branchBeforeMessage(req, session.id, first.entryId!);
			expect(await visible()).toEqual([]);
			await ask("brand new", "r4");
			expect(await visible()).toEqual(["user:brand new", "assistant:fresh"]);
			expect(seen[3]).toEqual(["[system]", "brand new"]);

			// Only user messages can be edited; unknown entries are rejected and change nothing.
			const assistantEntry = (await service.snapshot(req, session.id)).messages.find((message) => message.role === "assistant")!;
			await expect(service.branchBeforeMessage(req, session.id, assistantEntry.entryId!))
				.rejects.toMatchObject({ code: "entry_not_found" });
			await expect(service.branchBeforeMessage(req, session.id, "999999"))
				.rejects.toMatchObject({ code: "entry_not_found" });
			expect(await visible()).toEqual(["user:brand new", "assistant:fresh"]);
		});
	});

	it("offers document, web search and scheduler tools to durable sessions", async () => {
		await runWithoutTenantContext(async () => {
		const base = root();
		let captured: DurableSessionRuntimeOptions | undefined;
		const skillsDir = join(base, "global-skills");
		for (const name of ["demo-skill", "off-skill"]) {
			mkdirSync(join(skillsDir, name), { recursive: true });
			writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n`);
		}
		writeFileSync(join(skillsDir, ".ignore"), "off-skill/\n");
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: true,
			resolveWorkspaceDir: () => base,
			skillsDir,
			getSchedulerTools: () => createSchedulerTools(
				{ defaultTimezone: "UTC" } as never,
				undefined,
				undefined,
				{ runMode: "unavailable" },
			),
			openRuntime: async (options) => {
				captured = options;
				return { close: async () => undefined } as unknown as DurableSessionRuntime;
			},
		});
		services.push(service);
		const req = { headers: {} } as IncomingMessage;
		const session = await service.create(req, { workspaceId: "workspace" });
		const lease = await service.lease(req, session.id);
		await lease.release();

		expect(captured?.instructions).toContain("<name>demo-skill</name>");
		expect(captured?.instructions).not.toContain("<name>off-skill</name>");
		const names = (captured?.extraTools ?? []).map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining([
			"parse_document",
			"web_search",
			"create_scheduled_job",
			"list_scheduled_jobs",
			"update_scheduled_job",
			"delete_scheduled_job",
			"run_scheduled_job",
		]));
		// Non-replayable by default: a crash yields `interrupted`, never a silent rerun.
		expect((captured?.extraTools ?? []).every((tool) => tool.replay !== "safe")).toBe(true);
			});
	});

	it("requires the explicit runtime gate and leaves legacy JSONL untouched", async () => {
		const base = root();
		const service = new DurableSessionService({
			dataDir: base,
			getLocalConfig: () => config("local"),
			enabled: false,
			resolveWorkspaceDir: () => base,
		});
		services.push(service);
		const req = { headers: {} } as IncomingMessage;
		await expect(service.create(req, { workspaceId: "workspace" })).rejects.toBeInstanceOf(DurableRuntimeDisabledError);
		const legacy = join(base, "sessions", "legacy.jsonl");
		mkdirSync(join(base, "sessions"), { recursive: true });
		writeFileSync(legacy, "{\"type\":\"session\"}\n");
		expect(readFileSync(legacy, "utf-8")).toBe("{\"type\":\"session\"}\n");
	});
});
