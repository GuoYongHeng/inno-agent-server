# Inno Agent Server

> **The multi-user server edition of [Inno Agent](https://github.com/hhyqhh/inno-agent).** It adds Better Auth + PostgreSQL personal tenants, independent Durable session concurrency, crash recovery, tenant-scoped state, and optional static worker routing.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/hhyqhh/inno-agent-server.svg)](https://github.com/hhyqhh/inno-agent-server/releases)

**English** | [简体中文](./README.zh-CN.md)

For the original project's personal-learning goals, layered-memory design, desktop app, research report, and screenshots, see **[Inno Agent](https://github.com/hhyqhh/inno-agent)**. This repository focuses on the server runtime and does not duplicate that introduction.

Start with the [multi-user Durable guide](./docs/MULTI_USER_DURABLE.md) for the refactor architecture, real-service acceptance results, and production limitations.

## Runtime boundaries

Inno Agent runs every conversation on one execution path, **pi-durable**:

- **Durable execution** — each conversation is an independent PostgreSQL-backed runtime (`ds_*`). Durable supports concurrent sessions, request-ID deduplication, crash resume, exact application SSE replay, workspace-contained file tools, replay-safe question/approval cards, session-level model switching, edit-and-resend of earlier messages, tenant-local memory and channel state, and durable scheduler/channel execution. The earlier global `AgentSession` runtime (CLI, bash terminal, MCP, subagents, OS sandbox) has been removed; old JSONL conversation history is not read.
- **Verified tenant isolation** — Better Auth + PostgreSQL provides personal tenants and resource ownership. Memory, workspaces, channels, and jobs use verified tenant roots; unauthenticated requests return 401 and cross-tenant resources return 404. There is no host shell or terminal in any mode; the agent reads and writes files only inside the session workspace.
- **Single-owner storage** — one durable storage has one owner. Optional static tenant-owner routing uses workers with independent RWO data roots; shared active-active SQLite/NFS, automatic failover, and network-partition fencing are not supported.
- **Honest recovery semantics** — committed state and application checkpoints recover work, but model calls, channel delivery, and some file mutations retain documented at-least-once crash windows.

- **Durable capacity harness.** `npm run benchmark:durable` measures independent-session concurrency, admission/turn/snapshot latency, SQLite probes, RSS, event-loop delay, and SIGKILL/reopen recovery using faux providers only. See [docs/DURABLE_CAPACITY.md](./docs/DURABLE_CAPACITY.md); it is not a production sizing guarantee.

See the [multi-user Durable guide](./docs/MULTI_USER_DURABLE.md) and [runtime contract](./docs/DURABLE_RUNTIME.md) for supported capabilities, configuration, verification, and production limitations.

## Features

- 👥 **Multi-user Durable server**
  - Better Auth + PostgreSQL personal tenants, independent session concurrency, tenant-scoped credentials and storage, crash recovery, SSE replay, and optional static worker routing. [Architecture and limits](./docs/MULTI_USER_DURABLE.md).
- 🧠 **Two-layer memory**
  - **L2 native wiki** — human-readable, agent-queryable pages with hybrid retrieval (lexical BM25 + knowledge graph), LLM-assisted summarization, and PDF/Office/image ingestion.
  - **L3 session recall** — session history indexed into SQLite (FTS5) with threshold-gated cross-conversation retrieval.
- ⏰ **Proactive scheduler** — cron jobs created in natural language, runnable from the agent, the UI, or the daemon.
- 💬 **Personal IM channels** — Feishu (native) plus WeChat (iLink QR login or bridge mode), with a unified dispatcher for reminders.
- 🎯 **Simple Mode + presets** — one-click preset workspaces (lesson plan, PPT creation, scenario explain) for non-technical users.
- 🧩 **Skill catalog + content hub** — platform skills live in object storage + PostgreSQL (`tenant_skills` enablement); browse a remote hub for discovery, publish with `npm run skills:publish`. Presets ship in the image (`presets.dir`).
- ✏️ **Conversation branch editing** — edit a previously sent message and regenerate from that point: the session continues in a fork that leaves the abandoned replies out of the visible history and the model context.
- 🔌 **Pluggable providers** — any `openai-completions` or `anthropic-messages` endpoint (Anthropic, OpenAI, DeepSeek, Ollama, local models); switch the model of a conversation at any time, from its next message.
- 🌍 **i18n & themes** — Chinese/English UI, four themes.

## Quick Start

### Option A — From source

```bash
git clone https://github.com/hhyqhh/inno-agent-server.git
cd inno-agent-server

npm install      # pulls the Pi SDK from npm
npm run build    # compiles backend + web

mkdir -p runtime/config runtime/skills workspace
cp config.example.json runtime/config/config.json
# Edit runtime/config/config.json and set providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Open **http://localhost:3000**. See **[QUICKSTART.md](./QUICKSTART.md)** (中文) for a 5-minute walkthrough with provider examples.

### Option B — Docker

```bash
docker compose -f deploy/docker-compose.yml up -d   # serves on :3000, mounts runtime/ and workspace/
```

## Run Modes

```bash
npm run server          # Web UI (API + built frontend on :3000)

# Dev: backend on :3000 + Vite HMR on :5173
npm run dev:server & npm run web:dev
```

`restart-dev.sh` orchestrates the dev lifecycle (build, start, stop, status, logs, smoke-test) — run `bash restart-dev.sh --help`.

### Multi-user Durable server

```bash
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000

npm run auth:migrate --workspace inno-agent
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

The operator seeds the provider catalog in `config.json`; each account only picks a default model from it in Settings (provider credentials, search keys, and channel endpoints are server-managed). This is a restricted controlled-deployment runtime, not an internet-facing account-security or production-capacity sign-off. See [Authentication](./docs/AUTHENTICATION.md) and the [multi-user Durable guide](./docs/MULTI_USER_DURABLE.md).

## Configuration

`runtime/config/config.json` (template: [`config.example.json`](./config.example.json)):

```json
{
  "defaultProvider": "innospark",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "innospark": {
      "baseUrl": "https://api.example.com",
      "api": "anthropic-messages",
      "apiKey": "replace-me",
      "models": [{ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }]
    }
  },
  "server": { "port": 3000 },
  "channels": {
    "feishu": { "enabled": false },
    "wechat": { "enabled": false, "mode": "ilink" }
  },
  "memory": { "l2Enabled": true, "l3Enabled": true },
  "ui": { "theme": "light" }
}
```

Each provider declares a `baseUrl`, an `api` (`openai-completions` or `anthropic-messages`), an `apiKey`, and a `models[]` list. Only immutable deployment fields (`server`, `sandbox`, `objectStorage`, `logging`, `presets`) must live in this file — mutable platform config (providers, channel credentials, Tavily, hub, memory/ui/scheduler defaults) is stored in the PostgreSQL `platform_config` row so every worker shares one copy; mutable keys still present in `config.json` act as a per-boot seed that overrides the stored copy. This file is the operator-managed catalog — tenants cannot edit providers through the API or UI; their default-model choice is stored per-tenant in PostgreSQL. Each conversation keeps the model it was started with until you switch it.

### Runtime paths

The server resolves paths through `apps/inno-agent/src/runtime.ts`. Precedence: **flag > env var > `~/.inno-agent/...`**.

| Flag | Env var | Default |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--skills` | `INNO_SKILLS_DIR` | `<home>/skills`（镜像 seed / 本地兜底；正式目录在对象存储 `platform/skills/…`） |
| `--workspace` | `INNO_WORKSPACE_DIR` | invocation CWD |
| `--port` | `INNO_PORT` | `3000` |

Preset templates: `presets.dir` in `config.json` (default `<code>/presets`).  
Platform skills: publish with `npm run skills:publish`; tenants enable/disable via the skills API (`tenant_skills`).

### Permissions

The agent has no shell and no host execution. Its file tools (`read`, `write`, `edit`) are confined to the conversation's workspace — path checks resolve symlinks, and delete/rename/append are refused. Writes and edits ask first: the web UI shows an approval card (allow once / allow for the conversation / deny), the decision is persisted so a crash or restart returns the same answer without a second card, and non-streaming or headless runs deny with `no_ui`. See [docs/PERMISSIONS.md](./docs/PERMISSIONS.md).

### Content Hub

**Platform skills** are stored in object storage under `platform/skills/<id>/<version>/` with rows in `skill_catalog`; each tenant enables skills in `tenant_skills`. Image `INNO_SKILLS_DIR` is seeded into the catalog on boot; operators publish updates with `npm run skills:publish` (needs `DATABASE_URL` + object storage). Platform skills are read/enable-only for tenants. **Tenant-uploaded skills** (Web UI upload or content-hub import) are stored under `tenants/<tenantId>/skills/<id>/<version>/`, visible only to their owning tenant (`skill_catalog.owner_tenant_id`), and fully editable/deletable by that owner — no shared local skills directory is ever written. The remote **content hub** (`contentHub` in `config.json`, default [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub)) is a browse index — tenant “import” only enables already-published catalog skills. Simple Mode presets are not part of the hub: they ship in the image via `presets.dir`.

## Architecture

Four layers: **user interfaces → authenticated application services → pi-durable agent runtime → tenant-scoped memory.**

```text
User Interfaces      Web UI (React) · Feishu · WeChat
        ↓
Application Layer    Better Auth · personal tenants · ownership · HTTP/SSE
                     Channels · scheduler · workspaces
        ↓
Agent Runtime        pi-durable (one PostgreSQL ds_* store per session)
(PI SDK, unmodified) Native tools: memory · documents · search · scheduler · channels
        ↓
Layered Memory       L2 wiki (text in PostgreSQL, binaries in object storage)
                     L3 session recall (PostgreSQL)
```

- **Agent core** — isolated `pi-durable` runtimes; tools use the native `(params, api, context)` ABI. The PI SDK kernel is not modified. See [docs/DURABLE_RUNTIME.md](./docs/DURABLE_RUNTIME.md).
- **Multi-user and recovery** — Better Auth + PostgreSQL verifies identity and ownership. Durable storage is PostgreSQL (`ds_*`), with request-ID deduplication, an SSE journal, and replay-safe question/approval recovery. One session has one owner at a time. See [docs/MULTI_USER_DURABLE.md](./docs/MULTI_USER_DURABLE.md).
- **Memory** — L2 (`src/memory/l2/`): structured wiki; page text in PostgreSQL, binary originals in object storage. L3 (`src/memory/l3/`): tenant-scoped PostgreSQL BM25 over committed durable history.
- **Scheduler** (`src/scheduler/`) — cron jobs in `tenant_jobs` / `tenant_job_runs`. Deferred countdowns are in-process timers. Every agent run executes in a durable session.
- **Channels** (`src/channels/`) — `ChannelRegistry` with Feishu, WeChat (iLink / bridge), and QQ (bridge).
- **HTTP server** (`src/server.ts`) — plain Node `http.createServer` with SSE chat streaming; route table in [`apps/inno-agent/README.md`](./apps/inno-agent/README.md).
- **Web UI** (`web/src/`) — React 19 + Tailwind 4. Framework-agnostic `EventEmitter` stores in `web/src/stores/`; REST/SSE calls in `web/src/api/`.

## Repository Layout

```text
apps/inno-agent/           Backend (HTTP server), TypeScript → dist/
apps/inno-agent/web/       Frontend (React 19 + Tailwind 4 + Vite)
apps/inno-agent/presets/   Bundled preset workspaces (offline fallback)
apps/showcase/             Static showcase viewer for recorded replay cases
scripts/content-hub-server/  Self-hosted Content Hub bundle service
runtime/                   Local runtime state (config, data, skills) — gitignored
workspace/                 Default agent working directory — gitignored
```

## Deployment

Typical production layout, separating code, config, data, and workspace:

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
# Object storage is REQUIRED (fs or s3 — the server refuses to boot without it):
INNO_OBJECT_STORAGE_PROVIDER=s3 \
INNO_OBJECT_STORAGE_ENDPOINT=... \
INNO_OBJECT_STORAGE_BUCKET=... \
INNO_OBJECT_STORAGE_ACCESS_KEY_ID=... \
INNO_OBJECT_STORAGE_SECRET_ACCESS_KEY=... \
npm run server
```

A [`deploy/Dockerfile.backend`](./deploy/Dockerfile.backend) (API), [`deploy/Dockerfile.frontend`](./deploy/Dockerfile.frontend) (nginx + web UI) and [`deploy/docker-compose.yml`](./deploy/docker-compose.yml) are provided as starting points; see [`docs/SYSTEM_DEPENDENCIES.md`](./docs/SYSTEM_DEPENDENCIES.md) for the full dependency reference. Better Auth + PostgreSQL setup, tenant isolation, and public-account limitations are in [`docs/AUTHENTICATION.md`](./docs/AUTHENTICATION.md). The Durable architecture, static worker routing, verification results, and single-owner deployment boundary are in [`docs/MULTI_USER_DURABLE.md`](./docs/MULTI_USER_DURABLE.md).

## Showcase Viewer

[`apps/showcase/`](./apps/showcase) is a standalone static site that replays recorded sessions through the product UI with a mock backend. Its case-export tooling read the removed JSONL session format, so new cases can no longer be exported from the product; the bundled cases still replay (`npm run showcase:dev`, see [apps/showcase/README.md](./apps/showcase/README.md)).

## Use Cases & Docs

- [Multi-user Durable architecture and verification](./docs/MULTI_USER_DURABLE.md) — refactor overview, tenant boundaries, recovery semantics, real-service acceptance, and production gaps.
- [Durable runtime contract](./docs/DURABLE_RUNTIME.md) — detailed storage, replay, tool, scheduler, and channel behavior.
- [Authentication and tenant isolation](./docs/AUTHENTICATION.md) — Better Auth setup, and account-security limits.
- [Skill Tutorial — Building a Workspace Agent](./docs/use-cases/skill-tutorial.md) — use `agent.md` and `.skills/` to build a custom learning agent scoped to a workspace.
- [QUICKSTART.md](./QUICKSTART.md) — 5-minute setup guide (中文).
- [apps/inno-agent/README.md](./apps/inno-agent/README.md) — backend API route table (中文).

## Contributing

Issues and PRs are welcome. Before opening a PR, run `npm test` and `npm run build`. Changes touching authentication, tenant ownership, or Durable recovery should also run `npm run test:integration` against real PostgreSQL. Keep changes focused, match the existing code style, and update docs when behavior changes.

## Community

Join the WeChat user group to ask questions, share use cases, and follow updates:

<p align="center">
  <img src="./docs/assets/wechat-community-qr-2026-10-24.jpg" alt="Inno Agent WeChat community group QR code" width="240" />
</p>

## License

[MIT](./LICENSE). This project depends on the Pi SDK (`@earendil-works/pi-*` packages by Mario Zechner), also MIT-licensed and consumed via npm.

## Citation

```bibtex
@misc{hao2026innoagent,
  author       = {Hao Hao, Ye Lu, Ruotong Yang, Yongheng Guo and Aimin Zhou},
  title        = {Inno Agent: An Open-Source Personal Learning Agent with Layered Memory, Educational Post-Training, and Local Deployment},
  year         = {2026},
  publisher    = {GitHub},
  journal      = {GitHub repository},
  howpublished = {\url{https://github.com/hhyqhh/inno-agent-server}}
}
```
