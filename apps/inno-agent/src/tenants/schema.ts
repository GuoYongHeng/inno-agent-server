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

/** Legacy bytea table (migration 4). Channel outbox payloads now live in ObjectStore; leave the table for older DBs. */
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

/**
 * L2 wiki storage. `l2_files` holds every text file under the tenant's L2
 * area (wiki pages, navigation files, extracted text, raw text uploads).
 * `l2_objects` points at immutable blobs in object storage for binary
 * originals (PDF, Word, images). `l2_manifest` keeps one JSONB row per
 * archived source. `l2_pages` is the retrieval index: same whitespace-token
 * BM25 scheme as `l3_chunks`, with `tokens` produced by the shared CJK-bigram
 * segmenter and `content_hash`/`mtime_ms` doubling as the incremental
 * index-state tracked by the SQLite backend.
 */
const L2_WIKI_SQL = `
CREATE TABLE IF NOT EXISTS l2_files (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	path text NOT NULL,
	content text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, path)
);

CREATE TABLE IF NOT EXISTS l2_objects (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	path text NOT NULL,
	object_key text NOT NULL,
	sha256 text NOT NULL,
	bytes bigint NOT NULL,
	content_type text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, path)
);

CREATE TABLE IF NOT EXISTS l2_manifest (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	id text NOT NULL,
	entry jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS l2_pages (
	rowid bigserial PRIMARY KEY,
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	path text NOT NULL,
	title text NOT NULL,
	type text NOT NULL,
	tags jsonb NOT NULL,
	source_ids jsonb NOT NULL,
	body text NOT NULL,
	tokens text NOT NULL,
	content_hash text NOT NULL,
	mtime_ms bigint NOT NULL,
	version integer NOT NULL DEFAULT 1,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (tenant_id, path)
);

CREATE INDEX IF NOT EXISTS l2_pages_bm25 ON l2_pages
	USING bm25 (rowid, tenant_id, tokens)
	WITH (
		key_field = 'rowid',
		text_fields = '{
			"tokens": {"tokenizer": {"type": "whitespace"}},
			"tenant_id": {"tokenizer": {"type": "raw"}}
		}'
	);
`;

/**
 * Per-session pi-durable storage (H4). `ds_metadata` keeps one row per
 * session: the `next_id`/`next_seq` counters from the SQLite
 * `durable_metadata` table plus the lease (`owner_worker`, `lease_epoch`,
 * `lease_expires_at`) used for cross-worker ownership and commit fencing.
 * The remaining tables mirror the pi-durable SQLite schema verbatim, scoped
 * by `session_id`; `record`/`content` are JSON text exactly like the SQLite
 * columns. All rows cascade with the `durable_sessions` row.
 */
const DURABLE_STORAGE_SQL = `
CREATE TABLE IF NOT EXISTS ds_metadata (
	session_id text PRIMARY KEY REFERENCES durable_sessions (id) ON DELETE CASCADE,
	next_id numeric NOT NULL DEFAULT 2,
	next_seq bigint NOT NULL DEFAULT 1,
	owner_worker text,
	lease_epoch bigint NOT NULL DEFAULT 0,
	lease_expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS ds_record_ids (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	id bigint NOT NULL,
	record_type text NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document')),
	PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS ds_conversations (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	id bigint NOT NULL,
	owner_conversation_id bigint,
	owner_task_id bigint,
	record text NOT NULL,
	PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS ds_conversations_owner_conversation_idx
	ON ds_conversations (session_id, owner_conversation_id, id);
CREATE INDEX IF NOT EXISTS ds_conversations_owner_task_idx
	ON ds_conversations (session_id, owner_task_id, id);

CREATE TABLE IF NOT EXISTS ds_entries (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	id bigint NOT NULL,
	conversation_id bigint NOT NULL,
	head bigint,
	commit_seq bigint NOT NULL,
	record text NOT NULL,
	PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS ds_entries_conversation_idx
	ON ds_entries (session_id, conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS ds_entry_heads_conversation_idx
	ON ds_entries (session_id, conversation_id, id DESC) WHERE head IS NOT NULL;

CREATE TABLE IF NOT EXISTS ds_tasks (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	id bigint NOT NULL,
	conversation_id bigint NOT NULL,
	kind text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
	abort_requested boolean NOT NULL,
	background boolean NOT NULL,
	record text NOT NULL,
	PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS ds_tasks_status_idx ON ds_tasks (session_id, status, id);
CREATE INDEX IF NOT EXISTS ds_tasks_conversation_idx ON ds_tasks (session_id, conversation_id, id);
CREATE INDEX IF NOT EXISTS ds_tasks_kind_idx ON ds_tasks (session_id, kind, id);
CREATE INDEX IF NOT EXISTS ds_tasks_abort_requested_idx ON ds_tasks (session_id, abort_requested, id);
CREATE INDEX IF NOT EXISTS ds_tasks_background_idx ON ds_tasks (session_id, background, id);

CREATE TABLE IF NOT EXISTS ds_submissions (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	id bigint NOT NULL,
	conversation_id bigint NOT NULL,
	request_id text,
	status text NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
	record text NOT NULL,
	PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS ds_submissions_request_idx
	ON ds_submissions (session_id, conversation_id, request_id);
CREATE INDEX IF NOT EXISTS ds_submissions_conversation_idx
	ON ds_submissions (session_id, conversation_id, id);
CREATE INDEX IF NOT EXISTS ds_submissions_status_idx ON ds_submissions (session_id, status, id);

CREATE TABLE IF NOT EXISTS ds_documents (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	id bigint NOT NULL,
	kind text NOT NULL,
	family smallint NOT NULL CHECK (family IN (0, 1)),
	key_value text NOT NULL,
	scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
	owner_id bigint NOT NULL,
	created_at bigint NOT NULL,
	retired_at bigint,
	record text NOT NULL,
	PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS ds_documents_address_idx
	ON ds_documents (session_id, kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX IF NOT EXISTS ds_documents_scope_idx
	ON ds_documents (session_id, scope_kind, owner_id, id);
CREATE INDEX IF NOT EXISTS ds_documents_scope_kind_idx
	ON ds_documents (session_id, scope_kind, owner_id, kind, id);

CREATE TABLE IF NOT EXISTS ds_document_revisions (
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	document_id bigint NOT NULL,
	seq bigint NOT NULL,
	kind text NOT NULL CHECK (kind IN ('base', 'delta')),
	version bigint NOT NULL,
	content text NOT NULL,
	PRIMARY KEY (session_id, document_id, seq)
);
CREATE INDEX IF NOT EXISTS ds_document_revisions_kind_idx
	ON ds_document_revisions (session_id, document_id, kind, seq DESC);
`;

