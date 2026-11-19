import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { incCounter, setGauge } from "../utils/metrics.js";
import { findOrphanedSessionData, removeOrphanedSessionData, type OrphanedSessionData } from "./durable-orphans.js";

export interface DurableRootAudit {
	/** "local" for `<dataDir>/durable`, otherwise the tenant ID. */
	owner: string;
	root: string;
	orphans: OrphanedSessionData[];
	/** Bytes under the durable root (catalog, storage, questions, permissions). */
	diskBytes: number;
	/** Set when the root could not be audited (e.g. unreadable catalog). */
	error?: string;
	removed?: string[];
}

/** Durable roots under a data dir: the local one plus one per tenant. */
export function listDurableRoots(dataDir: string): Array<{ owner: string; root: string }> {
	const roots: Array<{ owner: string; root: string }> = [];
	const local = join(dataDir, "durable");
	if (existsSync(local)) roots.push({ owner: "local", root: local });
	const tenants = join(dataDir, "tenants");
	if (existsSync(tenants)) {
		for (const entry of readdirSync(tenants, { withFileTypes: true })) {
			const root = join(tenants, entry.name, "durable");
			if (entry.isDirectory() && existsSync(root)) roots.push({ owner: entry.name, root });
		}
	}
	return roots;
}

/** Total size of regular files below `path`; symlinks are counted, never followed. */
export function directoryBytes(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += directoryBytes(child);
		else if (entry.isFile() || entry.isSymbolicLink()) {
			try { total += lstatSync(child).size; } catch { /* removed while scanning */ }
		}
	}
	return total;
}

/**
 * Audit every durable root for orphaned session data and measure disk use.
 * Read-only unless `repair` is set. Updates the orphan/disk gauges.
 */
export async function auditDurableData(
	dataDir: string,
	options: {
		repair?: boolean;
		/** Catalog contents for roots whose catalog is not `sessions.json` (the PostgreSQL
		 * catalog of tenant roots). Return undefined to use the file. */
		knownIds?: (owner: string) => Promise<Set<string> | undefined>;
	} = {},
): Promise<DurableRootAudit[]> {
	const results: DurableRootAudit[] = [];
	for (const { owner, root } of listDurableRoots(dataDir)) {
		const result: DurableRootAudit = { owner, root, orphans: [], diskBytes: 0 };
		try {
			const known = owner === "local" ? undefined : await options.knownIds?.(owner);
			result.orphans = findOrphanedSessionData(root, known);
			if (options.repair && result.orphans.length) result.removed = removeOrphanedSessionData(root, known);
		} catch (error) {
			result.error = error instanceof Error ? error.message : String(error);
		}
		try { result.diskBytes = directoryBytes(root); } catch { /* root vanished */ }
		results.push(result);
	}
	const orphanCount = results.reduce((sum, r) => sum + (r.removed ? 0 : r.orphans.length), 0);
	setGauge("inno_durable_orphan_sessions", orphanCount);
	setGauge("inno_durable_disk_bytes", results.reduce((sum, r) => sum + r.diskBytes, 0));
	setGauge("inno_durable_tenants", results.length);
	if (results.some((r) => r.error)) incCounter("inno_durable_audit_errors_total");
	return results;
}
