import { statSync } from "node:fs";
import { readJsonl, appendJsonl, writeJsonl } from "../storage/file-store.js";

export interface DedupeEntry {
	key: string;
	seenAt: string;
	expiresAt: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * dedupe.jsonl is compacted (rewritten with live entries only) once it
 * exceeds this size. Rotation is unsafe here — it would drop live entries
 * and re-admit duplicates — so growth is bounded by compaction instead.
 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface DedupePersistence {
	load(): Promise<DedupeEntry[]>;
	save(entries: DedupeEntry[]): Promise<void>;
}

export class DedupeStore {
	private seen = new Map<string, number>();
	private persistChain: Promise<unknown> = Promise.resolve();

	constructor(
		private source: string | DedupePersistence,
		private ttlMs = DEFAULT_TTL_MS,
		private maxBytes = DEFAULT_MAX_BYTES,
	) {
		if (typeof source !== "string") return;
		const now = Date.now();
		let total = 0;
		for (const entry of readJsonl<DedupeEntry>(source)) {
			total++;
			const expires = new Date(entry.expiresAt).getTime();
			if (expires > now) {
				this.seen.set(entry.key, expires);
			}
		}
		// Boot-time compaction: if the file held expired or duplicate-key lines,
		// rewrite it with live entries only so it doesn't grow across restarts.
		if (total > this.seen.size) this.compact();
	}

	/** Hydrate persisted entries (persistent backends only; call once). */
	async hydrate(): Promise<void> {
		if (typeof this.source === "string") return;
		const now = Date.now();
		for (const entry of (await this.source.load()) ?? []) {
			const expires = new Date(entry.expiresAt).getTime();
			if (expires > now) this.seen.set(entry.key, expires);
		}
	}

	isDuplicate(channel: string, messageId: string): boolean {
		const key = `${channel}:${messageId}`;
		const expires = this.seen.get(key);
		if (expires && expires > Date.now()) return true;
		return false;
	}

	mark(channel: string, messageId: string): void {
		const key = `${channel}:${messageId}`;
		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.ttlMs);
		this.seen.set(key, expiresAt.getTime());
		if (typeof this.source === "string") {
			appendJsonl(this.source, {
				key,
				seenAt: now.toISOString(),
				expiresAt: expiresAt.toISOString(),
			});
			// Long-running processes never reboot, so bound the file here too.
			if (statSync(this.source).size > this.maxBytes) this.compact();
		} else {
			this.schedulePersist();
		}
	}

	cleanup(): void {
		const now = Date.now();
		for (const [key, expires] of this.seen) {
			if (expires <= now) this.seen.delete(key);
		}
	}

	private liveEntries(): DedupeEntry[] {
		const now = Date.now();
		const live: DedupeEntry[] = [];
		for (const [key, expires] of this.seen) {
			if (expires > now) {
				live.push({ key, seenAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString() });
			}
		}
		return live;
	}

	private schedulePersist(): void {
		const source = this.source;
		if (typeof source === "string") return;
		const entries = this.liveEntries();
		this.persistChain = this.persistChain.then(() => source.save(entries));
	}

	/** Rewrite the log with live entries only (atomic via writeJsonl). */
	private compact(): void {
		const now = Date.now();
		const live: DedupeEntry[] = [];
		for (const [key, expires] of this.seen) {
			if (expires <= now) {
				this.seen.delete(key);
				continue;
			}
			live.push({
				key,
				seenAt: new Date(now).toISOString(),
				expiresAt: new Date(expires).toISOString(),
			});
		}
		if (typeof this.source === "string") writeJsonl(this.source, live);
		else this.schedulePersist();
	}
}
