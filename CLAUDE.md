# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is an npm workspaces monorepo (Node.js >=22.19.0, ES modules) for **Inno Agent**, a personal learning agent built on the pi-durable agent harness.

- `apps/inno-agent/` — backend (HTTP server), TypeScript, compiles to `dist/`. Entry point is `dist/server.js`.
- `apps/inno-agent/web/` — frontend (React 19 + Tailwind 4 + Vite), workspace `inno-agent-web`.
- `apps/showcase/` — separate static demo viewer for exported replay cases (workspace `inno-agent-showcase`); its data export pipeline was removed together with the legacy runtime.
- `scripts/` — the self-hosted content hub server (`content-hub-server/`) and dev/eval helpers.
- `docs/` — screenshots, use-case guides, `SYSTEM_DEPENDENCIES.md`, and the durable runtime/roadmap docs.
- `skills/` — bundled global skills, copied into the backend image at `/app/skills` (`INNO_SKILLS_DIR` in the image/compose); the admin-managed catalog is read-only in authenticated mode, so the image is its distribution channel. Local development can point `INNO_SKILLS_DIR` at `./skills` or `runtime/skills`.
- `runtime/` — local runtime state (config, data, skills); gitignored. Mapped to `INNO_*` env vars.
- `workspace/` — default agent working directory; gitignored.

**There is exactly one agent runtime: pi-durable.** The earlier `@earendil-works/pi-coding-agent` runtime (the "legacy" path: global `AgentSession`, JSONL sessions, CLI, bash/PTY terminal, MCP, subagents, pi-sandbox, permission-system plugin, computer-use, codemode) has been removed; see `docs/DURABLE_ROADMAP.md` for what was removed and why. Do not reintroduce a second execution path. Old legacy JSONL session history is intentionally not read.

PI SDK packages used: `@earendil-works/pi-durable` and `@earendil-works/pi-ai` (backend, pinned to `1.4.0`), and `@earendil-works/pi-web-ui` (web, which keeps an older `pi-ai` hoisted at the root — inspect backend-resolved declarations under `apps/inno-agent/node_modules/` when working on server integration).

Key dependencies: `cron-parser` (scheduler), `@larksuiteoapi/node-sdk` (Feishu), `typebox` (validation), `undici` (HTTP client), `better-auth` + `pg` (optional multi-user auth), `graphology` + `graphology-communities-louvain` (wiki knowledge graph), `yaml` (YAML parsing), `@llamaindex/liteparse` (document parsing), `@tavily/core` (web search). The `ask_user_question` schema/validation is vendored from `@juicesharp/rpiv-ask-user-question` (MIT) under `src/agent/ask-user-question/`.

