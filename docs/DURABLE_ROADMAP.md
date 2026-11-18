# Durable 总体路线图：收敛到单一运行时，再做生产化加固

状态：规划草案（待评审），不含代码改动。由原先两份文档合并而成：移除 legacy 的规划（原 `DURABLE_ONLY_PLAN.md`）和 durable 存储与执行层重构设计（原 `DURABLE_REFACTOR_PLAN.md`）。依据是对 `apps/inno-agent/src` 的只读盘点，以及 pi-durable 1.4.0 的类型声明和 README，**没有运行过构建和测试**。标注"待验证"的条目未经确认。

## 1. 总览

两件事、两条线，有明确的先后顺序：

| 线 | 目标 | 阶段 |
|---|---|---|
| **收敛线** | 删除 `pi-coding-agent` legacy 路径，只保留 pi-durable | S1 – S5 |
| **加固线** | 让 durable 可生产上线：状态进 PG、执行层隔离、可故障转移 | H0 – H4 |

**先收敛，后加固。** 删掉 legacy 后，要迁移到 PG 和沙箱的路径只剩一套，会话目录、记忆工具和执行环境不必维护两份实现。H0（基线测试）与 S1 可并行；H1 起依赖收敛线完成。

```
S1 对齐 → S2 解耦共享代码 → S3 切换入口 → S4 物理删除 → S5 收尾
   H0 基线（可与 S1 并行）→ H1 会话目录入 PG → H2 执行层隔离 → H3 状态迁出本地文件 → H4 PG Storage + 租约路由
```

## 2. 背景与现状

**durable 的正确性设计较扎实**：请求 ID 去重、SSE 重放、question/permission 持久化、SIGKILL 恢复都有测试覆盖。问题是**状态与执行都绑定在单台机器的本地磁盘上**，且仓库同时背着两套运行时。

### 2.1 加固线的问题（带证据）

| 问题 | 位置 | 后果 |
|---|---|---|
| 会话目录是租户目录下的整文件 `sessions.json`，每次更新整文件读-改-写 | `durable-session-service.ts` `catalog()` / `writeCatalog()` / `update()`；`storage/file-store.ts` `writeJson` | 写放大 O(会话数)；靠同进程同步执行加"同租户固定路由到一个 worker"避免丢更新；原子 rename 只防损坏，不防并发覆盖 |
| 会话数据是每会话一个本地 `session.sqlite` | `durable-session-service.ts`；`durable-runtime.ts` 单所有者守卫 | 数据绑定节点磁盘；节点故障即会话不可用 |
| 单所有者只有进程内 `Set` 加 PG advisory lock | `durable-runtime.ts` `openStoragePaths`；`acquireDurableStorageLock` | 文档自述"不是抗网络分区的存储围栏"；无故障转移 |
| 租户到 worker 是静态哈希映射 | `tenants/durable-tenant-router.ts` | 不能动态扩缩容 |
| 状态散落四处且无跨存储事务 | PG、`sessions.json`、`session.sqlite`、流日志/question/permission 文件 | 创建/删除会话失败时 PG 归属行与目录项之间可能留孤儿（待验证） |
| 文件工具直接落宿主文件系统 | `durable-env.ts` `WorkspaceFileEnv extends NodeExecutionEnv` | 隔离只有应用层路径检查；检查与使用之间的符号链接竞态未验证 |
| 记忆/OCR/发件箱直接读写本地文件 | `durable-memory.ts`、`durable-ocr.ts`、`durable-channels.ts` | 同上，且不经过 `ExecutionEnv` 接缝 |
| 所有记忆工具被统一标 `replay: "safe"` | `durable-memory.ts` 末尾 | 标记靠各工具自觉保证幂等，无机制强制 |

### 2.2 收敛线的影响面

**17 个非测试文件直接依赖 `@earendil-works/pi-coding-agent`：**

