import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../channels/channel.js";
import { executeJob } from "./job-runner.js";
import { FileJobStore, JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

const dirs: string[] = [];
let store: JobStore;
let channels: ChannelRegistry;

async function createJob(patch: Partial<ScheduledJob> = {}): Promise<ScheduledJob> {
	return await store.create({
		name: "runtime test", cron: "0 9 * * *", timezone: "UTC", enabled: true,
		taskType: "custom_prompt", prompt: "job prompt", ...patch,
	});
}

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "inno-job-runner-"));
	dirs.push(dir);
	store = new FileJobStore(dir, "UTC");
	channels = new ChannelRegistry();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("job execution", () => {
	it("runs agent jobs through the injected durable executor with scoped request and turn IDs", async () => {
		const job = await createJob({ runtime: "durable" });
		const onEvent = vi.fn();
		const durableExecutor = vi.fn(async () => "durable output");
		const result = await executeJob(job, store, channels, "api", undefined, {
			sessionId: "durable-session",
			sessionRuntime: "durable",
			durableExecutor,
			requestId: "job-request",
			turnId: "job-turn",
			onEvent,
		});
		expect(result).toMatchObject({ success: true, output: "durable output" });
		expect(durableExecutor).toHaveBeenCalledWith({
			sessionId: "durable-session", prompt: "job prompt", requestId: "job-request",
			turnId: "job-turn", onEvent,
		});
		expect((await store.listRuns(job.id))[0]).toMatchObject({ status: "success", outputPreview: "durable output" });
	});

	it("fails closed when no durable session or executor is provided", async () => {
		const job = await createJob({ runtime: "durable" });
		const result = await executeJob(job, store, channels);
		expect(result).toMatchObject({ success: false });
		expect(result.error).toContain("owned durable session and executor");
		expect((await store.listRuns(job.id))[0]).toMatchObject({ status: "error" });
	});

	it("records a reminder in the run's durable session without asking the model", async () => {
		const job = await createJob({ taskType: "push_reminder", prompt: "该复习了" });
		const durableExecutor = vi.fn(async () => "");
		const result = await executeJob(job, store, channels, "manual", undefined, {
			sessionId: "durable-session", sessionRuntime: "durable", durableExecutor,
		});
		expect(result.success).toBe(true);
		expect(durableExecutor).toHaveBeenCalledTimes(1);
		expect(durableExecutor).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "durable-session", prompt: "该复习了", notifyOnly: true,
		}));
	});

	it("runs a reminder without a session when none is available", async () => {
		const job = await createJob({ taskType: "push_reminder", prompt: "该复习了" });
		const result = await executeJob(job, store, channels, "manual");
		expect(result).toMatchObject({ success: true, output: "该复习了" });
	});
});
