/**
 * Minimal in-process metrics (no dependency). Counters, gauges and duration
 * summaries (count/sum/max) rendered as Prometheus text. Process-local: a
 * multi-worker deployment scrapes each worker.
 */
const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const summaries = new Map<string, { count: number; sum: number; max: number }>();

export function incCounter(name: string, by = 1): void {
	counters.set(name, (counters.get(name) ?? 0) + by);
}

export function setGauge(name: string, value: number): void {
	gauges.set(name, value);
}

/** Record one duration (milliseconds). */
export function observeMs(name: string, ms: number): void {
	const current = summaries.get(name) ?? { count: 0, sum: 0, max: 0 };
	current.count += 1;
	current.sum += ms;
	current.max = Math.max(current.max, ms);
	summaries.set(name, current);
}

/** Time a synchronous section. */
export function timed<T>(name: string, operation: () => T): T {
	const start = performance.now();
	try {
		return operation();
	} finally {
		observeMs(name, performance.now() - start);
	}
}

/** Time an async operation. */
export async function timedAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		return await operation();
	} finally {
		observeMs(name, performance.now() - start);
	}
}

export function metricsSnapshot() {
	return {
		counters: Object.fromEntries(counters),
		gauges: Object.fromEntries(gauges),
		summaries: Object.fromEntries(summaries),
	};
}

export function renderPrometheus(): string {
	const lines: string[] = [];
	for (const [name, value] of counters) lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
	for (const [name, value] of gauges) lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
	for (const [name, s] of summaries) {
		lines.push(`# TYPE ${name} summary`, `${name}_count ${s.count}`, `${name}_sum ${s.sum.toFixed(3)}`, `${name}_max ${s.max.toFixed(3)}`);
	}
	return `${lines.join("\n")}\n`;
}

export function resetMetricsForTests(): void {
	counters.clear();
	gauges.clear();
	summaries.clear();
}