| 类别 | 文件 | 处理 |
|---|---|---|
| legacy 运行时 | `agent/pi-runner.ts`（~1935 行）、`inno-extension.ts`（~825）、`observability-extension.ts`（~392）、`mcp-extension.ts`、`cli.ts` | 删除 |
| 共享，被 durable 复用 | `document-tools.ts`、`practice-tools.ts`、`tavily-tools.ts`、`scheduler/scheduler-tools.ts`、`legacy-tool-adapter.ts` | 改为直接产出 pi-durable 的 `ToolRegistration`，删除适配层；`practice-tools` 随终端删除 |
| 技能加载 | `workspace-context.ts`（`loadSkillsFromDir`、`formatSkillsForPrompt`）、`routes/chat.ts` | 用已有的 `server/skill-frontmatter.ts` 加自写的小型加载/格式化替代 |
| L2 后台 LLM 调用 | `memory/l2/` 的 `summarizer`、`wiki-generator`、`wiki-linker`、`wiki-page-merge`、`overview`（参数类型是 legacy 的 `ModelRegistry`） | 改为接收 `durable-models.ts` 的 `Models`，或一个只含 `complete` 的窄接口 |
| 上下文用量 | `context-usage.ts` | 基于 durable 快照估算，或自写估算函数 |
| 路由 | `routes/chat.ts`（~1007 行，含大量 legacy 分支） | 删除 legacy 分支 |

**legacy 运行时的调用点**（都要切到 durable）：`server.ts`（启动 `initSession`、话题生成、渠道 `createNewSession`）、`routes/sessions.ts`、`routes/settings.ts`（`switchModel`）、`routes/btw.ts`、`scheduler/job-runner.ts`、`channels/personal-dispatcher.ts`。

## 3. 已确认的范围决定

| 议题 | 决定 |
|---|---|
| CLI（`cli.ts`，PI `main()` 终端界面） | 删除，并移除 `package.json` 的 `bin: inno` |
| 只有 legacy 具备的能力 | 先删除；第一版只保留 durable 已支持的 `read`/`write`/`edit` 和记忆、OCR、渠道、question、permission 工具；其余按需在 durable 上重建，作为后续独立事项 |
| 已有 legacy JSONL 会话历史 | 丢弃：代码不再读取，不迁移；**不由代码自动删除用户文件**，只在发布说明里告知可手动清理 |

**将失去的能力**：bash 与 Practice Lab 终端（含 `node-pty`）、权限系统插件的 `ask` 策略与三种模式、pi-sandbox、MCP、subagents、web-access、codemode、computer-use、todo、斜杠命令面板、全部 CLI。Tavily 的 `web_search` 是 Inno 自己的工具，保留。

**非目标**：改动 PI SDK 内核；追求外部副作用的 exactly-once（渠道发送、OCR 提交继续按 at-least-once 设计）。

## 4. 目标状态

- 只有一个运行时：pi-durable。本地/桌面与多用户共用同一执行路径，区别只在认证、租户根目录和 PG 支撑的所有权检查。
- `INNO_DURABLE_ENABLED` 不再是开关；`runtime: "durable"` 请求字段、`durableRequired`、`durable_required` 409、legacy 会话 ID 判断全部删除。
- 移除依赖：`pi-coding-agent`、`pi-sandbox`、`pi-subagents`、`pi-mcp-adapter`、`pi-web-access`、`@gotgenes/pi-permission-system`、`@injaneity/pi-computer-use`、`@juicesharp/rpiv-todo`、`@juicesharp/rpiv-ask-user-question`、`node-pty`；`@earendil-works/pi-web-ui` 在 web 端的使用范围需先核对，决定能否一并移除 root 里的旧版 `pi-ai`。
- Docker/Electron：`Dockerfile.base` 的 `bubblewrap`、`socat` 可移除；`scripts/after-pack.cjs` 和 `build.asarUnpack` 里 `node-pty` 相关条目可移除；`restart-dev.sh` 的 `--sandbox` 移除。
- 加固完成后：任一 worker 可接管任一会话，状态进 PG（加对象存储），执行在沙箱中。

## 5. 设计原则

- **每个阶段结束时都能 `npm run build`、`npm test` 通过**，阶段之间可单独合并；先让 durable 成为唯一入口，最后才物理删除 legacy。
- **先加测试和度量，再动存储。**
- **PostgreSQL 已是依赖，优先复用**，不引入新的有状态组件，除非阶段内明确论证。
- **双写、回填、开关、回滚**：每个迁移阶段按"双写 → 回填 → 读切换 → 停止旧写"推进，旧存储保留到下一阶段验收后再删。
- **租户隔离在数据层强制**：新增表一律带 `tenant_id`，查询经统一的租户作用域层。