/**
 * Replicated tenant configuration. PostgreSQL is the only copy — any worker can
 * serve a tenant after takeover by reading this row directly; no local file is
 * materialised.
 */
const TENANT_CONFIG_SQL = `
CREATE TABLE IF NOT EXISTS tenant_configs (
	tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
	config TEXT NOT NULL,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * Worker affinity for idle sessions: `last_worker` records the worker that
 * last claimed the storage lease and survives lease release. Workspaces and
 * other session-local state still live on one worker's disk, so routing idle
 * session requests back to that worker keeps the session next to its files.
 */
const SESSION_AFFINITY_SQL = `
ALTER TABLE ds_metadata ADD COLUMN IF NOT EXISTS last_worker text;
`;

const WORKSPACE_REPLICA_SQL = `
CREATE TABLE IF NOT EXISTS tenant_workspaces (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	workspace_id text NOT NULL,
	rel_path text NOT NULL,
	name text NOT NULL,
	is_temp boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS session_workspaces (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	session_id text NOT NULL REFERENCES durable_sessions (id) ON DELETE CASCADE,
	workspace_id text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, session_id)
);

CREATE TABLE IF NOT EXISTS workspace_files (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	workspace_id text NOT NULL,
	rel_path text NOT NULL,
	size bigint NOT NULL,
	mtime_ms double precision NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, workspace_id, rel_path)
);
`;

/**
 * Directories as manifest rows (`ObjectWorkspaceStore`, H5): a directory is a
 * row with kind='directory', size 0 and no object. Implied directories (parent
 * segments of file rows) never get rows; explicit rows exist so empty
 * directories survive listing and replication. Existing rows stay files.
 */
const WORKSPACE_FILE_KIND_SQL = `
ALTER TABLE workspace_files
	ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file'
	CHECK (kind IN ('file','directory'));
`;


/**
 * Per-tenant scheduler ledgers (jobs.json / runs.jsonl replacement): the job
 * row stores the full normalized ScheduledJob JSON; run history is one row per
 * run so recent-history queries read a bounded tail by job or tenant.
 */
const TENANT_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS tenant_jobs (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	job_id text NOT NULL,
	data jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, job_id)
);

CREATE TABLE IF NOT EXISTS tenant_job_runs (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	run_id text NOT NULL,
	job_id text,
	data jsonb NOT NULL,
	recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS tenant_job_runs_job_idx
	ON tenant_job_runs (tenant_id, job_id, recorded_at DESC);
`;

/**
 * Per-tenant check-in ledger (checkins.json / occurrences.json replacement).
 */
const TENANT_CHECKINS_SQL = `
CREATE TABLE IF NOT EXISTS tenant_checkins (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	date text NOT NULL,
	checked_in_at timestamptz NOT NULL,
	completed_occurrence_ids jsonb NOT NULL DEFAULT '[]',
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, date)
);

CREATE TABLE IF NOT EXISTS tenant_checkin_occurrences (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	occurrence_id text NOT NULL,
	job_id text NOT NULL,
	data jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, occurrence_id)
);
CREATE INDEX IF NOT EXISTS tenant_checkin_occurrences_job_idx
	ON tenant_checkin_occurrences (tenant_id, job_id);
`;

