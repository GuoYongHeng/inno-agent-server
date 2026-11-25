import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckInStore, FileCheckInStore, occurrenceIdFor } from "./check-in-store.js";
import { dateKeyForTimeZone } from "../scheduler/cron-utils.js";
import { FileJobStore, JobStore } from "../scheduler/job-store.js";
import { writeJson } from "../storage/file-store.js";
import { runInTenantContext } from "../tenants/current.js";
import type { TenantContext, TenantStore } from "../tenants/store.js";

let dir: string;
let jobStore: JobStore;
let checkInStore: CheckInStore;

const TODAY = new Date("2026-09-10T02:00:00.000Z"); // 10:00 Asia/Shanghai

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-checkins-"));
	jobStore = new FileJobStore(join(dir, "jobs"), "Asia/Shanghai");
	checkInStore = new FileCheckInStore(join(dir, "data"), "Asia/Shanghai", jobStore);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function createJob(overrides: Partial<Parameters<JobStore["create"]>[0]> = {}) {
	return await jobStore.create({
		name: "daily review",
		cron: "0 9 * * *",
		timezone: "Asia/Shanghai",
		enabled: true,
		taskType: "daily_review",
		prompt: "review my notes",
		...overrides,
	});
}

async function completeOccurrence(occurrence: { occurrenceId: string; jobId: string; scheduledAt: string }, runId = "run-success") {
	return await checkInStore.recordOccurrence({
		occurrenceId: occurrence.occurrenceId,
		jobId: occurrence.jobId,
		scheduledAt: occurrence.scheduledAt,
		status: "success",
		runId,
		finishedAt: TODAY.toISOString(),
	});
}