## 6. 收敛线（S1 – S5）

### S1 前置对齐（只读验证）

1. 在干净分支跑基线：`npm run build`、`npm test`、`npm run test:integration`，记录通过数，作为后续比较基准（尚未跑过）。
2. 列出"本地模式使用 durable"的功能缺口清单，逐项确认 durable 已覆盖：会话列表/详情/重命名/归档/删除、SSE 重放、话题生成、模型切换、附件与内联图片、技能加载（全局目录加工作区 `.skills`）、`agent.md`、调度任务与手动运行、渠道入站、BTW、上下文用量、Wiki 与上传。缺口在 S3 前补齐，或明确写入"已知丢失"。
3. 确认本地模式无 PG 时 durable 的所有权/目录行为完整可用。
4. 用 `npm ls @earendil-works/pi-coding-agent` 核对依赖树，确认没有第三方间接依赖。

### S2 让共享代码脱离 pi-coding-agent（行为不变）

legacy 与 durable 此时仍并存：

1. 工具统一产出 `ToolRegistration`；删除 `legacy-tool-adapter.ts`。
2. 自写技能加载与提示格式化，先对照现有行为写测试，再替换 `workspace-context.ts` 与 `chat.ts`。
3. L2 的 LLM 调用改为接收窄接口 `CompleteFn`，由 durable 的 `Models` 实现；legacy 此阶段传自己的实现。
4. `context-usage` 的估算函数自写。

**退出标准**：除 `pi-runner.ts`、`inno-extension.ts`、`observability-extension.ts`、`mcp-extension.ts`、`cli.ts` 外，没有文件再 import `pi-coding-agent`。

### S3 所有入口切到 durable，legacy 变成不可达

1. 会话创建默认且仅为 durable；`POST /api/sessions` 忽略/拒绝 `runtime` 字段。
2. 聊天、取消、状态、事件重放：删除 `chat.ts` 的 legacy 分支。
3. 调度：`job-runner` 仅保留 durable（`durable-job-runner.ts`）；本地与多租户调度共用路径。
4. 渠道：本地模式的 `PersonalDispatcher` 也走 durable。
5. BTW、话题生成、模型切换、上下文用量改为 durable 实现；`settings.ts` 的 `switchModel` 改为只更新配置，由下一轮读取。
6. 删除启动时 `initSession` 和"全局活动会话"概念，并同步前端依赖。

**退出标准（合并门槛）**：把 `pi-runner.ts` 临时改为 `throw` 后，全部单元和集成测试仍通过，证明没有路径还在用它。

### S4 物理删除 legacy 与失去的能力

后端：

- 运行时：`pi-runner.ts`、`inno-extension.ts`、`observability-extension.ts`、`mcp-extension.ts`、`question-bridge.ts`、`permission-bridge.ts`、`permission-system-config.ts`、`web-access-config.ts`、`provider-sync.ts`（核对是否仍被 durable 使用）、`cli.ts`。
- 终端与实践：`terminal/`、`routes/practice.ts`、`practice-tools.ts`、`/api/terminal` WebSocket 升级与分发项。
- 路由与设置：`/api/mcp`、`PUT /api/settings/{permissions,computer-use,codemode,web-access}`、`/api/commands` 及存储。
- 配置：`config.ts` 里 `plugins.*`、`mcp`、`subagents`，及 `config.example.json`；`runtime.ts` 里 `PI_CODING_AGENT_*` 导出。
- 历史数据：`tenants/legacy.ts`、`tenants/migrate-legacy.ts` 与 legacy 集成测试；L3 `indexer.ts` 读取 PI 会话 JSONL 的路径（只保留 durable 快照索引）；`routes/sessions.ts` 枚举 JSONL 的逻辑。

前端（`apps/inno-agent/web/src`）：`stores/terminal-store.ts`、`stores/mcp-store.ts`、`react/terminal/`、设置页的 MCP/权限模式/computer-use/codemode/web-access 区块、斜杠命令面板、Practice Lab 与 Run 控件。保留 `QuestionDialog` / `PermissionDialog`（durable 仍使用）。

**退出标准**：`grep -r "pi-coding-agent" apps/` 无结果；构建与全部测试通过。

### S5 依赖、打包、文档收尾

