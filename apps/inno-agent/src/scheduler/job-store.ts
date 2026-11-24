import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendJsonl, readJson, readJsonlTail, writeJson, ensureDir } from "../storage/file-store.js";
import type { JobRunRecord, ScheduledJob } from "./types.js";
import { computeNextRunAt, DEFAULT_SCHEDULER_TIMEZONE } from "./cron-utils.js";
import { getCurrentTenant } from "../tenants/current.js";

const JOBS_FILE = "jobs.json";
const RUNS_FILE = "runs.jsonl";

/** runs.jsonl is rolled to a timestamped archive once it exceeds this size. */
const RUNS_MAX_BYTES = 10 * 1024 * 1024;
/** listRuns only needs recent history, so it reads just the tail of the file. */
const LIST_RUNS_TAIL_BYTES = 1024 * 1024;

export type ScheduledJobCreateInput =
	Omit<ScheduledJob, "id" | "createdAt" | "updatedAt" | "runCount" | "failureCount" | "lastStatus" | "lastError">
	& Partial<Pick<ScheduledJob, "runCount" | "failureCount" | "lastStatus" | "lastError">>;

export type JobStatusSummary = {
	total: number;
	enabled: number;
	disabled: number;
	running: number;
	failed: number;
	nextRunAt?: string;
};

/**
 * Tenant job ledger (`jobs.json` + `runs.jsonl` → `tenant_jobs` +
 * `tenant_job_runs`). All methods are async; the shared helpers preserve the
 * file implementation's merge/nextRunAt semantics for both backends.
 */
export abstract class JobStore {
	readonly defaultTimezone: string;

	constructor(defaultTimezone: string = DEFAULT_SCHEDULER_TIMEZONE) {
		this.defaultTimezone = defaultTimezone;
	}

	abstract list(): Promise<ScheduledJob[]>;
	abstract normalizePersistedJobs(): Promise<ScheduledJob[]>;
	abstract get(id: string): Promise<ScheduledJob | undefined>;
	abstract create(input: ScheduledJobCreateInput): Promise<ScheduledJob>;
	abstract update(id: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob | undefined>;

	/**
	 * Serialized read-modify-write for one job. The mutator receives the job's
	 * *fresh* state (re-read under the implementation's serialization), so
	 * increments like `runCount + 1` are computed from the latest persisted
	 * values instead of a stale snapshot.
	 */
	abstract mutate(id: string, mutator: (current: ScheduledJob) => Partial<ScheduledJob>): Promise<ScheduledJob | undefined>;

	abstract delete(id: string): Promise<boolean>;
	abstract appendRun(record: JobRunRecord): Promise<void>;
	abstract listRuns(jobId?: string, limit?: number): Promise<JobRunRecord[]>;

	async getStatus(): Promise<JobStatusSummary> {
		const jobs = await this.list();
		const enabledJobs = jobs.filter((job) => job.enabled);
		const nextRunAt = enabledJobs
			.map((job) => job.nextRunAt)
			.filter((value): value is string => Boolean(value))
			.sort()[0];
		return {
			total: jobs.length,
			enabled: enabledJobs.length,
			disabled: jobs.length - enabledJobs.length,
			running: jobs.filter((job) => job.lastStatus === "running").length,
			failed: jobs.filter((job) => job.lastStatus === "error").length,
			nextRunAt,
		};
	}

	protected buildJob(input: ScheduledJobCreateInput): ScheduledJob {
		const now = new Date().toISOString();
		const timezone = input.timezone || this.defaultTimezone;
		return {
			...input,
			id: `job_${randomUUID().slice(0, 8)}`,
			timezone,
			runCount: input.runCount ?? 0,
			failureCount: input.failureCount ?? 0,
			nextRunAt: input.nextRunAt ?? computeNextRunAt(input.cron, timezone),
			createdAt: now,
			updatedAt: now,
		};
	}

	protected normalizeJob(job: Partial<ScheduledJob>): ScheduledJob {
		const now = new Date().toISOString();
		const timezone = job.timezone || this.defaultTimezone;
		const enabled = job.enabled ?? true;
		return {
			id: job.id ?? `job_${randomUUID().slice(0, 8)}`,
			name: job.name ?? "Untitled job",
			cron: job.cron ?? "0 9 * * *",
			timezone,
			enabled,
			channel: job.channel,
			target: job.target,
			taskType: job.taskType ?? "custom_prompt",
			runtime: job.runtime,
			prompt: job.prompt ?? "",
			lastRunAt: job.lastRunAt,
			nextRunAt: enabled ? (job.nextRunAt ?? computeNextRunAt(job.cron ?? "0 9 * * *", timezone)) : undefined,
			lastStatus: job.lastStatus,
			lastError: job.lastError,
			runCount: job.runCount ?? 0,
			failureCount: job.failureCount ?? 0,
			createdAt: job.createdAt ?? now,
			updatedAt: job.updatedAt ?? now,
		};
	}

	/** `update()` merge: recompute the next slot when timing fields change. */
	protected applyJobPatch(current: ScheduledJob, patch: Partial<ScheduledJob>): ScheduledJob {
		const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
		if (patch.cron || patch.timezone || patch.lastRunAt || patch.enabled !== undefined) {
			merged.nextRunAt = merged.enabled ? computeNextRunAt(merged.cron, merged.timezone) : undefined;
		}
		return merged;
	}

	/** `mutate()` merge: also honours an explicitly provided next slot. */
	protected applyJobMutation(current: ScheduledJob, patch: Partial<ScheduledJob>): ScheduledJob {
		const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
		if (patch.enabled === false) {
			merged.nextRunAt = undefined;
		} else if ("nextRunAt" in patch) {
			merged.nextRunAt = patch.nextRunAt;
		} else if (patch.cron || patch.timezone || patch.lastRunAt || patch.enabled !== undefined) {
			merged.nextRunAt = merged.enabled ? computeNextRunAt(merged.cron, merged.timezone) : undefined;
		}
		return merged;
	}
}

/** File-backed JobStore for unit tests; production uses PgJobStore. */
export class FileJobStore extends JobStore {
	private filePath: string;
	private runsFilePath: string;
	/**
	 * Per-job serialization chains for `mutate`: each mutation re-reads the
	 * current state inside the chain, so concurrent runs (cron + manual + the
	 * agent's run_scheduled_job tool) can't lose counter increments by writing
	 * back values computed from a stale snapshot.
	 */
	private mutationChains = new Map<string, Promise<void>>();

