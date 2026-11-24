# Authentication and tenant isolation

Better Auth + PostgreSQL is the only runtime mode: every API request is authenticated and tenant-scoped, and the server refuses to boot without `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`. The former `INNO_AUTH_MODE`, `INNO_MULTI_USER_ENABLED`, and `INNO_ALLOW_UNAUTHENTICATED_NETWORK` switches are obsolete — setting them fails startup.

For the architecture and verification scope, see [MULTI_USER_DURABLE.md](./MULTI_USER_DURABLE.md).

## Configure Better Auth

Prepare PostgreSQL and run migrations explicitly:

```sh
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run auth:migrate --workspace inno-agent
```

The request path and normal server startup never create or alter tables. Startup fails if required auth configuration is missing, PostgreSQL is unavailable, or the schema has not been migrated. The reviewed Better Auth schema is pinned at `apps/inno-agent/src/db/better-auth-schema.sql`; `npm run auth:schema --workspace inno-agent` prints migration SQL for the configured database.

For local development, `docker compose -f deploy/docker-compose.yml up postgres` starts PostgreSQL. Do not reuse the example password or secret in a real deployment.

## Start the restricted multi-user runtime

```sh
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run build
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

There is only one agent runtime (Durable), so no separate "durable" switch exists. Under authentication:

- every session and agent job is Durable; an explicit `runtime: "legacy"` is rejected with `400`;
- channel inbound, manual agent jobs, and cron/deferred runs execute through Durable sessions owned by the tenant;
- the legacy JSONL history format is not read at all.

## Account and browser boundary

`INNO_AUTH_ALLOW_SIGNUP=false` disables public email/password registration while allowing existing users to sign in. Cookies are HttpOnly, same-origin browser credentials; the frontend does not store session tokens in local storage.

Cross-origin browser requests and terminal WebSockets are restricted to `BETTER_AUTH_URL` and optional comma-separated `INNO_TRUSTED_ORIGINS`.

`/health`, `/api/health`, `/api/auth/*`, and the independently bearer-authenticated `POST /api/bridge/messages` endpoint are public. Other APIs and terminal WebSockets require a valid session in Better Auth mode. Anonymous API access returns 401.

> Public registration is not internet-launch-ready by itself. Rate limiting, email verification, account recovery, and a production security review remain deployment work.

## Personal tenants and ownership

`auth:migrate` creates personal tenants, owner memberships, resource ownership, external-channel ownership, and job occurrence claims. Provisioning is transactional and safe under concurrent first requests.

Each account has one personal tenant. Tenant identity comes only from a verified server session/membership or PostgreSQL ownership; clients cannot select a tenant through a header or body field. Every resource has at most one owner. Owned-resource misses and cross-tenant access return 404 rather than disclosing existence.

Tenant state lives in PostgreSQL (`tenant_configs`, `tenant_state`, `durable_sessions`, `tenant_jobs`, L2/L3 tables). `<dataDir>/tenants/<id>/` only holds materialised copies — a config.json mirror for synchronous readers, workspace working copies backed by the object store, and transient downloads — and is fully rebuildable.

Provider credentials, the model catalog, Tavily keys, and channel endpoints/credentials are **server-managed**: they come from the deployment `config.json` and tenants cannot write them (`/api/settings/providers*` and `/api/settings/tavily` are gone; credential fields in `PUT /api/settings/channels` return 403). A tenant's config row only carries selections — default model, channel `enabled`/`allowedUserIds`, memory and UI flags. Feishu app credentials are the exception: QR registration binds a tenant's personal Feishu app. Process-global read-only skill and preset catalogs are shared deliberately; authenticated shared-skill mutation is disabled, while owned workspace-private skills remain available.

## Files from before the multi-user runtime

Existing global files (data, sessions, jobs) are never assigned to the first user who signs in, and the former `tenants:legacy` backfill command has been removed together with the legacy runtime. Global state stays hidden in authenticated mode; each tenant starts empty with its own temporary workspace. Old JSONL sessions are not converted into Durable sessions.

## Authenticated capability restrictions

Authenticated turns remove PI host `bash`, general host file tools, and PTY terminal access. Terminal creation/upgrades fail closed and the Web UI hides those controls. Retained custom path tools enforce canonical workspace containment and symlink checks. This is an application capability reduction, not a claim that arbitrary host execution is tenant-confined.

MCP, subagents, web-access, codemode, and computer-use are disabled in authenticated mode until their runtime/configuration can be tenant-scoped. Permission policy is managed `default`; tenants cannot switch a process-global `auto`/`yolo` policy. Durable workspace `write`/`edit` has its own replay-safe approval records.

Channel registries, targets, dedupe, logs, sessions, and delivery state are tenant-scoped (PostgreSQL `tenant_state`). The bridge token is operator-managed and shared, so public bridge callbacks recover the tenant from the claimed channel identity — the bound default-target chat (`channel-chat:<channel>:<chatId>`) or a whitelisted user (`channel-user:<channel>:<userId>`) — never from request-supplied tenant identity.

## Storage and worker boundary

PostgreSQL stores account, tenant, ownership, and occurrence-claim metadata plus all tenant ledgers (config, durable storage, memory, jobs, channel state). The data directory is scratch: workspace materialisations, config mirrors, and caches rebuild from PostgreSQL + object storage.

- One durable storage has one owner at a time. Never use active-active SQLite/JSONL/NFS replicas.
- Authenticated durable opens hold a per-session PostgreSQL advisory lock to reject accidental double-open. This is not network-partition-proof fencing.
- Optional static tenant-owner routing forwards authenticated JSON/SSE and verified public bridge callbacks to a worker with an independent data root. Every worker must use its own RWO storage.
- Ordered migration, automatic failover, and network-partition fencing are not implemented.
- A job occurrence lease is not a storage lock and does not make model calls or external channel delivery exactly-once.

See [DURABLE_RUNTIME.md](./DURABLE_RUNTIME.md) for the storage/recovery contract and static sharding configuration.

## Tests

`npm test` remains PostgreSQL-free. `npm run test:integration` requires a ParadeDB PostgreSQL 17 (the schema needs `pg_search`; plain PostgreSQL is not enough). Without configuration it starts a disposable `paradedb/paradedb` container through docker; in CI or an existing development environment, set `INNO_TEST_DATABASE_URL` to an administrative connection URL and the suite creates and drops its own temporary database. Schema changes are numbered migrations (`schema_migrations`), applied by `auth:migrate`. Missing or unusable PostgreSQL fails the suite explicitly rather than skipping it.