- 移除第 4 节所列依赖并重新生成 lockfile；清理 `web-access-config` 里的 jiti alias 与 root 旧版 `pi-ai`（核对后）。
- 清理 Docker、Electron、`restart-dev.sh`、`.env.example` 中的沙箱与终端项。
- 重写 `CLAUDE.md`（Agent core、Durable、Sandbox、Terminal、Skills、MCP 等节），并更新 README、QUICKSTART、`docs/DURABLE_RUNTIME.md`、`docs/MULTI_USER_DURABLE.md`、`docs/PERMISSIONS_AND_SANDBOX.md`；测试数量、`server.ts` 行数等结构性事实按实际结果更新。
- 发布说明：列出被移除的能力、旧会话历史不再可见，以及可手动清理的目录。

## 7. 加固线（H0 – H4）

周数为粗略估算，H0、H1 完成后重估。

### H0 基线与安全网（约 1–2 周，可与 S1 并行）

不改架构，只补验证能力：

- 创建/删除/改名会话的**故障注入测试**：在 PG 归属写入与目录写入之间、目录写入与 `session.sqlite` 创建之间分别模拟崩溃，确认是否留孤儿，并写自检/修复脚本。
- 目录并发测试：同租户并发 create/update/rename 的丢更新测试，确认"同步加固定路由"假设在哪些路径失效。
- 符号链接竞态测试：`WorkspaceFileEnv` 检查后替换为指向工作区外的链接，确认是否可逃逸。
- 指标：会话数 vs `sessions.json` 读写耗时；每租户磁盘占用；advisory lock 获取/丢失次数。
- 复核 `replay: "safe"`：逐个列出被标记的工具并写明幂等依据（操作标记、内容哈希、天然幂等），缺依据的改为非安全或补实现。pi-durable 对非 safe 工具崩溃后的行为是返回 `interrupted` 错误结果而不重跑，所以误标 safe 的风险是重复副作用，漏标的代价只是该次调用失败，应偏向保守。

**退出标准**：上述测试进入 CI；产出已知问题清单和容量基线。

### H1 会话目录迁移到 PostgreSQL（约 2–3 周，依赖 S3）

归属与目录在同一事务内。表设计草案（字段以 `DurableSessionRecord` 为准）：

```sql
CREATE TABLE durable_sessions (
  id            text PRIMARY KEY,                       -- durable-<uuid>
  tenant_id     text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  provider      text NOT NULL,
  model_id      text NOT NULL,
  origin        text NOT NULL CHECK (origin IN ('web','scheduler')),
  archived      boolean NOT NULL DEFAULT false,
  message_count integer NOT NULL DEFAULT 0,
  preview       text NOT NULL DEFAULT '',
  version       integer NOT NULL DEFAULT 0,             -- 乐观并发
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX durable_sessions_tenant_updated_idx
  ON durable_sessions (tenant_id, updated_at DESC);
```

- 创建会话：同一事务写 `resource_ownership` 与 `durable_sessions`；`session.sqlite` 在提交后惰性创建，失败可重试且不留脏目录项。
- 更新使用 `UPDATE ... WHERE id=$1 AND tenant_id=$2` 加 `version` 检查，替代整文件覆盖。
- 迁移：启动时按租户把 `sessions.json` 幂等回填到表；上线期间双写；读切换由开关控制；旧文件保留一个版本周期。
- 本地/桌面模式没有 PG：通过 `SessionCatalog` 接口隔离，本地继续用 JSON 或 SQLite 目录实现，多用户用 PG 实现。收敛线完成后本地与多用户共用同一 durable 路径，所以该接口必须同时服务两种实现。

**退出标准**：H0 的目录并发和孤儿测试在新实现上通过；10 万会话量级下列表/更新耗时有基线数据。

### H2 执行层隔离（约 3–5 周）

`WorkspaceFileEnv` 已实现 pi-durable 的 `ExecutionEnv`。pi-durable 的 `env` 是**每次工具调用时的工厂**（`env: ({ cwd }) => ...`），自定义环境用 `id` 标识"同一套文件"，README 约定一个容器对应一个 id；README 还提到 pi-env 的 `RemoteExecutionEnv` 可作起点（是否随依赖安装、是否满足租户隔离，待验证）。包内带 `registerEnvConformance`（可选 `shell` / `symlinks` / `listFiles`）可直接验证新环境。

