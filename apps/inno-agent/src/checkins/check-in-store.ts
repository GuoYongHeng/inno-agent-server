import { join } from "node:path";
import type { Pool } from "pg";
import { readJson, writeJson, ensureDir } from "../storage/file-store.js";
import type { JobStore } from "../scheduler/job-store.js";
import type { JobRunStatus, ScheduledJob } from "../scheduler/types.js";
import { getCurrentTenant } from "../tenants/current.js";
import {
	dateKeyForTimeZone,
	DEFAULT_SCHEDULER_TIMEZONE,
	getCronOccurrencesForDate,
} from "../scheduler/cron-utils.js";

const CHECKINS_FILE = "checkins.json";
const OCCURRENCES_FILE = "occurrences.json";
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEARNING_TASK_EXCLUSIONS = new Set(["check_in_reminder", "push_reminder"]);

export type CheckInDayStatus = "no_tasks" | "pending" | "completed";
export type CheckInOccurrenceStatus = "pending" | "success" | "error" | "skipped";

export interface CheckInRecord {
	date: string;
	checkedInAt: string;
	completedOccurrenceIds: string[];
}

export interface CheckInOccurrence {
	occurrenceId: string;
	jobId: string;
	jobName: string;
	taskType: ScheduledJob["taskType"];
	scheduledAt: string;
	status: CheckInOccurrenceStatus;
	error?: string;
}

export interface CheckInJobStatus {
	jobId: string;
	jobName: string;
	taskType: ScheduledJob["taskType"];
	occurrences: CheckInOccurrence[];
}

export interface TodayLearningPlan {
	today: string;
	timezone: string;
	jobs: CheckInJobStatus[];
}

export interface CheckInStatus {
	today: string;
	timezone: string;
	dayStatus: CheckInDayStatus;
	todayCheckedIn: boolean;
	checkedInAt?: string;
	requiredCount: number;
	completedCount: number;
	remainingCount: number;
	failedCount: number;
	skippedCount: number;
	currentStreak: number;
	longestStreak: number;
	totalCount: number;
	jobs: CheckInJobStatus[];
}

export interface CheckInOccurrenceResult {
	status: CheckInStatus;
	justCompleted: boolean;
}

export interface RecordCheckInOccurrenceInput {
	occurrenceId: string;
	jobId: string;
	scheduledAt: string;
	status: Extract<JobRunStatus, "success" | "error" | "skipped">;
	runId: string;
	finishedAt: string;
	error?: string;
}

interface OccurrenceRecord extends RecordCheckInOccurrenceInput {
	date: string;
	updatedAt: string;
}

/** Stable identity for one job's planned execution slot. */
export function occurrenceIdFor(jobId: string, scheduledAt: string): string {
	return `${jobId}:${scheduledAt}`;
}

/** Whether a scheduled job represents learning work rather than a reminder. */
export function isLearningJob(job: ScheduledJob): boolean {
	return !LEARNING_TASK_EXCLUSIONS.has(job.taskType);
}

/**
 * Daily progress ledger for the scheduler-driven learning check-in
 * (checkins.json / occurrences.json → `tenant_checkins` +
 * `tenant_checkin_occurrences`). The check-in record is derived from today's
 * live job configuration and the occurrence ledger; a client cannot mark a
 * day complete on its own.
 */
export abstract class CheckInStore {
	readonly timezone: string;
	private claimedOccurrences = new Set<string>();

	constructor(
		timezone: string = DEFAULT_SCHEDULER_TIMEZONE,
		private readonly jobStore: JobStore | (() => JobStore),
	) {
		this.timezone = timezone || DEFAULT_SCHEDULER_TIMEZONE;
	}

