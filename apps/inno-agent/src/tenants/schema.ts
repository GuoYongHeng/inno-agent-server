import type { Pool, PoolClient } from "pg";
import { runMigrations, type Migration } from "../db/migrations.js";

/** Migration 1: the schema as it existed before numbered migrations (idempotent, so existing databases adopt it). */
const BASELINE_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
	id text PRIMARY KEY,
	kind text NOT NULL DEFAULT 'personal' CHECK (kind = 'personal'),
	owner_user_id text NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
	role text NOT NULL CHECK (role = 'owner'),
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, user_id),
	UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS resource_ownership (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	resource_type text NOT NULL,
	resource_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, resource_type, resource_id),
	UNIQUE (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS resource_ownership_tenant_type_idx
	ON resource_ownership (tenant_id, resource_type);

CREATE TABLE IF NOT EXISTS durable_sessions (
	id text PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	workspace_id text NOT NULL,
	name text NOT NULL,
	provider text NOT NULL,
	model_id text NOT NULL,
	origin text NOT NULL DEFAULT 'web' CHECK (origin IN ('web', 'scheduler')),
	archived boolean NOT NULL DEFAULT false,
	message_count integer NOT NULL DEFAULT 0,
	preview text NOT NULL DEFAULT '',
	topic_generated boolean,
	topic_upgraded boolean,
	conversation_id text,
	sandbox_id text,
	version integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE durable_sessions ADD COLUMN IF NOT EXISTS sandbox_id text;

CREATE INDEX IF NOT EXISTS durable_sessions_tenant_updated_idx
	ON durable_sessions (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sandbox_leases (
	session_id text PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	heartbeat_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sandbox_leases_tenant_idx ON sandbox_leases (tenant_id);

CREATE TABLE IF NOT EXISTS sandbox_usage (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	day date NOT NULL,
	active_ms bigint NOT NULL DEFAULT 0,
	PRIMARY KEY (tenant_id, day)
);

CREATE TABLE IF NOT EXISTS job_run_claims (
	occurrence_id text PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	job_id text NOT NULL,
	scheduled_at timestamptz NOT NULL,
	owner_token text NOT NULL,
	claimed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS job_run_claims_tenant_job_idx
	ON job_run_claims (tenant_id, job_id);
`;

/**
 * Search extensions the memory layers rely on (BM25 via pg_search, trigram, pgvector).
 * Requires a ParadeDB image; pg_search needs vector to exist first.
 */
const EXTENSIONS_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_search;
`;

/**
 * Per-session recovery records (pending/answered questions and approvals). The
 * record key is the SHA-256 of the tool call's operation ID, so the primary key
 * is the idempotency key: one tool call can only ever own one row.
 */
const RECOVERY_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS recovery_records (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	session_id text NOT NULL,
	kind text NOT NULL,
	record_key text NOT NULL,
	value jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, session_id, kind, record_key)
);
`;

/** Payload snapshots for the channel outbox, written in the same transaction as their record. */
const RECOVERY_BLOBS_SQL = `
CREATE TABLE IF NOT EXISTS recovery_blobs (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	session_id text NOT NULL,
	kind text NOT NULL,
	record_key text NOT NULL,
	payload bytea NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, session_id, kind, record_key)
);
`;

/**
 * Journal of each chat turn's SSE events and original submission intent, so a
 * reconnecting client (or a different worker) can replay a turn exactly. A turn
 * is replayable for a short time after it finishes (`finished_at`).
 */
const STREAM_JOURNAL_SQL = `
CREATE TABLE IF NOT EXISTS stream_turns (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	session_id text NOT NULL,
	turn_id text NOT NULL,
	header jsonb NOT NULL,
	input jsonb NOT NULL,
	submission_id bigint,
	cancel_requested boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	finished_at timestamptz,
	PRIMARY KEY (tenant_id, session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS stream_turns_session_created_idx
	ON stream_turns (tenant_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stream_events (
	id bigserial PRIMARY KEY,
	tenant_id text NOT NULL,
	session_id text NOT NULL,
	turn_id text NOT NULL,
	envelope jsonb NOT NULL,
	FOREIGN KEY (tenant_id, session_id, turn_id)
		REFERENCES stream_turns (tenant_id, session_id, turn_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS stream_events_turn_idx
	ON stream_events (tenant_id, session_id, turn_id, id);
`;

/**
 * L3 cross-conversation recall index. `tokens` holds the segmented text (CJK
 * bigrams, lowercase words) and is searched with BM25 through pg_search; the
 * whitespace tokenizer keeps index and query tokens identical to the SQLite
 * index. `rowid` is the bm25 key field; (tenant_id, id) is the logical key.
 */
const L3_INDEX_SQL = `
CREATE TABLE IF NOT EXISTS l3_chunks (
	rowid bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	id text NOT NULL,
	session_id text NOT NULL,
	role text NOT NULL CHECK (role IN ('user', 'assistant')),
	text text NOT NULL,
	tokens text NOT NULL,
	ts bigint NOT NULL,
	UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS l3_chunks_session_idx ON l3_chunks (tenant_id, session_id);

CREATE INDEX IF NOT EXISTS l3_chunks_bm25 ON l3_chunks
	USING bm25 (rowid, tenant_id, session_id, tokens)
	WITH (
		key_field = 'rowid',
		text_fields = '{
			"tokens": {"tokenizer": {"type": "whitespace"}},
			"tenant_id": {"tokenizer": {"type": "raw"}},
			"session_id": {"tokenizer": {"type": "raw"}}
		}'
	);

CREATE TABLE IF NOT EXISTS l3_index_state (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	session_id text NOT NULL,
	last_offset integer NOT NULL,
	revision bigint NOT NULL,
	chunk_count integer NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, session_id)
);
`;

export const TENANT_MIGRATIONS: readonly Migration[] = [
	{ version: 1, name: "baseline", sql: BASELINE_SQL },
	{ version: 2, name: "search_extensions", sql: EXTENSIONS_SQL },
	{ version: 3, name: "recovery_records", sql: RECOVERY_RECORDS_SQL },
	{ version: 4, name: "recovery_blobs", sql: RECOVERY_BLOBS_SQL },
	{ version: 5, name: "stream_journal", sql: STREAM_JOURNAL_SQL },
	{ version: 6, name: "l3_index", sql: L3_INDEX_SQL },
];

/** Every migration's SQL in order, for `auth:migrate --print`. */
export const TENANT_SCHEMA_SQL = TENANT_MIGRATIONS.map((migration) => `-- ${migration.version} ${migration.name}\n${migration.sql}`).join("\n");

export async function migrateTenantDatabase(pool: Pool): Promise<void> {
	await runMigrations(pool, TENANT_MIGRATIONS);
}

export async function withTenantTransaction<T>(
	client: PoolClient,
	operation: () => Promise<T>,
): Promise<T> {
	await client.query("BEGIN");
	try {
		const result = await operation();
		await client.query("COMMIT");
		return result;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	}
}
