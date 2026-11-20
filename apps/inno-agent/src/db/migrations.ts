import type { Pool } from "pg";

/**
 * One numbered, append-only schema step. Versions are applied in ascending
 * order, each inside its own transaction, and recorded in `schema_migrations`.
 * Never edit or reorder a step that has shipped: add a new one.
 */
export interface Migration {
	version: number;
	name: string;
	sql: string;
}

/** Fixed key for the advisory lock that serialises migration runs across processes. */
const MIGRATION_LOCK_KEY = 7_210_415_001;

export function assertMigrationList(migrations: readonly Migration[]): void {
	let previous = 0;
	for (const migration of migrations) {
		if (!Number.isInteger(migration.version) || migration.version <= previous) {
			throw new Error(`Migration versions must be strictly increasing integers; got ${migration.version} after ${previous}`);
		}
		previous = migration.version;
	}
}

export interface AppliedMigration {
	version: number;
	name: string;
}

/**
 * Apply every pending migration. Safe to call from several processes at once:
 * a session-level advisory lock makes the others wait and then find nothing to do.
 * A database whose recorded version is newer than this build knows about is
 * rejected, since running old code against a newer schema silently corrupts it.
 */
export async function runMigrations(pool: Pool, migrations: readonly Migration[]): Promise<AppliedMigration[]> {
	assertMigrationList(migrations);
	const client = await pool.connect();
	const applied: AppliedMigration[] = [];
	try {
		await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
		await client.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version integer PRIMARY KEY,
				name text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`);
		const rows = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
		const done = new Set(rows.rows.map((row) => row.version));
		const known = new Set(migrations.map((migration) => migration.version));
		const unknown = [...done].filter((version) => !known.has(version));
		if (unknown.length > 0) {
			throw new Error(`Database has migrations this build does not know (${unknown.join(", ")}); refusing to run an older build against a newer schema`);
		}
		for (const migration of migrations) {
			if (done.has(migration.version)) continue;
			await client.query("BEGIN");
			try {
				await client.query(migration.sql);
				await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [migration.version, migration.name]);
				await client.query("COMMIT");
			} catch (err) {
				await client.query("ROLLBACK");
				throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			applied.push({ version: migration.version, name: migration.name });
		}
		return applied;
	} finally {
		try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]); } catch { /* connection already gone */ }
		client.release();
	}
}
