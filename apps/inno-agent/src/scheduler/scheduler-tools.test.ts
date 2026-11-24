import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerTools } from "./scheduler-tools.js";
import { FileJobStore, type JobStore } from "./job-store.js";
import { AmbientJobStore } from "./ambient-job-store.js";
import { runInTenantContext } from "../tenants/current.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";
import { ChannelRegistry } from "../channels/channel.js";

let dir: string;
let jobs: JobStore;
let tenantStore: TenantStore;
const tenantA: TenantContext = { tenantId: "a", userId: "a", role: "owner" };
const tenantB: TenantContext = { tenantId: "b", userId: "b", role: "owner" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-scheduler-tools-"));
	jobs = new AmbientJobStore(
		new Map<string, JobStore>([
			[tenantA.tenantId, new FileJobStore(join(dir, "jobs-a"))],
			[tenantB.tenantId, new FileJobStore(join(dir, "jobs-b"))],
		]),
		new FileJobStore(join(dir, "legacy")),
	);
	tenantStore = {
		claimResource: vi.fn().mockResolvedValue(undefined),
		releaseResource: vi.fn().mockResolvedValue(undefined),
	} as unknown as TenantStore;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function execute(toolIndex: number, params: Record<string, unknown>, channelRegistry?: ChannelRegistry) {
	const tool = createSchedulerTools(jobs, channelRegistry)[toolIndex];
	const result = await (tool.execute as (...args: any[]) => Promise<any>)(params, { callId: "call" }, { abortSignal: undefined });
	return { content: result.output ?? [], details: result.details ?? {} };
}

describe("tenant-scoped scheduler tools", () => {
	it("claims new jobs, hides them from other tenants, and blocks unscoped execution", async () => {
		const created = await runInTenantContext(tenantA, tenantStore, async () => execute(0, {
			name: "private", cron: "0 9 * * *", taskType: "daily_review", prompt: "review",
		}));
		const jobId = created.details.jobId as string;
		expect(tenantStore.claimResource).toHaveBeenCalledWith(tenantA, "job", jobId);

		const listB = await runInTenantContext(tenantB, tenantStore, async () => execute(1, {}));
		expect(listB.content[0].text).toContain("当前没有定时任务");
		const updateB = await runInTenantContext(tenantB, tenantStore, async () => execute(2, { id: jobId, name: "stolen" }));
		expect(updateB.content[0].text).toContain("未找到任务");
		const deleteB = await runInTenantContext(tenantB, tenantStore, async () => execute(3, { id: jobId }));
		expect(deleteB.content[0].text).toContain("未找到任务");
		expect(tenantStore.releaseResource).not.toHaveBeenCalled();

		const runA = await runInTenantContext(tenantA, tenantStore, async () => execute(4, { id: jobId }));
		expect(runA.details.error).toBe("scoped_runtime_unavailable");
		const deleteA = await runInTenantContext(tenantA, tenantStore, async () => execute(3, { id: jobId }));
		expect(deleteA.content[0].text).toContain("已删除");
		expect(tenantStore.releaseResource).toHaveBeenCalledWith(tenantA, "job", jobId);
	});

	it("claims channel-backed jobs with the current tenant's default target", async () => {
		const channels = new ChannelRegistry();
		channels.register({
			name: "feishu", verify: async () => true, parse: async () => null,
			reply: async () => {}, push: async () => {},
		});
		await channels.setDefaultTarget({ channel: "feishu", chatId: "tenant-chat" });
		const result = await runInTenantContext(tenantA, tenantStore, async () => execute(0, {
			name: "push", cron: "0 9 * * *", taskType: "push_reminder", prompt: "secret", channel: "feishu",
		}, channels));
		const job = await runInTenantContext(tenantA, tenantStore, async () => (await jobs.list()).at(0));
		expect(result.details.error).toBeUndefined();
		expect(job?.target).toEqual({ channel: "feishu", chatId: "tenant-chat" });
		expect(tenantStore.claimResource).toHaveBeenCalledWith(tenantA, "job", job?.id);
	});

	it("refuses to run a job when the runtime has no durable job executor", async () => {
		const job = await jobs.create({ name: "demo", cron: "0 9 * * *", timezone: "UTC", enabled: true, taskType: "custom_prompt", prompt: "hi" } as never);
		const tool = createSchedulerTools(jobs, new ChannelRegistry(), undefined, { runMode: "unavailable" })[4];
		const result = await (tool.execute as (...args: any[]) => Promise<any>)({ id: job.id }, { callId: "call" }, { abortSignal: undefined });
		expect(result.details).toMatchObject({ error: "run_unavailable" });
	});

	it("runs a job through an injected runner instead of the legacy global runner", async () => {
		const job = await jobs.create({ name: "demo", cron: "0 9 * * *", timezone: "UTC", enabled: true, taskType: "custom_prompt", prompt: "hi" } as never);
		const runJob = vi.fn().mockResolvedValue({ jobId: job.id, runId: "run-1", success: true, output: "done by durable" });
		const tool = createSchedulerTools(jobs, undefined, undefined, { runJob })[4];
		const result = await (tool.execute as (...args: any[]) => Promise<any>)({ id: job.id }, { callId: "call" }, { abortSignal: undefined });
		expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
		expect(result.output[0].text).toContain("done by durable");
	});
});
