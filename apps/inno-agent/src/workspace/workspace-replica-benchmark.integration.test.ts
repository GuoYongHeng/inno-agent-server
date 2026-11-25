import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readAuthRuntimeConfig } from "../auth/config.js";
import { migrateAuthDatabase } from "../auth/migration.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../db/test-postgres.js";
import { FsObjectStore } from "../object-store/fs-object-store.js";
import { TenantStore, type TenantContext } from "../tenants/store.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { WorkspaceReplica } from "./workspace-replica.js";

/**
 * Baseline for T5.3: how `replica.pull` scales with workspace file count —
 * a cold pull into an empty dir, a no-change incremental pull, and a pull
 * where ten percent of files changed. Real PostgreSQL manifest + fs object
 * store. Prints a table; the numbers decide whether pull needs to become
 * on-demand.
 */

let postgres: TemporaryPostgres;
let pool: Pool;
let store: TenantStore;
let context: TenantContext;
let objectsDir: string;
let replica: WorkspaceReplica;
const dirs: string[] = [];

beforeAll(async () => {
	postgres = await startTemporaryPostgres();
	await migrateAuthDatabase(readAuthRuntimeConfig({
		INNO_AUTH_MODE: "better-auth", DATABASE_URL: postgres.databaseUrl,
		BETTER_AUTH_SECRET: "replica-benchmark-secret-at-least-32chars", BETTER_AUTH_URL: "http://127.0.0.1",
	}));
	pool = new Pool({ connectionString: postgres.databaseUrl });
	store = new TenantStore(pool);
	await pool.query(
		`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ('bench-user', 'Bench', 'bench@example.com', false, NOW(), NOW())`,
	);
	context = await store.ensurePersonalTenant("bench-user");
	objectsDir = mkdtempSync(join(tmpdir(), "inno-replica-bench-objects-"));
	dirs.push(objectsDir);
	const workspaceDir = mkdtempSync(join(tmpdir(), "inno-replica-bench-ws-"));
	const stateDir = mkdtempSync(join(tmpdir(), "inno-replica-bench-state-"));
	dirs.push(workspaceDir, stateDir);
	replica = new WorkspaceReplica(new FsObjectStore(objectsDir), store, new WorkspaceRegistry(workspaceDir));
});

afterAll(async () => {
	await pool?.end();
	await postgres?.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SIZES = [100, 500, 2000];
const FILE_BYTES = 4 * 1024;

function writeWorkspaceFile(dir: string, relPath: string, fill: number): void {
	const target = join(dir, relPath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, Buffer.alloc(FILE_BYTES, fill));
}

it("measures replica.pull scaling with file count", async () => {
	const rows: Array<{ files: number; coldMs: number; idleMs: number; changedMs: number; changedDownloaded: number }> = [];
	for (const fileCount of SIZES) {
		const workspaceId = `bench-${fileCount}`;
		const seedDir = mkdtempSync(join(tmpdir(), `inno-replica-seed-${fileCount}-`));
		const coldDir = mkdtempSync(join(tmpdir(), `inno-replica-cold-${fileCount}-`));
		dirs.push(seedDir, coldDir);
		for (let i = 0; i < fileCount; i++) {
			writeWorkspaceFile(seedDir, `dir-${i % 25}/file-${i}.txt`, i % 251);
		}
		await replica.push(context, workspaceId, seedDir);

		// Cold pull into an empty directory.
		let started = performance.now();
		const cold = await replica.pull(context, workspaceId, coldDir);
		const coldMs = performance.now() - started;
		expect(cold.downloaded).toBe(fileCount);

		// Incremental pull with nothing changed.
		started = performance.now();
		await replica.pull(context, workspaceId, coldDir);
		const idleMs = performance.now() - started;

		// Change 10% upstream, then measure the incremental pull.
		for (let i = 0; i < fileCount / 10; i++) {
			writeWorkspaceFile(seedDir, `dir-${i % 25}/file-${i}.txt`, 7);
		}
		await replica.push(context, workspaceId, seedDir);
		started = performance.now();
		const changed = await replica.pull(context, workspaceId, coldDir);
		const changedMs = performance.now() - started;

		rows.push({ files: fileCount, coldMs, idleMs, changedMs, changedDownloaded: changed.downloaded });
	}
	const lines = ["files | cold pull ms | idle pull ms | 10%-changed pull ms (downloaded)", "---: | ---: | ---: | ---:"];
	for (const row of rows) {
		lines.push(`${row.files} | ${row.coldMs.toFixed(0)} | ${row.idleMs.toFixed(0)} | ${row.changedMs.toFixed(0)} (${row.changedDownloaded})`);
	}
	console.log(`\n=== workspace replica pull baseline ===\n${lines.join("\n")}\n`);
}, 300_000);
