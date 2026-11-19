import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const held = new Map<string, number>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const STALE_MS = 15_000;
const WAIT_LIMIT_MS = 10_000;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function lockIsStale(dir: string): boolean {
	try {
		const owner = Number.parseInt(readFileSync(join(dir, "owner"), "utf-8"), 10);
		if (Number.isFinite(owner) && owner > 0) return !pidAlive(owner);
	} catch { /* owner file not written yet: fall through to the age check */ }
	try {
		return Date.now() - statSync(dir).mtimeMs > STALE_MS;
	} catch {
		return false;
	}
}

/**
 * Run a synchronous critical section under a cross-process lock (an atomically
 * created directory next to the protected file). Re-entrant within a process.
 * Locks left by a dead process are broken. Intended for short read-modify-write
 * sections such as the session catalog; it blocks the event loop while waiting.
 */
export function withFileLock<T>(lockPath: string, operation: () => T): T {
	const depth = held.get(lockPath) ?? 0;
	if (depth > 0) {
		held.set(lockPath, depth + 1);
		try { return operation(); } finally { held.set(lockPath, depth); }
	}
	mkdirSync(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + WAIT_LIMIT_MS;
	for (;;) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (lockIsStale(lockPath)) {
				rmSync(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
			Atomics.wait(sleeper, 0, 0, 5);
		}
	}
	try {
		writeFileSync(join(lockPath, "owner"), String(process.pid));
		held.set(lockPath, 1);
		return operation();
	} finally {
		held.delete(lockPath);
		rmSync(lockPath, { recursive: true, force: true });
	}
}