	protected abstract readCheckInRecords(): Promise<CheckInRecord[]>;
	protected abstract upsertCheckInRecord(record: CheckInRecord): Promise<void>;
	protected abstract listOccurrenceRecords(): Promise<OccurrenceRecord[]>;
	protected abstract getOccurrenceRecord(occurrenceId: string): Promise<OccurrenceRecord | undefined>;
	protected abstract upsertOccurrenceRecord(record: OccurrenceRecord): Promise<void>;

	protected jobs(): Promise<ScheduledJob[]> {
		return (typeof this.jobStore === "function" ? this.jobStore() : this.jobStore).list();
	}

	async list(): Promise<CheckInRecord[]> {
		return this.readCheckInRecords();
	}

	async getTodayPlan(now: Date = new Date()): Promise<TodayLearningPlan> {
		const today = dateKeyForTimeZone(now, this.timezone);
		const occurrenceRecords = new Map((await this.listOccurrenceRecords()).map((record) => [record.occurrenceId, record]));
		const jobs = (await this.jobs())
			.filter((job) => job.enabled && isLearningJob(job))
			.map((job): CheckInJobStatus | null => {
				const scheduledAt = getCronOccurrencesForDate(job.cron, job.timezone, today, this.timezone);
				if (scheduledAt.length === 0) return null;
				return {
					jobId: job.id,
					jobName: job.name,
					taskType: job.taskType,
					occurrences: scheduledAt.map((at) => {
						const occurrenceId = occurrenceIdFor(job.id, at);
						const record = occurrenceRecords.get(occurrenceId);
						return {
							occurrenceId,
							jobId: job.id,
							jobName: job.name,
							taskType: job.taskType,
							scheduledAt: at,
							status: record?.status ?? "pending",
							error: record?.error,
						};
					}),
				};
			})
			.filter((job): job is CheckInJobStatus => job !== null);

		return { today, timezone: this.timezone, jobs };
	}

	async status(now: Date = new Date()): Promise<CheckInStatus> {
		const plan = await this.getTodayPlan(now);
		const occurrences = plan.jobs.flatMap((job) => job.occurrences);
		const completedCount = occurrences.filter((occurrence) => occurrence.status === "success").length;
		const skippedCount = occurrences.filter((occurrence) => occurrence.status === "skipped").length;
		const failedCount = occurrences.filter((occurrence) => occurrence.status === "error").length;
		const remainingCount = occurrences.length - completedCount - skippedCount;
		const dayStatus: CheckInDayStatus = occurrences.length === 0
			? "no_tasks"
			: remainingCount === 0
				? "completed"
				: "pending";

		const records = await this.readCheckInRecords();
		let todayRecord = records.find((record) => record.date === plan.today);
		if (dayStatus === "completed") {
			const completedOccurrenceIds = occurrences
				.filter((occurrence) => occurrence.status === "success")
				.map((occurrence) => occurrence.occurrenceId)
				.sort();
			const sameCompletionSet = todayRecord
				? areSameStrings(todayRecord.completedOccurrenceIds, completedOccurrenceIds)
				: false;
			if (!todayRecord || !sameCompletionSet) {
				todayRecord = {
					date: plan.today,
					checkedInAt: sameCompletionSet ? todayRecord!.checkedInAt : now.toISOString(),
					completedOccurrenceIds,
				};
				await this.upsertCheckInRecord(todayRecord);
			}
		}

		const validDates = [...records, ...(todayRecord && !records.some((record) => record.date === plan.today) ? [todayRecord] : [])]
			.filter((record) => record.date <= plan.today)
			.filter((record) => record.date !== plan.today || dayStatus === "completed")
			.map((record) => record.date)
			.sort()
			.reverse();

		return {
			today: plan.today,
			timezone: plan.timezone,
			dayStatus,
			todayCheckedIn: dayStatus === "completed",
			checkedInAt: dayStatus === "completed" ? todayRecord?.checkedInAt : undefined,
			requiredCount: occurrences.length - skippedCount,
			completedCount,
			remainingCount,
			failedCount,
			skippedCount,
			currentStreak: calculateCurrentStreak(validDates, plan.today),
			longestStreak: calculateLongestStreak(validDates),
			totalCount: validDates.length,
			jobs: plan.jobs,
		};
	}

