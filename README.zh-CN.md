# Inno Agent Server

> **[Inno Agent](https://github.com/hhyqhh/inno-agent) 的多用户服务端版本。** 在原项目能力之上，加入 Better Auth + PostgreSQL personal tenant、独立 Durable 会话并发、崩溃恢复、租户级状态和可选静态 worker 路由。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](https://nodejs.org)
[![Release](https://img.shields.io/github/v/release/hhyqhh/inno-agent-server.svg)](https://github.com/hhyqhh/inno-agent-server/releases)

[English](./README.md) | **简体中文**

原项目的个人学习目标、分层记忆设计、桌面应用、技术报告和截图，请访问 **[Inno Agent 原项目](https://github.com/hhyqhh/inno-agent)**。本仓库聚焦服务端运行时，不再重复这些背景介绍。

多用户架构、真实服务验收结果和生产边界见[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)。

## 运行时边界

所有对话只有一条执行路径——**pi-durable**：

- **Durable 执行**——每个会话是独立的 PostgreSQL runtime（`ds_*`）。支持独立会话并发、request-ID 去重、崩溃恢复、连续 SSE 回放、可恢复的问题卡/审批、会话级换模型、编辑并重发历史消息，以及按租户隔离的记忆和渠道状态。早期的全局 `AgentSession` 运行时（CLI、bash 终端、MCP、子代理、系统级沙箱）已移除，旧的 JSONL 历史不再读取。
- **经验证的租户隔离**——Better Auth + PostgreSQL 提供 personal tenant 和资源所有权。记忆、工作区、频道和任务均使用 tenant 数据根（provider 目录与凭据由服务端统一托管）；未认证返回 401，跨租户资源返回 404。任何模式下都没有宿主 shell 或终端，agent 只能在会话工作区内读写文件。
- **单 owner 存储**——一个 durable storage 同时只有一个 owner。静态 tenant-owner 路由要求每个 worker 使用独立 RWO 数据根；不支持共享 SQLite/NFS active-active、自动 failover 或网络分区 fencing。
- **明确的恢复语义**——已提交状态和应用 checkpoint 可以恢复，但模型调用、频道投递和部分文件 mutation 仍有 at-least-once crash window。

架构、验证范围和剩余生产事项见[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)与 [Durable 运行时契约](./docs/DURABLE_RUNTIME.md)。

## 功能特性

- 👥 **多用户 Durable 服务**——Better Auth + PostgreSQL personal tenant、独立会话并发、租户级凭证与存储、崩溃恢复、SSE 回放和可选静态 worker 路由。

- 🧠 **两层记忆**
  - **L2 原生 wiki**——人类可读、agent 可查询的页面,混合检索(词法 BM25 + 知识图谱),LLM 辅助摘要,支持 PDF/Office/图片摄入。
  - **L3 会话检索**——会话历史索引进 SQLite(FTS5),按相关性阈值门控的跨对话召回。
- ⏰ **主动调度器**——自然语言创建 cron 任务,可从 agent、UI 或守护进程触发。
- 💬 **个人 IM 渠道**——飞书(原生)+ 微信(iLink 扫码登录或 bridge 模式),统一dispatcher 回推提醒。
- 🎯 **简单模式 + 预设**——面向非技术用户的一键预设工作区(教案、PPT 制作、情景讲解)。
- 🧩 **技能目录 + 内容中心**——平台技能在对象存储 + PostgreSQL（`tenant_skills` 启用）；可用远程 hub 浏览发现，用 `npm run skills:publish` 发布。预设随镜像打包（`presets.dir`）。
- ✏️ **对话分支编辑**——重新编辑已发送的纯文本 Web 消息，并从该节点重新生成后续对话；旧分支不会进入当前模型上下文。
- 🔌 **可插拔模型供应商**——任意 `openai-completions` 或 `anthropic-messages` 端点(Anthropic、OpenAI、DeepSeek、Ollama、本地模型),UI 内实时切换。
- 🌍 **国际化与主题**——中/英文界面,四套主题。

## 快速开始

### 方式 A —— 源码运行

```bash
git clone https://github.com/hhyqhh/inno-agent-server.git
cd inno-agent-server

npm install      # 从 npm 拉取 Pi SDK
npm run build    # 编译后端 + 前端

mkdir -p runtime/config runtime/skills workspace
cp config.example.json runtime/config/config.json
# 编辑 runtime/config/config.json,填入 providers[*].apiKey

npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

打开 **http://localhost:3000**。详细的 5 分钟上手指南(含各供应商配置示例)见 **[QUICKSTART.md](./QUICKSTART.md)**。

### 方式 B —— Docker

```bash
docker compose -f deploy/docker-compose.yml up -d   # 服务端口 3000,挂载 runtime/ 与 workspace/
```

## 运行模式

```bash
npm run server          # Web UI(API + 已构建前端,端口 3000)

# 开发模式:后端 :3000 + Vite 热更新 :5173
npm run dev:server & npm run web:dev
```

`restart-dev.sh` 编排完整开发生命周期(构建、启动、停止、状态、日志、冒烟测试)——运行 `bash restart-dev.sh --help` 查看。

### 多用户 Durable 服务

```bash
export DATABASE_URL=postgresql://inno:inno@127.0.0.1:5432/inno
export BETTER_AUTH_SECRET='replace-with-at-least-32-random-characters'
export BETTER_AUTH_URL=http://127.0.0.1:3000
# 多 worker / 重启后还要文件：INNO_OBJECT_STORAGE_PROVIDER=s3（或 fs）及对应 endpoint/bucket/key
# 本机执行 bash：INNO_EXEC_BACKEND=local

npm run auth:migrate --workspace inno-agent
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

Provider 目录由部署方在 `config.json` 中统一种子，账号只能在 Settings 中选择默认模型（provider 凭据、搜索 key、渠道端点均为服务端托管字段）。该模式面向受控部署，不代表公网账号安全或生产容量已经验收。完整边界见[认证与租户隔离](./docs/AUTHENTICATION.md)和[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)。

## 配置

`runtime/config/config.json`(模板:[`config.example.json`](./config.example.json)):

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

每个供应商声明 `baseUrl`、`api`(`openai-completions` 或 `anthropic-messages`)、`apiKey` 和 `models[]` 列表。此文件是服务端托管的模型目录——租户无法通过 API 或 UI 修改 provider，其默认模型选择按租户存于 PostgreSQL。

### 运行时路径

服务通过 `apps/inno-agent/src/runtime.ts` 解析路径。优先级:**命令行参数 > 环境变量 > `~/.inno-agent/...`**。

| 参数 | 环境变量 | 默认值 |
|---|---|---|
| `--home` | `INNO_HOME` | `~/.inno-agent` |
| `--config-dir` | `INNO_CONFIG_DIR` | `<home>/config` |
| `--skills` | `INNO_SKILLS_DIR` | `<home>/skills`（镜像 seed / 本地兜底；正式目录在对象存储 `platform/skills/…`） |
| `--workspace` | `INNO_WORKSPACE_DIR` | 调用时的工作目录 |
| `--port` | `INNO_PORT` | `3000` |

预设模板：`config.json` 的 `presets.dir`（默认 `<code>/presets`）。打开预设只建空工作区；`agent.md` 从镜像只读注入，`preset.json` 的 `skills` 绑定平台 catalog。  
平台技能：`npm run skills:publish` 发布；租户通过 skills API 启用/禁用（`tenant_skills`）。  
对象存储：不写进 `config.example.json`，用 `INNO_OBJECT_STORAGE_*`（见 `.env.example`）。未配置时是进程内 memory，不能跨 worker。

### 权限

agent 没有 shell，也没有宿主机执行能力。文件工具（`read`、`write`、`edit`）被限制在会话工作区内——路径检查会解析符号链接，删除、重命名、追加都被拒绝。写入和编辑需要先审批：Web UI 弹出审批卡片（仅此次 / 本会话允许 / 拒绝），决定会被持久化，崩溃或重启后返回同一个答案而不会再弹卡；非流式或无头运行以 `no_ui` 拒绝。详见 [docs/PERMISSIONS.md](./docs/PERMISSIONS.md)。

### 内容中心(Content Hub)

**平台技能**存放在对象存储 `platform/skills/<id>/<version>/`，元数据在 `skill_catalog`，租户启用关系在 `tenant_skills`。镜像内 `INNO_SKILLS_DIR` 会在启动时 seed 进目录；运维用 `npm run skills:publish` 发布更新（需 `DATABASE_URL` + 对象存储）。远程**内容中心**（`contentHub`，默认 [`Chloris-Blaxk/inno-agent-hub`](https://github.com/Chloris-Blaxk/inno-agent-hub)）主要用于浏览；租户「导入」只会启用**已经发布**到 catalog 的技能。简单模式预设不属于内容中心，由 `presets.dir` 配置。

## 架构

四层结构：**用户界面 → 认证与租户应用层 → pi-durable agent 运行时 → 分层记忆。**

```text
用户界面          Web UI (React) · 飞书 · 微信
        ↓
应用层            Better Auth · personal tenant · ownership · HTTP/SSE
                  渠道 · 调度器 · 工作区
        ↓
Agent 运行时      pi-durable（每个会话一份 PostgreSQL ds_* 存储）
(PI SDK,未修改)   原生工具：记忆 · 文档 · 搜索 · 调度 · 渠道
        ↓
分层记忆          L2 wiki（文本在 PG，二进制在对象存储）· L3 会话检索（PG）
```

- **Agent 核心**——独立的 `pi-durable` runtime；工具使用原生 `(params, api, context)` ABI。PI SDK 内核未修改。详见 [docs/DURABLE_RUNTIME.md](./docs/DURABLE_RUNTIME.md)。
- **多用户与恢复**——Better Auth + PostgreSQL 验证身份和所有权。Durable 存储是 PostgreSQL（`ds_*`），带 request-ID 去重、SSE journal、问题/审批恢复。同一会话同一时刻只有一个 owner。详见[多用户 Durable 指南](./docs/MULTI_USER_DURABLE.md)。
- **记忆**——L2（`src/memory/l2/`）：结构化 wiki，正文在 PostgreSQL，二进制原件在对象存储。L3（`src/memory/l3/`）：按租户的 PostgreSQL BM25 会话索引。
- **调度器**（`src/scheduler/`）——cron 在 `tenant_jobs` / `tenant_job_runs`。延迟倒计时是进程内定时器。每次 agent 运行都在 durable 会话中执行。
- **渠道**(`src/channels/`)——`ChannelRegistry`,支持飞书、微信(iLink / bridge)、QQ(bridge)。
- **HTTP 服务**(`src/server.ts`)——原生 Node `http.createServer`,SSE 流式对话;路由表见 [`apps/inno-agent/README.md`](./apps/inno-agent/README.md)。
- **Web UI**(`web/src/`)——React 19 + Tailwind 4。状态在框架无关的 `EventEmitter` stores(`web/src/stores/`),REST/SSE 调用在 `web/src/api/`。

## 仓库结构

```text
apps/inno-agent/           后端(HTTP 服务),TypeScript → dist/
apps/inno-agent/web/       前端(React 19 + Tailwind 4 + Vite)
apps/inno-agent/presets/   内置预设工作区(离线兜底)
scripts/content-hub-server/  自建内容中心 bundle 服务
runtime/                   本地运行时状态(配置、数据、技能)—— gitignored
workspace/                 默认 agent 工作目录 —— gitignored
```

## 部署

典型的生产布局,分离代码、配置、数据与工作区:

```bash
INNO_CONFIG_DIR=/etc/inno-agent \
INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
INNO_WORKSPACE_DIR=/srv/inno-workspace \
INNO_PORT=3000 \
npm run server
```

提供 [`deploy/Dockerfile.backend`](./deploy/Dockerfile.backend)（后端 API）、[`deploy/Dockerfile.frontend`](./deploy/Dockerfile.frontend)（nginx + 前端）与 [`deploy/docker-compose.yml`](./deploy/docker-compose.yml) 作为起点；完整依赖说明见 [`docs/SYSTEM_DEPENDENCIES.md`](./docs/SYSTEM_DEPENDENCIES.md)。Better Auth + PostgreSQL、租户隔离和公网账号限制见 [`docs/AUTHENTICATION.md`](./docs/AUTHENTICATION.md)；Durable 架构、静态 worker 路由、验收结果和单 owner 部署边界见 [`docs/MULTI_USER_DURABLE.md`](./docs/MULTI_USER_DURABLE.md)。

## 使用案例与文档

- [多用户 Durable 架构与验收](./docs/MULTI_USER_DURABLE.md)——重构目标、租户边界、恢复语义、真实服务验收和生产缺口。
- [Durable 运行时契约](./docs/DURABLE_RUNTIME.md)——存储、重放、工具、调度和频道实现细节。
- [认证与租户隔离](./docs/AUTHENTICATION.md)——Better Auth 配置和账号安全边界。
- [技能教程 —— 构建工作区 Agent](./docs/use-cases/skill-tutorial.md)——用 `agent.md` 和 `.skills/` 构建工作区范围的自定义学习 agent。
- [QUICKSTART.md](./QUICKSTART.md)——5 分钟上手指南。
- [apps/inno-agent/README.md](./apps/inno-agent/README.md)——后端 API 路由表。

## 贡献

欢迎 Issue 和 PR。提交 PR 前请运行 `npm test` 与 `npm run build`；涉及认证、租户所有权或 Durable 恢复的改动，还应使用真实 PostgreSQL 运行 `npm run test:integration`。保持改动聚焦，遵循现有代码风格，行为变更时同步更新文档。

## 社区

扫码加入微信用户群,提问、分享使用场景、关注更新:

<p align="center">
  <img src="./docs/assets/wechat-community-qr-2026-10-24.jpg" alt="Inno Agent 微信社区群二维码" width="240" />
</p>

## 许可证

[MIT](./LICENSE)。本项目依赖 Pi SDK(`@earendil-works/pi-*`,作者 Mario Zechner),同为 MIT 许可,经 npm 引入。

## 引用

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