/**
 * Small per-tenant key-value state (channel default targets, chat-session
 * bindings, session-channel metadata, wechat login token). Values are stored
 * as JSON text so jsonb's key reordering / U+0000 restriction never applies.
 */
const TENANT_STATE_SQL = `
CREATE TABLE IF NOT EXISTS tenant_state (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	key text NOT NULL,
	value jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, key)
);
`;

/**
 * Platform skill catalog (bodies in object storage) + per-tenant enablement.
 * Catalog rows are global; tenants only toggle `tenant_skills`.
 */
const SKILL_CATALOG_SQL = `
CREATE TABLE IF NOT EXISTS skill_catalog (
	skill_id text PRIMARY KEY,
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	version text NOT NULL,
	object_prefix text NOT NULL,
	disable_model_invocation boolean NOT NULL DEFAULT false,
	published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	published_by text NULL,
	source text NULL
);

CREATE TABLE IF NOT EXISTS tenant_skills (
	tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
	skill_id text NOT NULL REFERENCES skill_catalog (skill_id) ON DELETE CASCADE,
	enabled boolean NOT NULL DEFAULT true,
	installed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (tenant_id, skill_id)
);

CREATE INDEX IF NOT EXISTS tenant_skills_tenant_enabled_idx
	ON tenant_skills (tenant_id)
	WHERE enabled;
`;
/**
 * Platform-level mutable configuration. Single row (id = 1) holding the JSON
 * document that used to live in config.json: provider catalog, channel
 * credentials, search keys, feature toggles and the legacy skill-disable
 * list. config.json now only carries immutable deployment fields; mutable
 * keys present there are seeded into this row on boot. Shared by every
 * worker so replicas cannot drift.
 */
/**
 * Tenant-owned skills: rows published by a tenant get owner_tenant_id set;
 * platform seeds stay NULL. Tenant uploads publish object bodies under
 * tenants/<id>/skills/ instead of the shared platform/ prefix.
 */
const SKILL_CATALOG_OWNER_SQL = `
ALTER TABLE skill_catalog ADD COLUMN IF NOT EXISTS owner_tenant_id text NULL REFERENCES tenants (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS skill_catalog_owner_idx ON skill_catalog (owner_tenant_id) WHERE owner_tenant_id IS NOT NULL;
`;

export const TENANT_MIGRATIONS: readonly Migration[] = [
	{ version: 1, name: "baseline", sql: BASELINE_SQL },
	{ version: 2, name: "search_extensions", sql: EXTENSIONS_SQL },
	{ version: 3, name: "recovery_records", sql: RECOVERY_RECORDS_SQL },
	{ version: 4, name: "recovery_blobs", sql: RECOVERY_BLOBS_SQL },
	{ version: 5, name: "stream_journal", sql: STREAM_JOURNAL_SQL },
	{ version: 6, name: "l3_index", sql: L3_INDEX_SQL },
	{ version: 7, name: "l2_wiki", sql: L2_WIKI_SQL },
	{ version: 8, name: "durable_storage", sql: DURABLE_STORAGE_SQL },
	{ version: 9, name: "tenant_config", sql: TENANT_CONFIG_SQL },
	{ version: 10, name: "session_affinity", sql: SESSION_AFFINITY_SQL },
	{ version: 11, name: "workspace_replica", sql: WORKSPACE_REPLICA_SQL },
	{ version: 12, name: "workspace_file_kind", sql: WORKSPACE_FILE_KIND_SQL },
	{ version: 13, name: "tenant_jobs", sql: TENANT_JOBS_SQL },
	{ version: 14, name: "tenant_checkins", sql: TENANT_CHECKINS_SQL },
	{ version: 15, name: "tenant_state", sql: TENANT_STATE_SQL },
	{ version: 16, name: "skill_catalog", sql: SKILL_CATALOG_SQL },
	{ version: 17, name: "session_preset_id", sql: `
ALTER TABLE durable_sessions ADD COLUMN IF NOT EXISTS preset_id text;
` },
	// platform_config was dropped by migration 20 — this create is a no-op for
	// databases that already applied it; fresh databases create then drop it.
	{ version: 18, name: "platform_config", sql: `
CREATE TABLE IF NOT EXISTS platform_config (
	id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
	config TEXT NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);
` },
	{ version: 19, name: "skill_catalog_owner", sql: SKILL_CATALOG_OWNER_SQL },
	// platform_config proved unnecessary: config.json is the single source of
	// truth for server-managed config too. Drop it; existing rows are abandoned.
	{ version: 20, name: "drop_platform_config", sql: `
DROP TABLE IF EXISTS platform_config;
` },
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