	async isCheckedInToday(now: Date = new Date()): Promise<boolean> {
		return (await this.status(now)).todayCheckedIn;
	}

	/**
	 * Reserve a slot for execution so cron re-fires, the deferred
	 * auto-execution and manual starts cannot double-run the same slot.
	 * The claim is held while the run is in flight (and after it succeeded —
	 * a fulfilled slot never re-runs); a failed attempt releases it so the
	 * user can retry from the check-in card.
	 */
	claimOccurrence(occurrenceId: string): boolean {
		const key = this.occurrenceClaimKey(occurrenceId);
		if (this.claimedOccurrences.has(key)) return false;
		this.claimedOccurrences.add(key);
		return true;
	}

	releaseOccurrenceClaim(occurrenceId: string): void {
		this.claimedOccurrences.delete(this.occurrenceClaimKey(occurrenceId));
	}

	isOccurrenceClaimed(occurrenceId: string): boolean {
		return this.claimedOccurrences.has(this.occurrenceClaimKey(occurrenceId));
	}

	private occurrenceClaimKey(occurrenceId: string): string {
		return `${getCurrentTenant()?.tenantId ?? "local"}:${occurrenceId}`;
	}

	/**
	 * Find a user-selected occurrence, or the first pending/failed occurrence
	 * for the legacy generic "Run now" action. Skipped and successful slots are
	 * never selected again.
	 */
	async resolveOccurrence(jobId: string, occurrenceId?: string, now: Date = new Date()): Promise<CheckInOccurrence | undefined> {
		const candidates = (await this.getTodayPlan(now)).jobs
			.find((job) => job.jobId === jobId)
			?.occurrences ?? [];
		if (occurrenceId) {
			const selected = candidates.find((occurrence) => occurrence.occurrenceId === occurrenceId);
			return selected && selected.status !== "success" && selected.status !== "skipped" ? selected : undefined;
		}
		return candidates.find((occurrence) => occurrence.status === "pending" || occurrence.status === "error");
	}

	/** Find any live occurrence, including one that was already completed. */
	async getOccurrence(jobId: string, occurrenceId: string, now: Date = new Date()): Promise<CheckInOccurrence | undefined> {
		return (await this.getTodayPlan(now)).jobs
			.find((job) => job.jobId === jobId)
			?.occurrences.find((occurrence) => occurrence.occurrenceId === occurrenceId);
	}

	/** Find a live occurrence by its stable id, including settled slots. */
	async getOccurrenceById(occurrenceId: string, now: Date = new Date()): Promise<CheckInOccurrence | undefined> {
		return (await this.getTodayPlan(now)).jobs
			.flatMap((job) => job.occurrences)
			.find((occurrence) => occurrence.occurrenceId === occurrenceId);
	}

	/**
	 * Persist the result for one planned slot and reconcile today's check-in.
	 * A successful attempt is sticky: a later failed retry cannot undo a slot
	 * that already succeeded.
	 */
	async recordOccurrence(input: RecordCheckInOccurrenceInput): Promise<CheckInOccurrenceResult> {
		const finishedAt = new Date(input.finishedAt);
		const before = await this.status(finishedAt);
		const current = await this.getOccurrenceRecord(input.occurrenceId);
		const status = current?.status === "success" || input.status === "success"
			? "success"
			: input.status;
		await this.upsertOccurrenceRecord({
			...input,
			status,
			date: dateKeyForTimeZone(new Date(input.scheduledAt), this.timezone),
			updatedAt: finishedAt.toISOString(),
		});

		const after = await this.status(finishedAt);
		return {
			status: after,
			justCompleted: !before.todayCheckedIn && after.todayCheckedIn,
		};
	}
}

