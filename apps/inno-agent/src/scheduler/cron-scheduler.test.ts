import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../channels/channel.js";
import { CronScheduler } from "./cron-scheduler.js";
import { executeJob } from "./job-runner.js";
import { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";

vi.mock("./job-runner.js", () => ({
	executeJob: vi.fn(async (job: ScheduledJob) => ({ jobId: job.id, runId: `run-${job.id}`, success: true, output: "done" })),
	pushThroughDefaultChannel: vi.fn(async () => undefined),
}));

const dirs: string[] = [];
const schedulers: CronScheduler[] = [];

afterEach(() => {
	for (const scheduler of schedulers.splice(0)) scheduler.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("CronScheduler runtime targets", () => {
	it("gives every run a durable session and passes the executor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "inno-cron-runtime-"));
		dirs.push(dir);
		const store = new JobStore(dir, "UTC");
		const first = store.create({
			name: "first", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "custom_prompt", prompt: "first prompt",
		});
		const second = store.create({
			name: "second", cron: "* * * * *", timezone: "UTC", enabled: true,
			taskType: "custom_prompt", prompt: "second prompt", runtime: "durable",
		});
		const durableExecutor = vi.fn(async () => "durable done");
		const scheduler = new CronScheduler(store, new ChannelRegistry(), undefined, {
			createSession: async (job) => ({ id: `durable-${job.id}`, runtime: "durable" as const }),
			durableExecutor,
		});
		schedulers.push(scheduler);
		await scheduler.tick();
		await vi.waitFor(() => expect(vi.mocked(executeJob)).toHaveBeenCalledTimes(2));
		for (const job of [first, second]) {
			const call = vi.mocked(executeJob).mock.calls.find((entry) => entry[0].id === job.id);
			expect(call?.[5]).toMatchObject({
				sessionId: `durable-${job.id}`, sessionRuntime: "durable", durableExecutor,
			});
		}
	});
});
