import { appendJsonl, readJsonlTail } from "../storage/file-store.js";

export interface ChannelRun {
	runId: string;
	channel: string;
	messageId: string;
	status: "success" | "error";
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	error?: string;
}

/** The run log is rolled to a timestamped archive once it exceeds this size. */
const RUN_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** list() only shows recent runs, so it reads just the tail of the file. */
const RUN_LOG_TAIL_BYTES = 1024 * 1024;

let runCounter = 0;

export function generateRunId(): string {
	return `chrun_${Date.now()}_${++runCounter}`;
}

/** Persistent backends keep at most this many recent runs in the ledger. */
const RUN_LOG_MAX_ENTRIES = 1000;

export interface ChannelRunLogPersistence {
	load(): Promise<ChannelRun[]>;
	save(runs: ChannelRun[]): Promise<void>;
}

export class ChannelRunLog {
	private entries: ChannelRun[] = [];
	private persistChain: Promise<unknown> = Promise.resolve();

	constructor(private source: string | ChannelRunLogPersistence) {}

	/** Hydrate persisted runs (persistent backends only; call once). */
	async hydrate(): Promise<void> {
		if (typeof this.source === "string") return;
		this.entries = (await this.source.load()) ?? [];
	}

	append(run: ChannelRun): void {
		if (typeof this.source === "string") {
			appendJsonl(this.source, run, { maxBytes: RUN_LOG_MAX_BYTES });
			return;
		}
		this.entries.push(run);
		if (this.entries.length > RUN_LOG_MAX_ENTRIES) this.entries = this.entries.slice(-RUN_LOG_MAX_ENTRIES);
		const entries = [...this.entries];
		const source = this.source;
		this.persistChain = this.persistChain.then(() => source.save(entries));
	}

	list(limit = 100): ChannelRun[] {
		if (typeof this.source === "string") {
			const all = readJsonlTail<ChannelRun>(this.source, RUN_LOG_TAIL_BYTES);
			return all.slice(-limit);
		}
		return this.entries.slice(-limit);
	}
}