/** File-backed CheckInStore for unit tests; production uses PgCheckInStore. */
export class FileCheckInStore extends CheckInStore {
	constructor(
		private readonly dataDir: string | (() => string),
		timezone: string = DEFAULT_SCHEDULER_TIMEZONE,
		jobStore: JobStore | (() => JobStore),
	) {
		super(timezone, jobStore);
		if (typeof dataDir === "string") ensureDir(join(dataDir, "checkins"));
	}

	private checkinsDir(): string {
		const dataDir = typeof this.dataDir === "function" ? this.dataDir() : this.dataDir;
		const checkinsDir = join(dataDir, "checkins");
		ensureDir(checkinsDir);
		return checkinsDir;
	}

	private filePath(): string {
		return join(this.checkinsDir(), CHECKINS_FILE);
	}

	private occurrencesFilePath(): string {
		return join(this.checkinsDir(), OCCURRENCES_FILE);
	}

	protected async readCheckInRecords(): Promise<CheckInRecord[]> {
		const records = readJson<unknown>(this.filePath(), []);
		if (!Array.isArray(records)) return [];
		return records
			.map(parseCheckInRecord)
			.filter((record): record is CheckInRecord => record !== undefined);
	}

	protected async upsertCheckInRecord(record: CheckInRecord): Promise<void> {
		const records = (await this.readCheckInRecords())
			.filter((existing) => existing.date !== record.date);
		writeJson(this.filePath(), [...records, record]);
	}

	protected async listOccurrenceRecords(): Promise<OccurrenceRecord[]> {
		const records = readJson<unknown>(this.occurrencesFilePath(), []);
		if (!Array.isArray(records)) return [];
		return records.filter(isOccurrenceRecord);
	}

	protected async getOccurrenceRecord(occurrenceId: string): Promise<OccurrenceRecord | undefined> {
		return (await this.listOccurrenceRecords()).find((record) => record.occurrenceId === occurrenceId);
	}

	protected async upsertOccurrenceRecord(record: OccurrenceRecord): Promise<void> {
		const records = await this.listOccurrenceRecords();
		const index = records.findIndex((existing) => existing.occurrenceId === record.occurrenceId);
		if (index >= 0) records[index] = record;
		else records.push(record);
		writeJson(this.occurrencesFilePath(), records);
	}
}

/** PostgreSQL check-in ledger scoped to the ambient tenant. */
export class PgCheckInStore extends CheckInStore {
	constructor(
		private readonly pool: Pool,
		timezone: string = DEFAULT_SCHEDULER_TIMEZONE,
		jobStore: JobStore | (() => JobStore),
	) {
		super(timezone, jobStore);
	}

	private tenantId(): string {
		const tenant = getCurrentTenant();
		if (!tenant) throw new Error("PgCheckInStore requires a verified tenant context");
		return tenant.tenantId;
	}

	protected async readCheckInRecords(): Promise<CheckInRecord[]> {
		const result = await this.pool.query<{ date: string; checked_in_at: Date; completed_occurrence_ids: string[] }>(
			"SELECT date, checked_in_at, completed_occurrence_ids FROM tenant_checkins WHERE tenant_id = $1",
			[this.tenantId()],
		);
		return result.rows.map((row) => ({
			date: row.date,
			checkedInAt: row.checked_in_at instanceof Date ? row.checked_in_at.toISOString() : String(row.checked_in_at),
			completedOccurrenceIds: Array.isArray(row.completed_occurrence_ids) ? row.completed_occurrence_ids : [],
		}));
	}