	constructor(jobsDir: string, defaultTimezone: string = DEFAULT_SCHEDULER_TIMEZONE) {
		super(defaultTimezone);
		ensureDir(jobsDir);
		this.filePath = join(jobsDir, JOBS_FILE);
		this.runsFilePath = join(jobsDir, RUNS_FILE);
	}

	async list(): Promise<ScheduledJob[]> {
		return readJson<Partial<ScheduledJob>[]>(this.filePath, []).map((job) => this.normalizeJob(job));
	}

	async normalizePersistedJobs(): Promise<ScheduledJob[]> {
		const jobs = await this.list();
		writeJson(this.filePath, jobs);
		return jobs;
	}

	async get(id: string): Promise<ScheduledJob | undefined> {
		return (await this.list()).find((j) => j.id === id);
	}

	async create(input: ScheduledJobCreateInput): Promise<ScheduledJob> {
		const jobs = await this.list();
		const job = this.buildJob(input);
		jobs.push(job);
		writeJson(this.filePath, jobs);
		return job;
	}

	async update(id: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		const jobs = await this.list();
		const idx = jobs.findIndex((j) => j.id === id);
		if (idx < 0) return undefined;
		jobs[idx] = this.applyJobPatch(jobs[idx]!, patch);
		writeJson(this.filePath, jobs);
		return jobs[idx];
	}

	async mutate(id: string, mutator: (current: ScheduledJob) => Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		const prev = this.mutationChains.get(id) ?? Promise.resolve();
		const next = prev.then(async (): Promise<ScheduledJob | undefined> => {
			const jobs = await this.list();
			const idx = jobs.findIndex((j) => j.id === id);
			if (idx < 0) return undefined;
			jobs[idx] = this.applyJobMutation(jobs[idx]!, mutator(jobs[idx]!));
			writeJson(this.filePath, jobs);
			return jobs[idx];
		});
		// Keep the chain alive even if this mutation rejects; swallow in the
		// stored link so later mutations still run. The caller gets the real
		// promise (with its rejection) as the return value.
		this.mutationChains.set(id, next.then(() => undefined, () => undefined));
		return next;
	}

	async delete(id: string): Promise<boolean> {
		const jobs = await this.list();
		const filtered = jobs.filter((j) => j.id !== id);
		if (filtered.length === jobs.length) return false;
		writeJson(this.filePath, filtered);
		return true;
	}

	async appendRun(record: JobRunRecord): Promise<void> {
		appendJsonl(this.runsFilePath, record, { maxBytes: RUNS_MAX_BYTES });
	}

	async listRuns(jobId?: string, limit = 50): Promise<JobRunRecord[]> {
		const runs = readJsonlTail<JobRunRecord>(this.runsFilePath, LIST_RUNS_TAIL_BYTES);
		const filtered = jobId ? runs.filter((run) => run.jobId === jobId) : runs;
		return filtered.slice(-limit).reverse();
	}
}

/**
 * PostgreSQL job ledger scoped to the ambient tenant (`tenant_jobs` +
 * `tenant_job_runs`). Callers run inside a verified tenant context; read-
 * modify-writes take a row lock so concurrent manual/cron/tool executions
 * serialise at the database rather than on a process-local promise chain.
 */
export class PgJobStore extends JobStore {
	constructor(
		private readonly pool: Pool,
		defaultTimezone: string = DEFAULT_SCHEDULER_TIMEZONE,
	) {
		super(defaultTimezone);
	}

