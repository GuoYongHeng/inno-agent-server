import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import {
	STORAGE_READ_BENCHMARKS,
	STORAGE_WRITE_BENCHMARKS,
	seedStorageBenchmark,
	seedStorageWriteBenchmark,
	TIMING_SCALE,
	type StorageBenchmarkDataset,
} from "@earendil-works/pi-durable/testing";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { migrateAuthDatabase } from "../auth/migration.js";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { TenantStore, type TenantContext } from "../tenants/store.js";
import { setRequestTenant } from "../tenants/http.js";
import type { IncomingMessage } from "node:http";
import { PgSessionCatalog } from "./pg-session-catalog.js";
import { PgDurableStorage } from "./pg-durable-storage.js";

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
let catalog: PgSessionCatalog;
let dir: string;
const tenant = { tenantId: "", userId: "user-a", role: "owner" } as TenantContext;
let reqA: IncomingMessage;

async function createUser(id: string) {
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, NOW(), NOW())`,
		[id, id, `${id}@example.com`]);
}

async function createSession(): Promise<string> {
	const id = randomUUID();
	await catalog.insert(reqA, {
		id, workspaceId: "w", name: "benchmark", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		messageCount: 0, preview: "", provider: "p", modelId: "m", origin: "web", archived: false,
	});
	return id;
}

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "durable-benchmark-secret-at-least-32-characters", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	await createUser("user-a");
	tenant.tenantId = (await store.ensurePersonalTenant("user-a")).tenantId;
	reqA = { headers: {} } as IncomingMessage;
	setRequestTenant(reqA, tenant, store);
	dir = mkdtempSync(join(tmpdir(), "inno-bench-"));
	catalog = new PgSessionCatalog(pool);
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	rmSync(dir, { recursive: true, force: true });
});

interface BenchmarkRow {
	readonly backend: string;
	readonly name: string;
	readonly medianMs: number;
	readonly meanMs: number;
}
const rows: BenchmarkRow[] = [];

function median(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(samples: number[]): number {
	return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

async function reportTable(): Promise<void> {
	const names = [...new Set(rows.map((row) => row.name))];
	const lines = ["backend | benchmark | median ms | mean ms", "--- | --- | ---: | ---:"];
	for (const name of names) {
		for (const row of rows.filter((r) => r.name === name)) {
			lines.push(`${row.backend} | ${row.name} | ${row.medianMs.toFixed(2)} | ${row.meanMs.toFixed(2)}`);
		}
	}
	console.log(`\n=== durable storage benchmark (TIMING_SCALE=${TIMING_SCALE.entryCount} entries) ===\n${lines.join("\n")}\n`);
}

const SAMPLES = 5;

async function benchReads(backend: string, storage: Storage, dataset: StorageBenchmarkDataset): Promise<void> {
	for (const benchmark of STORAGE_READ_BENCHMARKS) {
		await benchmark.run(storage, dataset); // warmup
		const samples: number[] = [];
		for (let sample = 0; sample < SAMPLES; sample++) {
			const started = performance.now();
			const value = await benchmark.run(storage, dataset);
			samples.push(performance.now() - started);
			expect(value).toBe(benchmark.expected(dataset));
		}
		rows.push({ backend, name: benchmark.name, medianMs: median(samples), meanMs: mean(samples) });
	}
}

async function benchWrites(backend: string, storage: Storage): Promise<void> {
	for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
		await benchmark.run(storage); // warmup
		const samples: number[] = [];
		for (let sample = 0; sample < SAMPLES; sample++) {
			const started = performance.now();
			const value = await benchmark.run(storage);
			samples.push(performance.now() - started);
			expect(value).toBe(benchmark.expected);
		}
		rows.push({ backend, name: benchmark.name, medianMs: median(samples), meanMs: mean(samples) });
	}
}

async function withSqliteStorage(use: (storage: Storage) => Promise<void>): Promise<void> {
	const storage = await openNodeSqliteStorage(join(dir, `bench-${randomUUID()}.sqlite`));
	try {
		await use(storage);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

async function withPgStorage(use: (storage: Storage) => Promise<void>): Promise<void> {
	const sessionId = await createSession();
	const storage = await PgDurableStorage.open(pool, sessionId);
	try {
		await use(storage);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

it("compares read benchmarks between sqlite and postgres storage", async () => {
	await withSqliteStorage(async (storage) => {
		const dataset = await seedStorageBenchmark(storage, TIMING_SCALE);
		await benchReads("sqlite", storage, dataset);
	});
	await withPgStorage(async (storage) => {
		const dataset = await seedStorageBenchmark(storage, TIMING_SCALE);
		await benchReads("postgres", storage, dataset);
	});
}, 300_000);

it("compares write benchmarks between sqlite and postgres storage", async () => {
	await withSqliteStorage(async (storage) => {
		await seedStorageWriteBenchmark(storage);
		await benchWrites("sqlite", storage);
	});
	await withPgStorage(async (storage) => {
		await seedStorageWriteBenchmark(storage);
		await benchWrites("postgres", storage);
	});
	await reportTable();
}, 300_000);