	protected async upsertCheckInRecord(record: CheckInRecord): Promise<void> {
		await this.pool.query(
			`INSERT INTO tenant_checkins (tenant_id, date, checked_in_at, completed_occurrence_ids)
			 VALUES ($1, $2, $3, $4::jsonb)
			 ON CONFLICT (tenant_id, date) DO UPDATE
			 SET checked_in_at = $3, completed_occurrence_ids = $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId(), record.date, record.checkedInAt, JSON.stringify(record.completedOccurrenceIds)],
		);
	}

	protected async listOccurrenceRecords(): Promise<OccurrenceRecord[]> {
		const result = await this.pool.query<{ data: OccurrenceRecord }>(
			"SELECT data FROM tenant_checkin_occurrences WHERE tenant_id = $1",
			[this.tenantId()],
		);
		return result.rows.map((row) => row.data);
	}

	protected async getOccurrenceRecord(occurrenceId: string): Promise<OccurrenceRecord | undefined> {
		const result = await this.pool.query<{ data: OccurrenceRecord }>(
			"SELECT data FROM tenant_checkin_occurrences WHERE tenant_id = $1 AND occurrence_id = $2",
			[this.tenantId(), occurrenceId],
		);
		return result.rows[0]?.data;
	}

	protected async upsertOccurrenceRecord(record: OccurrenceRecord): Promise<void> {
		await this.pool.query(
			`INSERT INTO tenant_checkin_occurrences (tenant_id, occurrence_id, job_id, data)
			 VALUES ($1, $2, $3, $4::jsonb)
			 ON CONFLICT (tenant_id, occurrence_id) DO UPDATE
			 SET data = $4::jsonb, updated_at = CURRENT_TIMESTAMP`,
			[this.tenantId(), record.occurrenceId, record.jobId, JSON.stringify(record)],
		);
	}
}

function parseCheckInRecord(value: unknown): CheckInRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<CheckInRecord>;
	if (typeof record.date !== "string" || !DATE_KEY_RE.test(record.date)
		|| typeof record.checkedInAt !== "string") return undefined;
	return {
		date: record.date,
		checkedInAt: record.checkedInAt,
		// Records written before task-driven check-ins have no occurrence IDs.
		// They remain useful for historical streaks but cannot satisfy today's plan.
		completedOccurrenceIds: Array.isArray(record.completedOccurrenceIds)
			? record.completedOccurrenceIds.filter((id): id is string => typeof id === "string")
			: [],
	};
}

function isOccurrenceRecord(value: unknown): value is OccurrenceRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<OccurrenceRecord>;
	return typeof record.occurrenceId === "string"
		&& typeof record.jobId === "string"
		&& typeof record.scheduledAt === "string"
		&& (record.status === "success" || record.status === "error" || record.status === "skipped")
		&& typeof record.runId === "string"
		&& typeof record.finishedAt === "string"
		&& typeof record.date === "string"
		&& DATE_KEY_RE.test(record.date)
		&& typeof record.updatedAt === "string";
}

function areSameStrings(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const left = [...a].sort();
	const right = [...b].sort();
	return left.every((value, index) => value === right[index]);
}

function previousDateKey(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const previous = new Date(Date.UTC(year, month - 1, day - 1));
	return [previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate()]
		.map((part) => String(part).padStart(2, "0"))
		.join("-");
}

function calculateCurrentStreak(dates: string[], today: string): number {
	if (dates.length === 0) return 0;
	const start = dates[0] === today || dates[0] === previousDateKey(today) ? dates[0] : "";
	if (!start) return 0;

	let streak = 1;
	let expectedPrevious = previousDateKey(start);
	for (const date of dates.slice(1)) {
		if (date !== expectedPrevious) break;
		streak++;
		expectedPrevious = previousDateKey(date);
	}
	return streak;
}

function calculateLongestStreak(datesDescending: string[]): number {
	if (datesDescending.length === 0) return 0;
	const dates = [...datesDescending].reverse();
	let longest = 1;
	let current = 1;
	for (let i = 1; i < dates.length; i++) {
		if (dates[i - 1] === previousDateKey(dates[i])) {
			current++;
			longest = Math.max(longest, current);
		} else {
			current = 1;
		}
	}
	return longest;
}