Tests run with `npm test` (`vitest run`, root script) and also execute in the test and release CI. The PostgreSQL-free suite is 132 files (999 tests), covering durable faux-model concurrency/tenant/configured-model/request-dedup/memory/channel-outbox/question/permission-recovery/cancellation/topic-generation/model-switch/edit-and-resend/context-usage/L3-indexing/scheduler/SIGKILL recovery/storage-lock-loss behavior, durable shard routing, workspace replica push/pull, structured attachment/inline-image projection, route units, and web chat trace/timeline components. The real-server smoke suite moved to the integration config (`server.smoke.integration.test.ts`) because boot now requires PostgreSQL + Better Auth. Coverage for channels/scheduler/L3 is tracked in `docs/quality-remediation-plan.md`. The `npm run test:integration` suite separately exercises Better Auth sign-up, tenant provisioning/ownership, cross-tenant session/workspace denial, tenant-scoped BTW and memory storage, server-managed provider catalog with per-tenant model selection, channel identity isolation, atomic scheduled-run leases, durable storage advisory-lock contention, forwarding between workers including session-owner routing and cross-worker takeover after SIGKILL and after SIGSTOP zombie ownership (forward timeout, lease expiry, epoch fencing), cross-worker workspace-file restoration via the object-store replica, internal prompt execution on the worker-token endpoint (`POST /api/internal/durable-prompt`, `INNO_WORKER_TOKEN`), SSE reconnect replay, SIGKILL/restart recovery, durable cancellation, workspace attachments/inline images, topic generation and tenant-isolated L3 recall against a real temporary PostgreSQL instance and local fake model endpoints. These integration tests need a **ParadeDB** PostgreSQL 17 (the schema creates `vector`, `pg_trgm` and `pg_search`): set `INNO_TEST_DATABASE_URL`, or let `db/test-postgres.ts` start a disposable `paradedb/paradedb:v0.25.11-pg17` container through docker (override with `INNO_TEST_PARADEDB_IMAGE`). The suite (20 files including the real-server smoke suite, plus env-gated skips, including the PostgreSQL session catalog, sandbox quota store, numbered-migration runner, recovery records, channel outbox, SSE journal, L3 index, L2 wiki backend, and the pi-durable `PgDurableStorage` — verified through pi-durable's official `createStorageConformance` suite plus lease-fencing and a `storage-benchmark` comparison against the SQLite backend; plus a live E2B test that runs only with `E2B_API_KEY` and an S3 object-store test that runs only with `INNO_TEST_S3_ENDPOINT`/`_ACCESS_KEY`/`_SECRET_KEY`, e.g. a local MinIO) was verified passing against ParadeDB v0.25.11. The TypeScript build (`npm run build`) remains the primary sanity check. No ESLint or Prettier configuration exists.

When a PR changes the test count, the size of `server.ts`, or other structural facts stated in this file, update this file in the same PR — AI agents read it as ground truth.

### TypeScript configs

Three tsconfig files, each self-contained (no `extends` chain):

- **`tsconfig.base.json`** (repo root) — reference base: `ES2022` target, `Node16` module/resolution, strict mode, `sourceMap`, `declaration` + `declarationMap`, `experimentalDecorators`, `emitDecoratorMetadata`, `resolveJsonModule`, `useDefineForClassFields: false`. Not directly referenced by the other configs but documents the shared settings.
- **`apps/inno-agent/tsconfig.json`** — backend: `ES2022` target, `Node16` module/resolution, strict mode, `outDir: ./dist`, `rootDir: ./src`, `declaration`, `sourceMap`, `types: ["node"]`. Does NOT use `experimentalDecorators` or `emitDecoratorMetadata` (those are only in the root base config). Compiles `src/foo.ts` → `dist/foo.js`. The compiled server entry point is `dist/server.js`.
- **`apps/inno-agent/web/tsconfig.json`** — frontend: `ESNext` module, `bundler` resolution, `lib` includes DOM/DOM.Iterable, `jsx: "react-jsx"`, `noEmit: true`, `isolatedModules: true`, `experimentalDecorators: true`, `useDefineForClassFields: false` (kept for the remaining Lit-based `pi-web-ui` components). TypeScript is only for type-checking during `vite build` — Vite handles the actual bundling.

`tsx` is available as a dev dependency for running TypeScript files directly without compilation (e.g., `npx tsx some-script.ts`).

### Reference docs

- **[README.md](./README.md)** — full project overview, design rationale, features, deployment, contributing.
- **[QUICKSTART.md](./QUICKSTART.md)** — 5-minute setup guide (Chinese) with provider config examples.
- **[apps/inno-agent/README.md](./apps/inno-agent/README.md)** — backend API route table and project structure (Chinese).
- **[docs/SYSTEM_DEPENDENCIES.md](./docs/SYSTEM_DEPENDENCIES.md)** — full system-level dependency reference (build-time, runtime, Python environment, native modules). Essential for Docker/deployment work.
- **[docs/MULTI_USER_DURABLE.md](./docs/MULTI_USER_DURABLE.md)** — multi-user Durable refactor overview, tenant isolation, storage/recovery semantics, real-service acceptance results, and production limitations.
- **[docs/DURABLE_RUNTIME.md](./docs/DURABLE_RUNTIME.md)** — pi-durable runtime boundary, recovery semantics, single-owner storage rule, and SSE projection constraints.
- **[docs/DURABLE_CAPACITY.md](./docs/DURABLE_CAPACITY.md)** — faux-provider durable capacity command, metric boundaries, recorded baseline, and shard-sizing limitations.
- **[docs/PERMISSIONS.md](./docs/PERMISSIONS.md)** — workspace file-access boundary and the persisted write/edit approval flow (no host shell; shell only in the optional remote sandbox).

## Common Commands

All commands are run from the repo root and use `npm --workspace` under the hood.

```bash
# Build backend + web
npm run build

# Run a single test file / test name (vitest; unit config excludes *.integration.test.ts)
npx vitest run apps/inno-agent/src/memory/l2/wiki-query.test.ts
npx vitest run -t "partial test name"

# Integration suite (needs a temp PostgreSQL; separate config)
npm run test:integration

# Build frontend only
npm --workspace inno-agent-web run build

# Start HTTP server (serves API + web/dist on port 3000)
npm run server -- --home ./runtime --workspace ./workspace --port 3000

# Dev: run server and Vite dev separately
npm run dev:server      # backend on :3000
npm run web:dev         # Vite on :5173, proxies /api -> :3000

# Watch mode (TypeScript recompile on change)
npm run dev             # `tsc --watch` in apps/inno-agent (backend only, does not rebuild frontend)

# Run a TypeScript file directly without building
npx tsx some-script.ts

# Measure durable runtime concurrency/recovery with faux providers only
npm run benchmark:durable -- --sessions 16 --runs 32 --concurrency 8 --delay-ms 100

# restart-dev.sh orchestration
npm run restart         # full build + dev restart
npm run restart:fast    # skip build, restart only
```

### First-run setup

```bash
mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json — set providers[*].apiKey
```

An `.env.example` file is provided at the repo root with default `INNO_*` env var values for local development.

### Dev restart rules

- Changes to `src/server.ts` or backend API → `npm run build` + restart server.
- Changes to `web/vite.config.ts` → restart Vite.
- Changes under `web/src/` → Vite HMR usually handles it.
- If upload/Wiki/proxy behavior misbehaves, fully restart both. Health checks: `curl localhost:3000/health`, `curl localhost:5173/api/wiki/pages`.

### restart-dev.sh

The `restart-dev.sh` script at the repo root orchestrates the full dev lifecycle:

```bash
bash restart-dev.sh              # build + dev mode start both frontend and backend
bash restart-dev.sh --skip-build # skip compilation, restart processes only
bash restart-dev.sh build        # build only, no service startup
bash restart-dev.sh start        # start services without building
bash restart-dev.sh status       # show process health and port status
bash restart-dev.sh logs server  # tail backend logs
bash restart-dev.sh logs web     # tail frontend logs
bash restart-dev.sh smoke        # run health/session/WS smoke tests
bash restart-dev.sh stop         # stop all managed processes
bash restart-dev.sh --help       # list all options
```

Supports `--mode dev|prod`, `--skip-build`, `--port <N>`, `--web-port <N>` (custom Vite dev port), `--tail` (follow server.log after starting). Environment variables: `INNO_MODE`, `INNO_WEB_PORT`. Equivalent npm shortcuts: `npm run restart` (full), `npm run restart:fast` (skip build).

### CI/CD

GitHub Actions workflow `.github/workflows/test.yml` runs `npm ci`, `npm test`, `npm run test:integration` and `npm run build` on Ubuntu. There are no desktop release workflows: the Electron client was dropped when the backend became a distributed, multi-worker service.

## Design Philosophy

Inno Agent is a **personal learning agent** — not a general coding agent. Key stances that shape the codebase:

- **Layered memory, not a flat chat summary.** Archived knowledge (L2) and recent dialogue (L3) have different lifecycles — each lives in its own layer with explicit boundaries enforced in the system prompt and storage layout. There is no learner-profile layer (the former L1 was removed; see `docs/DURABLE_ROADMAP.md`).
- **Durable facts go to tools, not replies.** Knowledge worth keeping is archived into L2 via tools rather than left in a chat reply.
- **The PI SDK kernel is never modified.** All learning behavior is added through registered tools and a single extension hook (`createInnoExtension`), keeping the agent runtime upstream-compatible.

## Runtime Path Resolution

`server.ts` bootstraps through `apps/inno-agent/src/runtime.ts`. This is the single source of truth for where data lives.

Precedence: command-line flag → env var → `~/.inno-agent/...`.

| Flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config` | `INNO_CONFIG_FILE` | `<configDir>/config.json` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--data` / `--data-dir` | `INNO_DATA_DIR` | `<home>/data` |
| `--skills` / `--skills-dir` | `INNO_SKILLS_DIR` | `<home>/skills` |
| `--workspace` / `--workspace-dir` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` (via config) | `3000` |

Derived paths inside `dataDir`: `sessions/` (channel-binding metadata is in `tenant_state`), `preset-cache/`, plus per-tenant roots under `tenants/<tenantId>/` for workspace materialised copies only. Tenant config, durable session storage, the session catalog, L2/L3 memory, jobs/check-ins and channel ledgers live in PostgreSQL (`ds_*`, `durable_sessions`, `tenant_jobs`, `tenant_job_runs`, `tenant_checkins`, `tenant_checkin_occurrences`, `tenant_state`). `applyRuntimeEnvironment` re-exports the resolved `INNO_*` paths back into `process.env`.

When editing path-related code, change `runtime.ts` rather than hard-coding paths in `server.ts`.

## Architecture

### Agent runtime (pi-durable)

Every conversation is a **durable session**: one pi-durable harness over one `Storage` per session — always PostgreSQL (`PgDurableStorage` in `agent/pg-durable-storage.ts`, porting pi-durable's `SqliteStorage` onto shared `ds_*` tables scoped by `session_id` with JSON-text record columns). The session catalog is the async `SessionCatalog` interface (`agent/session-catalog.ts`) backed by PostgreSQL (`PgSessionCatalog`, table `durable_sessions`, tenant-scoped rows written in the same transaction as `resource_ownership`). The file-backed implementations (`FileSessionCatalog`, `FileRecoveryStore`, `FileStreamJournal`, `FileChannelOutbox`, `FileL2Backend`, `LocalFsWorkspaceStore`) remain only as unit-test fakes — production has no unauthenticated mode. Every `DurableSessionService` catalog method (`get`/`list`/`create`/`rename`/…) is async. There is no global "active session" and no prompt queue; the web UI and every background caller address a session by ID. `INNO_DURABLE_ENABLED` no longer exists — durable is always on, and `POST /api/sessions` accepts `runtime` only for older clients (anything but `"durable"` is rejected).

Key files in `apps/inno-agent/src/agent/`:

- `durable-runtime.ts` — the pi-durable host for one session: durable `requestId` admission, submission reacquisition, close/reopen recovery, a process-local double-open guard, session-level model switching (`setModel` → `conversation.configure({ model })`, effective from the next request), and edit-and-resend (`branchBeforeUserMessage` forks the conversation just before a user message; the catalog's `conversationId` then points the session at the fork). `contextInfo`/`contextMessages()` feed context-usage accounting.
- `durable-session-service.ts` — the tenant-rooted catalog and idle runtime leases. It builds each runtime's instructions (system prompt + global skills + workspace `agent.md`/`.skills`), memory/channel/question tools, and `extraTools` (document parsing, Tavily web search, scheduler tools, bound to the verified tenant). Authenticated opens claim the session's durable storage lease (`ds_metadata.owner_worker`/`lease_epoch`/`lease_expires_at` via `TenantStore.claimDurableStorage`, renewed by heartbeat, released on close): a claimant wins when no other worker's lease is live, a dead owner's advisory lock is absent, or the lease expired. `PgDurableStorage` commits are fenced on the claimed `lease_epoch`, so a paused-then-resumed owner's writes fail fatally instead of corrupting state. A per-session PostgreSQL advisory lock on a dedicated connection stays as the fast mutual-exclusion path and invalidates the runtime if that connection is lost. It also owns side-channel completions through the session's own model: topic generation, BTW side questions, and context usage.
- `durable-models.ts` — builds an isolated pi-ai `Models` runtime from the tenant/local config (no shared `models.json`/`auth.json`), and the stateless completions used for topics and side questions.
- `durable-projection.ts` — converts committed entries and durable events into Inno history/SSE shapes; raw `watchEvents()` is not an exact replay log.
- `durable-stream-store.ts` — journals each SSE turn's exact model input, numeric event envelopes, submission ID, and cancellation under the tenant-local data root; status/replay/question/abort paths restore it after restart, and one per-turn projection reacquires the original submission without a synthetic user message. Exact replay is retained for five minutes after a turn ends.
- `src/sandbox/` — optional remote sandbox (E2B) for shell and file tools, platform-level (`sandbox` in the server's own `config.json` or `INNO_SANDBOX_ENABLED`/`E2B_API_KEY`/`E2B_DOMAIN`/`E2B_TEMPLATE`; never taken from a tenant's config). `sandbox-backend.ts` is the e2b-shaped contract; `e2b-backend.ts` implements it with the `e2b` SDK; `sandbox-env.ts` adapts it to pi-durable's `ExecutionEnv` (passes pi-durable's env conformance suite except directory watching); `sandbox-session.ts` (`SandboxManager`) creates/reconnects/pauses/destroys one sandbox per session (ID stored as `sandboxId` in the catalog) and builds the runtime binding, enforcing per-tenant limits through `sandbox-quota.ts` (`SandboxQuotaStore`; in-memory for local mode, `pg-sandbox-quota.ts` in PostgreSQL for authenticated mode — concurrent sandboxes, total sandboxes, daily minutes; an over-limit session still opens but its sandbox is blocked behind `GuardedSandboxBackend` and retried every turn); `workspace-sync.ts` keeps the host workspace and the sandbox workspace in step (host→sandbox before each turn, sandbox→host after it and before host-path tools). With a sandbox the runtime registers pi-durable's `bash` tool (approval per command by default, denied when headless) and `durable-env.ts` is not used. `sandbox-audit.ts` + `durable-sandbox-fsck.ts` (`npm run sandbox:fsck [-- --repair]`) find and destroy orphaned sandboxes (created by this app, no session record references them, older than a grace period); egress can be limited with `sandbox.allowedDomains`; the settings card (Integrations) hides sandbox settings from tenants entirely — `GET /api/settings` reports `sandboxEditable: false` and `PUT /api/settings/sandbox` returns 403 (the API key is platform-level only). `local-backend.ts` is a no-isolation test double.
- `durable-env.ts` — the workspace-contained `read`/`write`/`edit` environment with canonical symlink checks and descriptor-verified opens (O_NOFOLLOW plus ino/realpath check, so a link swapped in after the check cannot escape); shell, delete, rename, append and every other mutation fail closed.
- `durable-memory.ts` — native replay-safe tenant-local L2/L3 tools. L2 archive is deterministic with no nested model calls (LLM-written wiki pages are unreachable; the code is kept behind `createL2Tools`'s `richGeneration` parameter).
- `durable-channels.ts` — replay-safe `send_file_to_channel` through a persistent outbox. The external send crash window remains at-least-once.
- `recovery-store.ts` — async per-session recovery records behind `RecoveryRecordStore`, backed by `PgRecoveryStore` (table `recovery_records`, primary key `(tenant_id, session_id, kind, record_key)` where the key is the SHA-256 of the tool call's operation ID, so one call can own one row). Kinds: `question`, `permission`, `outbox`. The stores built on it (`DurableQuestionStore`, `DurablePermissionStore`) serialise their own operations through a `SerialQueue`, because async backends, unlike synchronous file code, can interleave callers; `canonicalJson`/`withoutNul` exist because `jsonb` reorders keys and cannot hold U+0000. `channels/pg-channel-outbox.ts` keeps the channel outbox in PostgreSQL (`recovery_records` kind `outbox` plus the payload snapshot in `recovery_blobs`, written in one transaction; a snapshot is materialised as a temporary file only for the upload), and `agent/pg-stream-journal.ts` keeps the SSE journal (`stream_turns`/`stream_events`, buffered multi-row inserts that keep order; five-minute replay window via `finished_at`). `durable-session-service.ts` picks the PostgreSQL backends when a tenant and `recoveryPool` are present. Cross-process safety still relies on the single-owner rule (H4): a decision answered on two processes at once is not arbitrated by the database.
- `durable-questions.ts` / `durable-permissions.ts` — replay-safe `ask_user_question` and workspace `write`/`edit` approvals with stable session/tool-call identity and persisted decisions; SIGKILL/reopen returns the original answer without another card. Non-streaming and headless callers resolve as `no_ui`. `ask-user-question/` holds the vendored questionnaire schema, validator and response envelope; `question-types.ts`/`permission-types.ts` hold the shared types.
- `durable-job-runner.ts` — runs agent jobs and channel prompts in a durable session (manual streaming/non-streaming, scheduled, deferred). Reminder jobs are recorded in the run's session as an assistant notice (`DurableJobExecution.notifyOnly`) without a model turn.
- `skills.ts` — first-party skill discovery and prompt formatting (global skills dir honouring `.ignore`, workspace `.skills/`); `workspace-context.ts` builds the per-workspace prompt sections. In the backend image the global skills dir is `/app/skills`, baked from repo `skills/`.
- `document-tools.ts`, `tavily-tools.ts`, `scheduler/scheduler-tools.ts`, `channels/channel-tools.ts` and the memory tools are native pi-durable tool registrations built with `defineInnoTool` (`inno-tool.ts`). Tools are non-replayable by default (a crash yields an `interrupted` result, never a silent re-run); only tools that prove idempotency declare `replay: "safe"`.
- `context-usage.ts` — context accounting from the provider's last reported usage plus estimates for what follows; `system-prompt.ts` — `INNO_SYSTEM_PROMPT`, injected every turn; `workspace-path-guard.ts` — canonical path validation.
- `durable-audit.ts` / `durable-orphans.ts` + `durable-fsck.ts` — orphan check across the local and tenant durable roots (run at startup, report-only, plus `npm run durable:fsck [-- --repair]`; tenant roots are checked against PostgreSQL when `DATABASE_URL` is set, and a root with data but no catalog is an error, never "all orphans") and per-root disk usage. `utils/metrics.ts` holds in-process counters/gauges/duration summaries served as Prometheus text at loopback-only `GET /metrics` (catalog read/write time and size, advisory-lock acquired/busy/lost, file-lock wait, orphan and disk gauges).
- `src/db/migrations.ts` — numbered, append-only PostgreSQL migrations (`schema_migrations` table, advisory-locked, one transaction per step, refuses a database newer than the build); the tenant schema is `TENANT_MIGRATIONS` in `tenants/schema.ts` (1 = baseline, 2 = `vector`/`pg_trgm`/`pg_search` extensions, so authenticated mode requires a ParadeDB image). `src/object-store/` is the platform-level blob store abstraction (`ObjectStore`; S3-compatible implementation for Alibaba Cloud OSS in production and MinIO locally, filesystem-backed `FsObjectStore` for single-host/test sharing via `INNO_OBJECT_STORAGE_PROVIDER=fs` + `INNO_OBJECT_STORAGE_DIR`, in-memory double; tenant-scoped keys via `tenantObjectKey`; `S3ObjectStore` signs presigned URLs against `INNO_OBJECT_STORAGE_PUBLIC_ENDPOINT` when set so browser-facing URLs can differ from the server's internal endpoint), configured by `objectStorage` in the server config or `INNO_OBJECT_STORAGE_*` env; wired into L2 storage for authenticated tenants (binary raw originals) and into workspace replication. In authenticated mode with durable object storage (`s3`/`fs`), workspace files live in the object store behind a PostgreSQL `workspace_files` manifest (`ObjectWorkspaceStore`); the worker's local directory is a disposable working copy kept warm by `workspace/workspace-replica.ts` (pulls on session open/before each turn under local exec, pushes on file mutations, turn settle and runtime close; push only deletes keys its own state file tracks). Panel reads and writes go through the `WorkspaceStore` interface — writes update the manifest first and mirror to the local copy. `POST /api/workspace/upload-url` + `/api/workspace/upload/complete` and `raw?download=1`→302 serve presigned direct transfer when the provider can sign (S3 only; other providers 404 and the client falls back to the proxy; the bucket needs CORS allowing browser PUT). `npm run workspace:fsck [-- --repair] [-- --grace-ms <ms>]` (`src/workspace-fsck.ts` + `workspace/workspace-object-audit.ts`) sweeps objects under `tenants/<t>/workspaces/<ws>/` against the `workspace_files` manifest — abandoned presigned uploads, crash windows, failed deletes — deleting only orphans older than the grace window (default 1h) and reporting manifest rows whose bytes are missing; run it like `durable:fsck`, no automatic schedule). `INNO_EXEC_BACKEND=local` binds sessions to `LocalExecManager` (bash/file tools on the worker via `SandboxExecutionEnv`; `persistent` is the default); see `docs/DURABLE_ROADMAP.md` H5 for limits.
- `durable-capacity.ts` — the explicit `npm run benchmark:durable` harness (per-session faux providers, SIGKILL/reopen recovery check; never calls a remote model). Its minimal-runtime results are not HTTP/multi-tenant production sizing.

Durable specifics worth knowing:

- Session IDs are `durable-<uuid>`. Catalog records pin a `provider`/`modelId` per session (changed with `PATCH /api/sessions/:id` and `{provider, modelId}`), and optionally a `conversationId` after an edit-and-resend.
- Streaming and non-streaming structured workspace attachments are canonically validated, sent as separate model-only context while history retains the raw user text, and restored through tenant-scoped request-ID-deduplicated sidecars. Inline images persist under `.chat-images/`, use native image blocks for vision models; providers without image input reject the turn.
- Topics: a first-message fallback is recorded, upgraded once at six messages, and `POST /api/sessions/:id/generate-topic` regenerates; manual renames win over in-flight automatic writes.
- Explicit `l3_recall` and threshold-gated automatic injection use the ownership-filtered session index; committed snapshots are indexed idempotently by entry revision with the current session excluded, and automatic recall is a separate model-only input block hidden from history.
- Completed channel/question/permission recovery records have a 30-day retention applied only after `Harness.inspect()` proves the session has no live work; session deletion removes its recovery records and outbox.
- `tenants/durable-tenant-router.ts` optionally hashes the verified tenant onto a static worker map and forwards authenticated JSON/SSE requests to that owner; public bridge callbacks recover tenant ownership from the bearer token's PostgreSQL record and forward before local channel bootstrap. Failover is pending; no cross-process active-active storage is permitted.
- Better Auth + PostgreSQL are mandatory at boot: `DATABASE_URL`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` must be set and the auth/tenant schema migrated (`npm run auth:migrate --workspace inno-agent`) or the server exits. The legacy toggles (`INNO_AUTH_MODE`, `INNO_MULTI_USER_ENABLED`, `INNO_ALLOW_UNAUTHENTICATED_NETWORK`) are rejected on sight. Every authenticated request resolves a tenant; `requireRequestTenant` treats a missing tenant as a wiring bug (500). Public endpoints are only `/api/auth/*`, `/health` and the bridge webhook, which recovers its tenant from the bearer token.
- Unsupported capabilities (host shell, delete, rename, MCP, subagents) are absent, not emulated; a shell exists only inside the remote sandbox when it is enabled. See `docs/DURABLE_RUNTIME.md` and `docs/DURABLE_ROADMAP.md`.

`server.ts` imports `source-map-support/register` at the top for readable stack traces and calls `applyRuntimeEnvironment` from `runtime.ts` before anything else runs.

### LLM Fetch Logger (`src/utils/fetch-logger.ts`)

Wraps `globalThis.fetch` at startup to intercept and log all LLM provider API calls (OpenAI-style `/chat/completions`, Anthropic `/messages`, PI proxy `/api/stream`). Each request gets a correlation ID (`seq/unixTimestamp`). By default only metadata is logged (URL, status, elapsed time, body sizes) — request/response bodies (truncated to 8000/4000 chars) are included only when `LOG_LLM_BODY=1` is set, since they contain prompts, user messages and model output. Installed via `installFetchLogger()` in `server.ts`.

### Proxy Bypass (`src/utils/proxy-bypass.ts`)

Manages `NO_PROXY` env var for providers with `bypassProxy: true` in config. Called at startup by `server.ts` to ensure direct connections to specified provider endpoints.

### Content Hub System (`src/content-source/`)

Fetches remote skills and presets from a configurable source. Two transport types:

- **"github"** (`github-source.ts`): reads from a GitHub repo (owner, repo, ref, skillsPath, presetsPath). Uses `token` for PAT/auth.
- **"bundle"** (`bundle-source.ts`): reads from a self-hosted HTTP service that speaks a simple index + tarball protocol. Avoids GitHub rate limits.

The local bundle server is at `scripts/content-hub-server/server.mjs` (zero-dependency, Node >= 20 built-ins only + system `tar`). See its README for setup instructions.

Both item types (skills and presets) share the same abstraction: a directory per item containing a marker file (`SKILL.md` for skills, `preset.json` for presets) plus supporting files. The content hub config lives in `config.json` under `contentHub`.

### Presets (`src/presets/`)

Preset workspaces are ready-to-use templates surfaced as one-click cards on the welcome page. Each preset is a directory with:
- `preset.json` — metadata (`{ id, name, description, icon? }`)
- `agent.md` — per-workspace instructions injected each turn
- `.skills/` — optional per-workspace private skills

Presets are fetched from the remote content hub and cached locally under `<dataDir>/preset-cache/`. Bundled presets ship in `apps/inno-agent/presets/` (lesson-plan, ppt-creation, scenario-explain) and serve as an offline fallback. Opening a preset instantiates it as a fresh editable workspace.

### Storage layer (`src/storage/`)

`file-store.ts` is the general-purpose JSON file persistence layer. Used by multiple subsystems (jobs, wiki manifest) as a thin typed wrapper over `readFileSync`/`writeFileSync` with atomic writes.

### Memory system

Two layers, both file-backed under `dataDir` (there is no learner-profile layer; the former L1 was removed, and an old `learner/` directory is simply no longer read):

- **L2 wiki memory** (`src/memory/l2/`): a structured wiki behind the async `L2Backend` interface (`l2-backend.ts`) — all reads/writes are backend-relative paths, so the pipeline (tools, routes, lint, graph, overview, indexer) is storage-agnostic. Local mode uses `FileL2Backend` (files under `l2/` + SQLite FTS5 index in `index.db` via `l2-index-store.ts`); authenticated mode mounts `PgL2Backend` (`pg-l2-backend.ts`) per tenant dir through a resolver registered in `server.ts`: text (wiki pages, extracted text, manifest, logs) → `l2_files`/`l2_manifest` tables, binary originals (PDF/Word/images) → the platform `ObjectStore` with metadata in `l2_objects`, and the retrieval index → `l2_pages` searched with ParadeDB BM25 using the same `segmentForFts` CJK-bigram scheme as L3. A tenant's legacy local `l2/` dir is imported once on first access and renamed `l2.migrated` (the derived index is rebuilt, not imported). Wiki ops: `wiki-maintainer.ts` (frontmatter), `wiki-linker.ts`, `wiki-links.ts`, `wiki-query.ts`, `wiki-graph.ts` (knowledge graph with `graphology` + community detection via `graphology-communities-louvain`). Search/indexing: `l2-indexer.ts`, `l2-search.ts`, `l2-memory.ts`. Manifest/raw stores: `manifest-store.ts`, `raw-store.ts`, `source-converter.ts`, `wiki-page-files.ts`. Agent interface: `l2-tools.ts`. Also: `summarizer.ts`, `wiki-generator.ts`, `wiki-page-merge.ts` (LLM-written pages; currently unreachable because durable archives are deterministic), `document-parser.ts` (PDF, Office, images), `overview.ts`. Exposed to both agent tools and web UI via `/api/wiki/*`.
- **L3 cross-conversation recall** (`src/memory/l3/`): indexes the projected history of durable sessions behind the async `L3Backend` interface (`l3-backend.ts`). Local mode uses SQLite (`node:sqlite`) with FTS5 (`sqlite-store.ts`, wrapped by `SqliteL3Backend`; degrades gracefully on Node <22.5, where L3 recall is simply disabled). Authenticated mode uses PostgreSQL (`pg-l3-backend.ts`, tables `l3_chunks`/`l3_index_state`, every statement filtered by the verified tenant) searched with ParadeDB BM25 (`pg_search`): text is segmented with the same CJK-bigram `segmentForFts` and stored in a `tokens` column indexed with the whitespace tokenizer, so both backends tokenize and rank the same way. `ScopedL3Memory(dataDir, pool)` picks the backend per request; the PostgreSQL index is derived data and is rebuilt lazily per session (no import of old `l3/memory.db` files), and deleting a session removes its chunks. `indexer.ts` turns committed messages into chunks (incremental by entry revision; chunks and state replaced in one transaction). `recall.ts` performs threshold-gated retrieval (`l3_recall` tool).

### Scheduler

`src/scheduler/` implements cron-driven background jobs. `JobStore`/`CheckInStore` are abstract stores: `PgJobStore` keeps jobs in `tenant_jobs` and run history in `tenant_job_runs`, `PgCheckInStore` keeps plans in `tenant_checkins`/`tenant_checkin_occurrences` (all scoped by ambient tenant); `FileJobStore`/`FileCheckInStore` remain only for unit tests. `CronScheduler` (uses `cron-parser`) triggers `job-runner.executeJob`. In authenticated mode, `TenantCronScheduler` enumerates job owners from PostgreSQL, restores tenant ALS for every tick, and uses owner-token-fenced `job_run_claims` leases with heartbeat renewal so cron, deferred execution, and manual occurrence takeovers cannot run the same slot concurrently. Expired leases permit at-least-once crash recovery; completion remains in the job/check-in ledgers, and external side effects are not exactly-once. Every tenant automatic run creates and claims an explicit scheduler session/workspace rather than using the shared active session. Deferred countdowns are keyed by tenant, restore captured ALS on execution, and release leases on cancellation/shutdown; their visible pending list is process-local, not a cross-process durable queue. Every agent run (cron, deferred or manual) executes in a durable session — scheduled runs create their own scheduler-origin session — through the `durableExecutor` injected into `executeJob`, which keeps occurrence/check-in/ledger/channel semantics. Reminder tasks (`push_reminder`, `check_in_reminder`) are not agent runs: their text is recorded in the run's session as an assistant notice (`notifyOnly`) and pushed to the channel. PostgreSQL `durableClaims` remains occurrence-lease terminology, separate from pi-durable. Manual runs always create their own conversation (scheduler-born session badge) and stream agent events into it. `src/checkins/` adds the learning check-in layer: `CheckInStore` derives today's plan from learning jobs (`checkins.json` + `occurrences.json`), successful learning-job runs automatically fulfill their scheduled slot, and `GET /api/checkins/today` exposes it to the web UI (read-only by design — check-ins derive from job runs) (打卡卡片 in the jobs panel). Scheduled learning runs leave a visible trace for the user: a short completion/failure notice is pushed best-effort through the first registered default channel (feishu → wechat → qq). Jobs can also be invoked manually via `/api/jobs/:id/run` or from the agent itself via the `run_scheduled_job` tool (which gives the run a durable session of its own). On boot, `normalizePersistedJobs` backfills `nextRunAt`/`lastStatus`/`runCount` fields, and `migrateReminderChannels` repoints legacy `push_reminder` jobs to the registered default Feishu target.

### Channels

`src/channels/` defines a `ChannelRegistry` and registers channels when their respective config blocks are present:

- **Feishu** (`feishu/feishu-channel.ts`): native Lark/Feishu integration via `@larksuiteoapi/node-sdk`.
- **QQ** and **WeChat** (`bridge/bridge-channel.ts`): bridge/sidecar mode — the agent communicates with an external sidecar process over HTTP, which handles the actual IM protocol. Each has a `sidecarBaseUrl` in config. Inbound messages arrive via `bridge/bridge-server.ts`, a local HTTP server that receives callbacks from sidecars.
- **WeChat iLink** (`wechat/ilink-client.ts`): alternative non-bridge WeChat mode using iLink protocol instead of a sidecar. Supports QR code login (`POST /api/channels/wechat/qr-login`, `GET /api/channels/wechat/qr-status`).
- `personal-dispatcher.ts` pushes reminders and messages back out through registered channels.
- `channel-tools.ts` exposes agent tools (`send_file_to_channel`, etc.) for interacting with channels.
- `dedupe-store.ts` prevents duplicate message delivery; `run-log.ts` tracks channel operation outcomes.

`tenant-channel-manager.ts` is a `ChannelRegistry` facade that lazily resolves a per-tenant registry/dispatcher from verified ALS context; channel ledgers (default targets, dedupe, run log, chat-session bindings, WeChat iLink token) persist through `TenantJsonLedger` write-through adapters into `tenant_state` (see `tenants/state-store.ts`). External connection ownership is claimed as `bridge:<sha256(token)>`, `feishu:<appId>`, or `wechat:<botId>`; public bridge callbacks recover tenant context from PostgreSQL ownership rather than request-supplied identity, and native/QR-created callbacks explicitly restore tenant ALS. Default targets, dedupe, run logs, chat-session bindings, channel workspaces, and channel/topic session metadata are tenant-scoped. Inbound messages create/reuse durable catalog sessions (stale bindings to unknown sessions are replaced), prepare/persists inbound images through the same native-image and sidecar path as Web chat, and keeps question/permission handling `no_ui` even for streaming IM cards. Manual and automatic channel jobs use the current tenant's target; manual runs require an owned explicit session, while automatic runs create their own owned scheduler session.

### HTTP server (`src/server.ts`)

Plain Node `http.createServer` (no framework), ~1300 lines plus route domains extracted under `src/server/routes/` (chat, wiki, workspaces, skills, channels, jobs, checkins, sessions, settings, presets, btw). `chat` and `sessions` only validate and list/create; per-session behavior lives in `src/server/durable-routes.ts`. Optional Better Auth + PostgreSQL account authentication lives under `src/auth/` and is enforced before lazy bootstrap; `/api/session` is the frontend session probe (`durableEnabled` and `durableRequired` are always true). Personal tenant provisioning and resource ownership live under `src/tenants/`; sessions/workspaces plus their chat/file access paths enforce ownership, with per-tenant temporary workspaces in authenticated mode. Authenticated L2/L3 storage, jobs/check-ins, BTW sidecars, providers/default model, memory flags, Tavily, smart input and UI preferences use tenant-specific roots or per-tenant config files; authenticated prompts and side-channel completions resolve the tenant's own credentials. Authenticated shared-skill management is read-only (the shared skills directory is process-global); owned workspace-private skills remain available. Host shell/PTY execution does not exist in any mode (shell commands run only in the remote sandbox when it is enabled). Channels use per-tenant registries, dispatchers, external-connection ownership, `tenant_state` ledgers, and tenant-scoped manual/automatic delivery. File-backed runtimes are not cross-process active-active. Route domains are dispatched by URL prefix via `src/server/route-dispatch.ts` (a `/api/<domain>` lookup table built at startup; `/api/sessions` chains sessions → workspaces). Static files are served by `src/server/static-serve.ts` (async reads, Brotli/gzip sibling negotiation, hashed-asset cache headers). Every request gets an `x-request-id` response header and a one-line access log (info for `/api/*`, debug for static/health; finish/close deduped, SSE disconnects logged as `disconnected`). SIGTERM/SIGINT trigger a graceful shutdown (`createGracefulShutdownHandler` in `src/utils/process-fallback.ts`): the HTTP server, durable runtimes, channels and the auth database pool close, with a forced exit after 8 s. Key endpoints:
- `POST /api/chat/stream` — SSE streaming chat.
- `POST /api/chat` — non-streaming chat (full response).
- `GET /api/chat/events/:id` — SSE event replay for reconnecting to an in-progress turn (backed by the durable stream journal).
- `GET/PUT /api/wiki/*` — wiki CRUD, graph, stats.
- `GET/POST/PATCH/DELETE /api/jobs[/:id]` — job management; `POST /api/jobs/:id/run` and `POST /api/jobs/:id/run/stream` (SSE of the agent run: text/thinking/tool events) for manual execution into a chosen conversation; `POST /api/jobs/run/stop` aborts an in-flight manual run.
- `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id` — durable session listing/creation/detail; `PATCH` renames or (with `provider` + `modelId`) switches the session's model from its next message. Also `POST .../archive|unarchive|generate-topic|branch-before-message` (edit-and-resend: fork before a user message), `GET .../context-usage` and `GET .../export.md`.
- `GET /api/skills` — list loaded skills.
- `POST /api/btw/ask` — "顺便问问" side question: a stateless, tool-less completion through the session's own model over a read-only digest of recent messages; never enters the transcript. `POST /api/btw/bring-back` appends a confirmed Q/A pair to the session as an assistant notification.
- `POST /api/skills/upload` — accepts `<skill-name>.zip`, unpacks into `skillsDir/<name>/` via `spawnSync('unzip', ...)`.
- `GET/PUT /api/skills/:name/content` — read/write skill file content (skill editor).
- `GET /api/skills/:name/tree` — directory tree of a skill's files.
- `GET/PUT /api/skills/:name/file` — read/write individual files within a skill.
- `GET /api/skills/:name/raw` — read raw skill markdown content.
- `PATCH /api/skills/:name` — enable/disable a skill.
- `DELETE /api/skills/:name` — remove a skill.
- `POST /api/skills/reload` — kept for the skills panel; durable sessions read the skills directory when their runtime opens.
- `GET /api/skill-library` — list available skills from the remote content hub.
- `POST /api/skill-library/import` — import a skill from the remote hub into the local skills directory.
- `GET /api/presets` / `POST /api/presets/:id/open` — list and open preset workspaces.
- `GET /api/preset-library` — list available presets from the remote content hub.
- `GET/POST /api/workspaces[/:id]` — workspace CRUD.
- `GET /api/settings` — current config (redacted API keys). `POST /api/settings/model` sets the default model for new sessions.
- `PATCH /api/settings/content-hub` — update content hub config.
- `PATCH /api/settings/memory` — toggle L2/L3 memory.
- `PATCH /api/settings/theme` — persist UI theme preference.
- `GET /health` — health check (used by the container health checks and the nginx proxy).

Static frontend is served from `paths.webDistDir = apps/inno-agent/web/dist` when present. Skills are read from `paths.skillsDir` (defaults to `<home>/skills`).

### Workspace management (`src/workspace/`)

`workspace-registry.ts` manages multiple workspace directories. Each workspace has a `WorkspaceMeta` record (id, name, path, temp flag) persisted in `workspaces.json`. Sessions are bound to workspaces. The default workspace is the invocation CWD. Temp workspaces are auto-created for one-off tasks and cleaned up later.

### Document tools (`agent/document-tools.ts`)

Handles file uploads, workspace file reading, and document preview (CSV, Office formats). Uses `@llamaindex/liteparse` for document parsing. Works alongside the L2 wiki's `document-parser.ts` for ingestion into the knowledge base.

### Skills loading

Skills are Markdown files (`SKILL.md` with YAML frontmatter, or a loose `.md` carrying a `description`). Discovery lives in `agent/skills.ts` (`loadSkillsFromDir`, `formatSkillsForPrompt`). Each durable session's instructions list the enabled skills from `paths.skillsDir` (`<home>/skills`, honouring the `.ignore` file the skills panel writes for disabled skills) and from the workspace's private `.skills/`; the model loads a skill's file with its `read` tool. Instructions are rebuilt every time a session's runtime opens, so changes apply from a session's next open.

- The web UI lists skills via `GET /api/skills` and allows upload of `<skill-name>.zip` files via `POST /api/skills/upload` (unzips into the skills dir).
- A skill editor in the web UI supports full CRUD on skill files (tree view, file read/write, raw markdown editing).
- The Content Hub system (`contentHub` config) provides a remote skill library browsable and importable from the web UI.

### Web UI

React (with the Lit-based `pi-web-ui` components for file/Office previews). Mounts in `web/src/main.tsx` → `react/App.tsx`. State lives in framework-agnostic `stores/` (small `EventEmitter`-based stores: `chat-store`, `sessions-store`, `jobs-store`, `skills-store`, `settings-store`, `workspace-store`, `workspaces-store`, `notebook-store`, `theme-store`, `app-store`). Each store extends `EventEmitter` — components subscribe to change events and re-render on state mutation. REST/SSE calls go through `web/src/api/`. Some legacy Lit components remain under `components/`. Tailwind 4 via `@tailwindcss/vite`.

**Component convention**: Components are React (in `web/src/react/`); do not add Lit components. The only Lit code left comes from the `pi-web-ui` dependency.

**Store pattern**: Each store in `web/src/stores/` extends `EventEmitter` and manages a domain (chat, sessions, wiki, etc.). React components import the store singleton, read state snapshots, and subscribe to change events (typically via `useEffect` or a shared `hooks.ts`). All API calls happen through `web/src/api/client.ts`, a thin `fetch` wrapper that all domain-specific API modules (`api/chat.ts`, `api/wiki.ts`, `api/presets.ts`, `api/uploads.ts`, `api/workspace.ts`, `api/workspaces.ts`, etc.) use. Stores never call `fetch` directly — they go through the `api/` layer.

**Theme system**: Four themes (light, warm, ocean, innospark) defined in `web/src/themes.css` via CSS custom properties. Theme preference is persisted to both `localStorage` (`inno.theme`) and the backend (`PATCH /api/settings/theme`). Managed by `web/src/stores/theme-store.ts`.

Key UI dependencies: `cytoscape` + `cytoscape-cola` + `cytoscape-cose-bilkent` (wiki graph), `@uiw/react-codemirror` + 10+ `@codemirror/lang-*` packages (code editor), `@uiw/react-md-editor` (markdown editor), `motion` (animations), `lucide-react` (icons), `qrcode.react` (WeChat login QR), `react-arborist` (tree view), `highlight.js` (syntax highlighting), `@mariozechner/mini-lit` (mini Lit framework for legacy components).

**i18n**: The UI supports Chinese (`zh-CN`, default) and English (`en`), managed by `i18next` + `react-i18next` in `web/src/i18n/`. Locale is persisted to `localStorage` under `inno.locale`.

### Vite config (`web/vite.config.ts`)

The Vite config has three custom plugins and code-splitting:

- **`stubLmStudioPlugin`** — stubs out `@lmstudio/sdk` (a pi-web-ui dependency not used by inno-agent) to avoid bundling it.
- **`link-katex-fonts`** — creates a symlink `node_modules/@earendil-works/pi-web-ui/dist/fonts` → `node_modules/katex/dist/fonts` so Vite resolves KaTeX font URLs from pi-web-ui's built CSS.
- **`inno-dev-upload-api`** — Vite dev server middleware on `POST /api/l2/raw/upload` for L2 raw file uploads during development (proxies to the backend in production).
- **`manualChunks`** — code-splits `codemirror`, `markdown-editor`, `cytoscape`, and `katex` into separate bundles.

Vite dev server runs on port 5173 and proxies `/api` and `/health` to `http://127.0.0.1:3000` (IPv4 literal — `localhost` can resolve to `::1` on Windows while the backend listens on IPv4, turning every proxied call into a 502).

### Logger (`src/logger.ts`)

Pino-based logger with daily rotation to `<INNO_DATA_DIR>/log/server-YYYY-MM-DD.log`. Uses `pino-caller` to annotate each log entry with the TypeScript source location. The log directory and file are created lazily on the first write call (not at process startup). Log level is controlled via `LOG_LEVEL` env var (defaults to `"info"`). The `DailyRotateStream` custom `Writable` checks the date on each write and rotates to a new file when the day changes.

## Docker

### Production images (`deploy/Dockerfile.backend`, `deploy/Dockerfile.frontend`)

Deployment manifests live under `deploy/` (`Dockerfile.backend`, `Dockerfile.frontend`, `nginx.conf.template`, `docker-compose.yml`). The frontend and backend ship as two images: `Dockerfile.frontend` builds the Vite bundle and serves it with nginx, which reverse-proxies `/api` and `/health` (SSE-safe: no buffering, long timeouts, 200m uploads) to `BACKEND_URL` (default `http://inno-agent:3000`); `Dockerfile.backend` compiles only the TypeScript server (no `web/dist`, so it is API-only). Compose publishes only the frontend (`3000:80`); with auth enabled add the public origin to `INNO_TRUSTED_ORIGINS`. The backend image is a multi-stage build on `node:22-bookworm` (there is no custom base image):

- **Build stage**: installs build tools for native npm modules (python3, make, g++), configures Tsinghua mirrors, runs `npm ci` + the backend `tsc` build.
- **Runtime stage**: installs python3 (pptx→svg converter) and copies `dist/`, `scripts/` and the full `node_modules` (no pruning). Sets `NODE_ENV=production` and all `INNO_*` env vars for a production layout (`/etc/inno-agent` for config, `/var/lib/inno-agent` for data/skills, `/srv/inno-workspace` for workspace). Exposes port 3000.
- **`deploy/docker-compose.yml`**: `frontend` (nginx, host port 3000→80), `inno-agent` (backend, internal 3000), `postgres` (ParadeDB `paradedb/paradedb:v0.22.2-pg17` — the tenant schema and L2/L3 memory need `vector`/`pg_trgm`/`pg_search`; 127.0.0.1:5432), `minio` (pgsty/minio build of community MinIO, S3 API + console on 127.0.0.1:9000-9001) and `minio-init` (one-shot bucket creation reusing the backend image's `@aws-sdk/client-s3`). The backend wires `INNO_OBJECT_STORAGE_*` to MinIO: SDK calls use the internal `http://minio:9000` while `INNO_OBJECT_STORAGE_PUBLIC_ENDPOINT=http://localhost:9000` makes presigned URLs browser-reachable. Volume mounts for `runtime/config/`, `runtime/data/`, `runtime/skills/`, and `workspace/` (paths relative to `deploy/`; build context is the repo root). The backend loads the repo-root `.env` through an optional `env_file` (`../.env`); keys under `environment:` override it. Compose's own variable substitution reads `deploy/.env` (the project directory is the compose file's directory), not the root `.env`.
- **`.dockerignore`**: excludes `node_modules/`, `dist/`, `runtime/`, `workspace/`, `.env`, `.git`.

## Configuration

### User-facing config (`<configDir>/config.json`)

Template: `config.example.json` at repo root. Declares `defaultProvider`, `defaultModel`, a `providers` map (each with `baseUrl`, `api` ∈ {`openai-completions`, `anthropic-messages`}, `apiKey`, `models[]`), optional `server.port`, optional `channels.*` blocks, optional `bridge.token`, optional `contentHub`, `memory`, and `ui` sections. The server rewrites this file when the local user changes the default model via the UI (existing sessions keep the model pinned in their catalog record until switched individually). Authenticated tenants keep only their selections (default model, channel toggles/allow-lists, memory/ui) in the PostgreSQL `tenant_configs` row — read async on demand, never written to disk. A new tenant starts with no selection and picks a model from the server-managed catalog before prompting.

Model config supports `reasoning` (boolean), `input` (modality array, e.g. `["text", "image"]`), `contextWindow`, and `maxTokens` per model entry. Provider config supports `authHeader` (boolean) and `bypassProxy` (boolean) fields.

Full config.json structure (see `config.example.json`):
```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": { /* ... */ },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false, "personalOnly": true, "allowedUserIds": [] },
    "wechat": { "enabled": false, "mode": "bridge", "allowedUserIds": [], "sidecarBaseUrl": "http://127.0.0.1:4319" }
  },
  "bridge": { "token": "replace-me-with-a-secret" },
  "contentHub": {
    "type": "github",
    "owner": "Chloris-Blaxk",
    "repo": "inno-agent-hub",
    "ref": "main",
    "skillsPath": "skill-library",
    "presetsPath": "workspace-templates",
    "baseUrl": "",
    "token": ""
  },
  "memory": {
    "l2Enabled": true,
    "l3Enabled": true
  },
}
```

Note: parts of `ui` are not in `config.example.json` but are added at runtime by `normalizeConfig` defaults (`ui.theme: "light"`, `ui.mathSingleDollar: false`). QQ channel is supported in code via bridge but is not in the template config.

- `contentHub` configures the remote source for skills and presets. `type` is `"github"` or `"bundle"`. For `"bundle"`, set `baseUrl` to the self-hosted server URL. `token` is the GitHub PAT (for `"github"` type) or bundle auth token.
- `memory.l2Enabled` / `l3Enabled` individually gate each memory layer (a stale `l1Enabled` key in an old config is ignored and dropped on the next save).
- `ui.theme` persists the UI theme preference.
- `bridge.token` is the shared secret for bridge-mode IM channels (QQ, WeChat). `personalOnly` (p2p-only) and `allowedUserIds` (whitelist) are enforced by Feishu; WeChat iLink enforces `allowedUserIds` only (its `personalOnly` field was removed as inert); bridge-mode channels (QQ, WeChat bridge) enforce neither — filtering there is the sidecar's responsibility.

### Config manipulation

Centralized in `apps/inno-agent/src/config.ts`:
- `normalizeConfig` — fills missing top-level fields with sensible defaults, handles legacy migration (`openai` → `providers.openai-custom`). `allowEmptyProviders` is used only for new tenant configs; local startup still requires at least one provider/model.
- `normalizeContentHubConfig` — fills missing hub fields from built-in defaults.
- `normalizeMemoryConfig` — all three layers default to `true`.
- `saveConfig`, `setDefaultModel`, `upsertProvider`, `deleteProvider`, `deleteModel` — config mutation helpers. `deleteModel` has a last-model-per-provider safety guard.
- `getConfiguredPort` — resolves port from override > `INNO_PORT` env > config > 3000.

All config writes should go through these helpers rather than directly writing the JSON file.
