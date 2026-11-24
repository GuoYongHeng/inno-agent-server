import { getCurrentTenant } from "../tenants/current.js";
import { JobStore, type ScheduledJobCreateInput } from "./job-store.js";
import type { JobRunRecord, ScheduledJob } from "./types.js";

/**
 * Test double for the ambient-tenant dispatch the production PgJobStore gets
 * from `tenant_id` scoping: each tenant's calls route to its own
 * FileJobStore, and calls outside a tenant context hit the fallback store.
 */
export class AmbientJobStore extends JobStore {
	constructor(
		private readonly byTenant: Map<string, JobStore>,
		private readonly fallback: JobStore,
	) {
		super(fallback.defaultTimezone);
	}

	private inner(): JobStore {
		return this.byTenant.get(getCurrentTenant()?.tenantId ?? "") ?? this.fallback;
	}

	list(): Promise<ScheduledJob[]> { return this.inner().list(); }
	normalizePersistedJobs(): Promise<ScheduledJob[]> { return this.inner().normalizePersistedJobs(); }
	get(id: string): Promise<ScheduledJob | undefined> { return this.inner().get(id); }
	create(input: ScheduledJobCreateInput): Promise<ScheduledJob> { return this.inner().create(input); }
	update(id: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob | undefined> { return this.inner().update(id, patch); }
	mutate(id: string, mutator: (current: ScheduledJob) => Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		return this.inner().mutate(id, mutator);
	}
	delete(id: string): Promise<boolean> { return this.inner().delete(id); }
	appendRun(record: JobRunRecord): Promise<void> { return this.inner().appendRun(record); }
	listRuns(jobId?: string, limit?: number): Promise<JobRunRecord[]> { return this.inner().listRuns(jobId, limit); }
}