	private tenantId(): string {
		const tenant = getCurrentTenant();
		if (!tenant) throw new Error("PgJobStore requires a verified tenant context");
		return tenant.tenantId;
	}

	async list(): Promise<ScheduledJob[]> {
		const result = await this.pool.query<{ data: Partial<ScheduledJob> }>(
			"SELECT data FROM tenant_jobs WHERE tenant_id = $1 ORDER BY created_at, job_id",
			[this.tenantId()],
		);
		return result.rows.map((row) => this.normalizeJob(row.data));
	}

	/**
	 * Normalize every tenant's rows (runs outside tenant context at startup).
	 * Rows are already normalized on write, so this only rewrites drift.
	 */
	async normalizePersistedJobs(): Promise<ScheduledJob[]> {
		const result = await this.pool.query<{ tenant_id: string; job_id: string; data: Partial<ScheduledJob> }>(
			"SELECT tenant_id, job_id, data FROM tenant_jobs",
		);
		const jobs: ScheduledJob[] = [];
		for (const row of result.rows) {
			const job = this.normalizeJob(row.data);
			jobs.push(job);
			if (JSON.stringify(job) !== JSON.stringify(row.data)) {
				await this.pool.query(
					"UPDATE tenant_jobs SET data = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND job_id = $2",
					[row.tenant_id, row.job_id, JSON.stringify(job)],
				);
			}
		}
		return jobs;
	}

	async get(id: string): Promise<ScheduledJob | undefined> {
		const result = await this.pool.query<{ data: Partial<ScheduledJob> }>(
			"SELECT data FROM tenant_jobs WHERE tenant_id = $1 AND job_id = $2",
			[this.tenantId(), id],
		);
		return result.rows[0] ? this.normalizeJob(result.rows[0].data) : undefined;
	}

	async create(input: ScheduledJobCreateInput): Promise<ScheduledJob> {
		const job = this.buildJob(input);
		await this.pool.query(
			"INSERT INTO tenant_jobs (tenant_id, job_id, data) VALUES ($1, $2, $3::jsonb)",
			[this.tenantId(), job.id, JSON.stringify(job)],
		);
		return job;
	}

	async update(id: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		return this.applyLocked(id, (current) => this.applyJobPatch(current, patch));
	}

	async mutate(id: string, mutator: (current: ScheduledJob) => Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		return this.applyLocked(id, (current) => this.applyJobMutation(current, mutator(current)));
	}

	private async applyLocked(
		id: string,
		apply: (current: ScheduledJob) => ScheduledJob,
	): Promise<ScheduledJob | undefined> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await client.query<{ data: Partial<ScheduledJob> }>(
				"SELECT data FROM tenant_jobs WHERE tenant_id = $1 AND job_id = $2 FOR UPDATE",
				[this.tenantId(), id],
			);
			const current = result.rows[0];
			if (!current) {
				await client.query("ROLLBACK");
				return undefined;
			}
			const merged = apply(this.normalizeJob(current.data));
			await client.query(
				"UPDATE tenant_jobs SET data = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND job_id = $2",
				[this.tenantId(), id, JSON.stringify(merged)],
			);
			await client.query("COMMIT");
			return merged;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async delete(id: string): Promise<boolean> {
		const result = await this.pool.query(
			"DELETE FROM tenant_jobs WHERE tenant_id = $1 AND job_id = $2",
			[this.tenantId(), id],
		);
		return (result.rowCount ?? 0) > 0;
	}

	async appendRun(record: JobRunRecord): Promise<void> {
		await this.pool.query(
			`INSERT INTO tenant_job_runs (tenant_id, run_id, job_id, data) VALUES ($1, $2, $3, $4::jsonb)
			 ON CONFLICT (tenant_id, run_id) DO UPDATE SET data = $4::jsonb`,
			[this.tenantId(), record.id, record.jobId ?? null, JSON.stringify(record)],
		);
	}

	async listRuns(jobId?: string, limit = 50): Promise<JobRunRecord[]> {
		const result = jobId
			? await this.pool.query<{ data: JobRunRecord }>(
				"SELECT data FROM tenant_job_runs WHERE tenant_id = $1 AND job_id = $2 ORDER BY recorded_at DESC, run_id DESC LIMIT $3",
				[this.tenantId(), jobId, limit],
			)
			: await this.pool.query<{ data: JobRunRecord }>(
				"SELECT data FROM tenant_job_runs WHERE tenant_id = $1 ORDER BY recorded_at DESC, run_id DESC LIMIT $2",
				[this.tenantId(), limit],
			);
		return result.rows.map((row) => row.data);
	}
}