- 2a 抽出 `ExecutionEnv` 工厂，使 `durable-runtime.ts` 不直接构造 `WorkspaceFileEnv`；本地实现作为默认，行为不变。
- 2b 实现 `SandboxedExecutionEnv`：每租户（或每会话）一个受限沙箱（容器加 gVisor/Firecracker 之一，选型待评审），工作区经租户级卷挂载；env 方法转为沙箱服务调用；路径包含检查下沉到内核级挂载边界。
- 2c 沙箱内才考虑开放 shell：默认关闭，经权限 `ask`，保持 deny floor；CPU、内存、时间、网络出口在沙箱层限额。**这也是被收敛线移除的 bash 的重建位置。**
- 回放语义：README 写明工具调用先提交意图再执行，崩溃后只有声明 `replay: "safe"` 的工具会重跑，否则模型收到 `interrupted`。pi-durable 内置 `read`/`write`/`edit`/`bash` 源码里没有任何 `replay` 声明，所以它们崩溃后不重跑，这是 `write`/`edit` 的安全默认，远程实现保持这一语义，不要擅自标 safe；远程调用仍带稳定 tool-call ID 作幂等键。

**退出标准**：`durable-env.test.ts` 加官方 `registerEnvConformance` 对本地与沙箱实现都通过；符号链接逃逸测试在沙箱下无法逃逸；沙箱服务宕机时工具调用 fail-closed 并可重试，不破坏会话。

### H3 记忆、OCR、发件箱、恢复记录迁出本地文件（约 4–6 周）

按风险从低到高分批，每批独立开关：

1. **恢复类记录**（question、permission、流日志、OCR 检查点、渠道发件箱）→ PG 表。幂等键变成唯一约束，如 `UNIQUE (session_id, tool_call_id)`，取代文件里的操作标记，最能提升 `replay: safe` 的可信度。
2. **L1 画像与事件** → PG（`tenant_id` 作用域，事件追加表加画像 JSONB 加版本号）。
3. **L2 wiki**：元数据/manifest 进 PG，大文件正文进对象存储；`wiki-graph` 与搜索索引由派生任务重建。
4. **L3 召回**：当前是每租户 `node:sqlite` 加 FTS5；迁 PG（`tsvector`/`pg_trgm`），或保留 SQLite 作为可重建缓存、以 PG 为准。先评估召回质量差异（待验证）。

**退出标准**：worker 重启或迁移不丢任何租户状态；任一租户目录整体删除后，能从 PG 加对象存储重建全部非缓存状态。

### H4 PG 版 `Storage` 与租约路由（约 3–6 周，依赖 H1–H3）

**已确认（pi-durable 1.4.0）**：`Storage` 是公开接口，`Harness.open(storage, ...)` 接受任意实现；包内已有 memory、jsonl、indexeddb、sqlite（node / cloudflare）后端，并随包提供 `registerStorageConformance` 和 `storage-benchmark`。因此实现 PostgreSQL 后端的 `Storage`，不必在网络卷上跑 SQLite。

实现要点（来自接口注释，须逐条满足）：

- `commit(writes)` 原子：一个 PG 事务写入一批 conversation/entry/task/submission/document 记录，返回单调 `Seq`。
- `mintId()` 全局单调递增且跨 reopen 递增：用 PG sequence。
- 方法抛出的错误即致命（令 Session 失败、不重试），暂时性错误必须在方法内重试；只有 `StorageRequestError`（无效请求）和 context 被取消只让单次读失败。
- Session 自己串行化 commit，**同一时刻仍只能有一个 Session 写同一会话的存储**，所以所有权没有消失，但可收敛成：

所有权与 fencing：

- owner 记录在 PG（`durable_sessions.owner_worker` + `lease_epoch` + `lease_expires_at`），认领用条件更新并递增 `lease_epoch`。
- `commit()` 事务内校验当前 `lease_epoch` 等于 Session 持有的 epoch，不等则失败。租约被抢走后旧 owner 的写入被存储层拒绝，取代现在只防误双开的 advisory lock，也不依赖网络分区下的时钟假设。
- "错误即致命"意味着 fencing 失败会关闭旧 Session，这是期望行为；上层要映射为 `DurableSessionBusyError` 式的可重定向响应，而不是 500。
- README 要求"每个打开同一存储的进程必须使用同一时钟"（睡眠截止时间存的是 `now`）：各 worker 需统一时钟源并监控 NTP。

