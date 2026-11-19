import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditDurableData, directoryBytes } from "./durable-audit.js";
import { incCounter, metricsSnapshot, observeMs, renderPrometheus, resetMetricsForTests, timed } from "../utils/metrics.js";
import { withFileLock } from "../storage/file-lock.js";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "inno-audit-")); dirs.push(d); return d; };
beforeEach(() => resetMetricsForTests());
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function seed(root: string, catalogIds: string[], dataIds: string[]) {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "sessions.json"), JSON.stringify(catalogIds.map((id) => ({ id }))));
	for (const id of dataIds) {
		mkdirSync(join(root, "storage", id), { recursive: true });
		writeFileSync(join(root, "storage", id, "session.sqlite"), "x".repeat(100));
	}
}

describe("durable data audit", () => {
	it("audits the local root and every tenant root, measuring disk and gauges", () => {
		const data = dir();
		seed(join(data, "durable"), ["durable-a"], ["durable-a", "durable-lost"]);
		seed(join(data, "tenants", "t1", "durable"), ["durable-b"], ["durable-b"]);
		seed(join(data, "tenants", "t2", "durable"), [], ["durable-c"]);

		const audits = auditDurableData(data);
		expect(audits.map((a) => [a.owner, a.orphans.map((o) => o.sessionId)])).toEqual([
			["local", ["durable-lost"]],
			["t1", []],
			["t2", ["durable-c"]],
		]);
		expect(audits.every((a) => a.diskBytes > 0)).toBe(true);
		const { gauges } = metricsSnapshot();
		expect(gauges.inno_durable_orphan_sessions).toBe(2);
		expect(gauges.inno_durable_tenants).toBe(3);
		expect(gauges.inno_durable_disk_bytes).toBe(audits.reduce((n, a) => n + a.diskBytes, 0));
	});

	it("repairs only when asked and reports an unreadable catalog instead of deleting", () => {
		const data = dir();
		seed(join(data, "durable"), [], ["durable-x"]);
		seed(join(data, "tenants", "bad", "durable"), [], ["durable-y"]);
		writeFileSync(join(data, "tenants", "bad", "durable", "sessions.json"), "{oops");

		expect(auditDurableData(data).find((a) => a.owner === "local")!.orphans).toHaveLength(1);
		const repaired = auditDurableData(data, { repair: true });
		expect(repaired.find((a) => a.owner === "local")!.removed).toEqual(["durable-x"]);
		const bad = repaired.find((a) => a.owner === "bad")!;
		expect(bad.error).toMatch(/refusing to classify/);
		expect(auditDurableData(data).find((a) => a.owner === "local")!.orphans).toEqual([]);
		expect(metricsSnapshot().counters.inno_durable_audit_errors_total).toBeGreaterThan(0);
	});

	it("directoryBytes counts regular files recursively", () => {
		const root = dir();
		mkdirSync(join(root, "a", "b"), { recursive: true });
		writeFileSync(join(root, "a", "b", "f"), "12345");
		writeFileSync(join(root, "g"), "123");
		expect(directoryBytes(root)).toBe(8);
	});
});

describe("metrics", () => {
	it("renders counters, gauges and duration summaries as Prometheus text", () => {
		incCounter("x_total", 2);
		observeMs("y_ms", 4);
		observeMs("y_ms", 10);
		timed("z_ms", () => 1);
		const text = renderPrometheus();
		expect(text).toContain("x_total 2");
		expect(text).toContain("y_ms_count 2");
		expect(text).toContain("y_ms_sum 14.000");
		expect(text).toContain("y_ms_max 10.000");
		expect(text).toContain("z_ms_count 1");
	});

	it("file locks report wait time", () => {
		withFileLock(join(dir(), "l.lock"), () => 1);
		expect(metricsSnapshot().summaries.inno_file_lock_wait_ms?.count).toBe(1);
	});
});