describe("CheckInStore daily plan", () => {
	it("counts today's learning slots and ignores reminder jobs", async () => {
		const learning = await createJob();
		await createJob({ name: "push", taskType: "push_reminder", cron: "0 10 * * *" });
		await createJob({ name: "check-in reminder", taskType: "check_in_reminder", cron: "0 11 * * *" });

		const status = await checkInStore.status(TODAY);
		expect(status.dayStatus).toBe("pending");
		expect(status.requiredCount).toBe(1);
		expect(status.requiredCount).toBe(1);
		expect(status.completedCount).toBe(0);
		expect(status.jobs.map((job) => job.jobId)).toEqual([learning.id]);
		expect(status.jobs[0].occurrences[0].scheduledAt).toBe("2026-09-10T01:00:00.000Z");
	});

	it("requires every planned occurrence when a job runs multiple times", async () => {
		const job = await createJob({ cron: "0 9,18 * * *" });
		const plan = await checkInStore.getTodayPlan(TODAY);
		expect(plan.jobs.map((entry) => entry.jobId)).toContain(job.id);
		const occurrences = plan.jobs[0].occurrences;
		expect(occurrences).toHaveLength(2);

		await completeOccurrence(occurrences[0], "run-morning");
		let status = await checkInStore.status(TODAY);
		expect(status.completedCount).toBe(1);
		expect(status.remainingCount).toBe(1);
		expect(status.todayCheckedIn).toBe(false);

		const result = await completeOccurrence(occurrences[1], "run-evening");
		expect(result.justCompleted).toBe(true);
		status = await checkInStore.status(TODAY);
		expect(status.dayStatus).toBe("completed");
		expect(status.todayCheckedIn).toBe(true);
		expect(status.currentStreak).toBe(1);
	});

	it("supports weekly, monthly, and one-time schedules on their matching date", async () => {
		await createJob({ name: "weekly", cron: "0 10 * * 4" });
		await createJob({ name: "monthly", cron: "0 11 10 * *" });
		await createJob({ name: "once", cron: "0 12 10 9 *" });
		await createJob({ name: "not today", cron: "0 12 * * 5" });

		const status = await checkInStore.status(TODAY);
		expect(status.requiredCount).toBe(3);
		expect(status.jobs.map((job) => job.jobName)).toEqual(["weekly", "monthly", "once"]);
	});

	it("blocks on errors, but skipped slots do not block", async () => {
		const first = await createJob({ name: "first" });
		const second = await createJob({ name: "second", cron: "0 10 * * *" });
		const [firstOccurrence] = (await checkInStore.getTodayPlan(TODAY)).jobs.find((job) => job.jobId === first.id)!.occurrences;
		const [secondOccurrence] = (await checkInStore.getTodayPlan(TODAY)).jobs.find((job) => job.jobId === second.id)!.occurrences;

		await checkInStore.recordOccurrence({
			...firstOccurrence,
			status: "error",
			runId: "run-error",
			finishedAt: TODAY.toISOString(),
		});
		await checkInStore.recordOccurrence({
			...secondOccurrence,
			status: "skipped",
			runId: "run-skipped",
			finishedAt: TODAY.toISOString(),
		});

		let status = await checkInStore.status(TODAY);
		expect(status.failedCount).toBe(1);
		expect(status.skippedCount).toBe(1);
		expect(status.requiredCount).toBe(1);
		expect(status.remainingCount).toBe(1);
		expect(status.todayCheckedIn).toBe(false);

		await checkInStore.recordOccurrence({
			...firstOccurrence,
			status: "success",
			runId: "run-retry",
			finishedAt: TODAY.toISOString(),
		});
		status = await checkInStore.status(TODAY);
		expect(status.todayCheckedIn).toBe(true);
		expect(status.completedCount).toBe(1);
	});

	it("resolves a selected pending or failed slot and fills only that slot", async () => {
		const job = await createJob({ cron: "0 9,18 * * *" });
		const occurrences = (await checkInStore.getTodayPlan(TODAY)).jobs[0].occurrences;

		expect((await checkInStore.resolveOccurrence(job.id, occurrences[1].occurrenceId, TODAY))?.occurrenceId)
			.toBe(occurrences[1].occurrenceId);
		await completeOccurrence(occurrences[1], "run-evening");
		expect(await checkInStore.resolveOccurrence(job.id, occurrences[1].occurrenceId, TODAY)).toBeUndefined();
		expect((await checkInStore.resolveOccurrence(job.id, undefined, TODAY))?.occurrenceId)
			.toBe(occurrences[0].occurrenceId);
	});

	it("reacts to current-day task changes", async () => {
		const first = await createJob({ name: "first" });
		await completeOccurrence((await checkInStore.getTodayPlan(TODAY)).jobs[0].occurrences[0]);
		expect((await checkInStore.status(TODAY)).todayCheckedIn).toBe(true);

		const added = await createJob({ name: "added", cron: "0 10 * * *" });
		expect((await checkInStore.status(TODAY)).todayCheckedIn).toBe(false);
		expect((await checkInStore.status(TODAY)).remainingCount).toBe(1);

		await jobStore.update(added.id, { enabled: false });
		expect((await checkInStore.status(TODAY)).todayCheckedIn).toBe(true);
		await jobStore.update(first.id, { enabled: false });
		expect((await checkInStore.status(TODAY)).dayStatus).toBe("no_tasks");
		expect((await checkInStore.status(TODAY)).totalCount).toBe(0);
	});

	it("does not create a check-in on a day with no learning tasks", async () => {
		await createJob({ cron: "0 9 * * 4" });
		const friday = new Date("2026-09-11T02:00:00.000Z");
		const status = await checkInStore.status(friday);
		expect(status.dayStatus).toBe("no_tasks");
		expect(status.todayCheckedIn).toBe(false);
		expect(status.totalCount).toBe(0);
		expect(await checkInStore.list()).toHaveLength(0);
	});

	it("preserves legacy history without allowing it to bypass today's plan", async () => {
		await createJob();
		writeJson(join(dir, "data", "checkins", "checkins.json"), [
			{ date: "2026-09-09", checkedInAt: "2026-09-09T12:00:00.000Z" },
			{ date: "2026-09-10", checkedInAt: "2026-09-10T01:30:00.000Z" },
		]);

		let status = await checkInStore.status(TODAY);
		expect(status.todayCheckedIn).toBe(false);
		expect(status.totalCount).toBe(1);
		expect(status.currentStreak).toBe(1);

		const occurrence = (await checkInStore.getTodayPlan(TODAY)).jobs[0].occurrences[0];
		await completeOccurrence(occurrence);
		status = await checkInStore.status(TODAY);
		expect(status.todayCheckedIn).toBe(true);
		expect(status.totalCount).toBe(2);
	});

	it("uses the global timezone for the day key and occurrence identity", async () => {
		const atUtcBoundary = new Date("2026-09-09T16:00:00.000Z");
		expect(dateKeyForTimeZone(atUtcBoundary, "Asia/Shanghai")).toBe("2026-09-10");
		const job = await createJob();
		const occurrence = (await checkInStore.getTodayPlan(TODAY)).jobs[0].occurrences[0];
		expect(occurrence.occurrenceId).toBe(occurrenceIdFor(job.id, occurrence.scheduledAt));
	});
});

describe("tenant-scoped check-ins", () => {
	it("keys in-flight occurrence claims by tenant as well as occurrence id", async () => {
		const tenantStore = {} as TenantStore;
		const tenantA: TenantContext = { tenantId: "a", userId: "a", role: "owner" };
		const tenantB: TenantContext = { tenantId: "b", userId: "b", role: "owner" };
		runInTenantContext(tenantA, tenantStore, async () => {
			expect(checkInStore.claimOccurrence("same-occurrence")).toBe(true);
			expect(checkInStore.claimOccurrence("same-occurrence")).toBe(false);
		});
		runInTenantContext(tenantB, tenantStore, async () => {
			expect(checkInStore.claimOccurrence("same-occurrence")).toBe(true);
			checkInStore.releaseOccurrenceClaim("same-occurrence");
		});
		runInTenantContext(tenantA, tenantStore, async () => {
			expect(checkInStore.isOccurrenceClaimed("same-occurrence")).toBe(true);
		});
	});
});