路由：静态哈希换成基于租约的动态路由（路由层查 `durable_sessions` 当前 owner，无 owner 或过期则任意 worker 认领）；空闲会话主动释放租约，运行中 turn 由心跳续期。

测试：用 `registerStorageConformance` 对 PG 实现跑官方一致性套件，用 `storage-benchmark` 与 sqlite 对比；沿用 SIGKILL/重启恢复测试并扩展为跨 worker 接管；新增 fencing 测试（旧 owner 被 SIGSTOP 超过租约后恢复，其写入必须被拒绝）。

**退出标准**：一致性套件全绿；跨 worker 接管与 fencing 测试通过；PG Storage 的单会话 turn 延迟与 sqlite 基线的差距在可接受范围内（阈值由 H0 基线给出）。

## 8. 测试策略

- 先跑基线并保存各测试文件通过情况；删除 legacy 时同时删除只测 legacy 的测试，并在 PR 里列出被删测试及原因，避免静默降低覆盖。
- 新增"本地模式 durable"端到端测试：创建会话 → 流式对话 → 重启 → 重放，以及调度、渠道、BTW、话题生成。
- S3 的"临时让 `pi-runner` 抛错"作为合并门槛。
- `test:integration` 需要临时 PostgreSQL，在 CI 中保持绿色。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 桌面单机用户失去 bash、终端、MCP 等 | 已确认接受；发布说明明确列出；bash 在 H2 的沙箱上重建 |
| 本地模式 durable 存在未发现的功能缺口 | S1 缺口清单加 S3 抛错检查兜底 |
| 旧历史丢弃后 L3 召回内容减少 | 已确认接受；发布说明告知；L3 仅索引 durable 会话 |
| 大规模删除悄悄降低测试覆盖 | 第 8 节的列举和对比 |
| `pi-web-ui` 等依赖间接依赖 pi-coding-agent | S1 先核对依赖树 |
| durable 路径的耦合假设（全局活动会话、`runtime` 字段）散落在前端 | S3 在前端 store 层统一检查 `sessions-store`、`chat-store` |
| 自实现 PG `Storage` 的正确性与性能（接口约束多，错误即致命） | 以 conformance 套件和 benchmark 为准入门槛；影子流量或测试租户灰度；保留 sqlite 后端作回退 |
| 双写期间数据不一致 | 回填后跑一致性校验，不一致告警，读切换前要求零差异 |
| 沙箱服务成为新的单点和成本中心 | 按租户池化、空闲回收；不可用时 fail-closed，不退回宿主执行 |
| 工作量估算偏乐观 | 每阶段独立上线；S1、H0、H1 完成后重估 |

## 10. 总体验收标准

- 仓库内没有 `pi-coding-agent` 的引用；本地与多用户走同一 durable 路径。
- 任一 worker 被 SIGKILL 后，其会话在可配置时间内由其他 worker 恢复，且不重复弹出 question/permission 卡片，不产生合成的用户回合。
- 删除任一 worker 本地磁盘，不丢失任何租户的非缓存状态。
- 跨租户读写在数据层（外键与租户作用域查询）被拒绝，而不只靠应用层路径检查。
- CI 中 `npm test`、`npm run test:integration` 和新增的故障注入/多 worker 恢复测试全部通过。

## 11. 待决问题

1. S1 缺口清单里，哪些缺口"必须补齐才能发布"，哪些可接受为已知丢失（需按产品优先级判断）。
2. `@earendil-works/pi-web-ui` 在 web 端的实际使用范围。
3. 发布形态：移除前是否先发一个带"legacy 即将移除"提示的过渡版本。
4. pi-durable 升级时 `Storage` 与 `ExecutionEnv` 接口的稳定性，需要与上游确认兼容性承诺。
5. 沙箱技术选型和部署形态（自建 Kubernetes 与托管服务）。
6. 对象存储选型，以及 L2 正文是否需要租户级加密。
7. 目标规模（租户数、单租户会话数、并发 turn 数）：决定是否需要 H4 的完整动态路由，还是固定分片加人工迁移即可。
