# 移除 pi-coding-agent legacy 路径、只保留 pi-durable 的规划

状态：规划草案，**不含任何代码改动**。基于对 `apps/inno-agent/src` 的只读盘点（import 关系、调用点、文件规模），未运行构建和测试。与 [DURABLE_REFACTOR_PLAN.md](./DURABLE_REFACTOR_PLAN.md)（存储与执行层重构）是两件独立的事，见第 7 节的先后关系。

## 1. 已确认的范围决定

| 议题 | 决定 |
|---|---|
| CLI（`cli.ts`，调用 PI `main()` 的终端界面） | 删除，同时移除 `package.json` 的 `bin: inno` |
| 只有 legacy 具备的能力 | 先删除；第一版 durable-only 只保留 durable 已支持的 `read`/`write`/`edit` 和记忆、OCR、渠道、question、permission 工具；其余按需在 durable 上重建，作为后续独立事项 |
| 已有 legacy JSONL 会话历史 | 丢弃：代码不再读取，不做迁移；**不由代码自动删除用户数据文件**，只在发布说明里告知可手动清理 |

## 2. 影响面（盘点结果）

### 2.1 直接依赖 `@earendil-works/pi-coding-agent` 的非测试文件（17 个）

| 类别 | 文件 | 处理 |
|---|---|---|
| legacy 运行时 | `agent/pi-runner.ts`（~1935 行）、`agent/inno-extension.ts`（~825）、`agent/observability-extension.ts`（~392）、`agent/mcp-extension.ts`、`cli.ts` | 删除 |
| 共享类型/函数被 durable 复用 | `agent/document-tools.ts`、`agent/practice-tools.ts`、`agent/tavily-tools.ts`、`scheduler/scheduler-tools.ts`、`agent/legacy-tool-adapter.ts` | 改写为直接产出 pi-durable 的 `ToolRegistration`，删除适配层；`practice-tools` 随终端一并删除 |
| 技能加载 | `agent/workspace-context.ts`（`loadSkillsFromDir`、`formatSkillsForPrompt`）、`server/routes/chat.ts` | 用仓库已有的 `server/skill-frontmatter.ts` 加自写的小型加载/格式化函数替代 |
| L2 后台 LLM 调用 | `memory/l2/summarizer.ts`、`wiki-generator.ts`、`wiki-linker.ts`、`wiki-page-merge.ts`、`overview.ts`（参数类型是 legacy 的 `ModelRegistry`） | 改为接收 `durable-models.ts` 的 `Models`（或一个只含 `complete` 能力的窄接口） |
| 上下文用量 | `agent/context-usage.ts`（`estimateTokens`、`AgentSession`） | 改为基于 durable 会话快照估算，或自写估算函数 |
| 路由 | `server/routes/chat.ts`（~1007 行，含大量 legacy 分支） | 删除 legacy 分支，只保留 durable 分支 |

### 2.2 legacy 运行时入口的调用点

`runPromptStreamingInSession` / `createNewSession` / `initSession` / `completePromptOnce` / `switchModel` / `completeSideQuestion` 被以下位置使用，都要切到 durable：

- `server.ts`：启动时 `initSession`、`runPromptSerialized`、话题生成 `completePromptOnce`、渠道的 `createNewSession`。
- `server/routes/sessions.ts`：创建/删除会话。
- `server/routes/settings.ts`：切换模型 `switchModel`。
- `server/routes/btw.ts`：`completeSideQuestion`、`appendAssistantNotificationInSession`。
- `scheduler/job-runner.ts`：legacy 分支。
- `channels/personal-dispatcher.ts`：`createNewSession`、`runPromptStreamingInSession`（本地模式）。

### 2.3 将随之失去的能力（已确认接受）

bash 与 Practice Lab 终端（含 `node-pty`）、权限系统插件的 `ask` 策略与三种模式、pi-sandbox、MCP、subagents、web-access（`web_research`）、codemode、computer-use、todo、斜杠命令面板、全部 CLI 能力。

其中 Tavily 的 `web_search`（`tavily-tools.ts`）不属于上述插件，是 Inno 自己的工具，默认保留并改写为 `ToolRegistration`。

## 3. 目标状态

- 只有一个运行时：pi-durable。本地/桌面和多用户模式共用同一执行路径，区别只在认证、租户根目录和 PG 支撑的所有权检查。
- `INNO_DURABLE_ENABLED` 不再是开关（永远启用）；`runtime: "durable"` 请求字段、`durableRequired`、`durable_required` 409 响应、`legacy` 会话 ID 判断全部删除。
- 依赖移除：`@earendil-works/pi-coding-agent`、`pi-sandbox`、`pi-subagents`、`pi-mcp-adapter`、`pi-web-access`、`@gotgenes/pi-permission-system`、`@injaneity/pi-computer-use`、`@juicesharp/rpiv-todo`、`@juicesharp/rpiv-ask-user-question`、`node-pty`。需要核对 `@earendil-works/pi-web-ui`（CLAUDE.md 说 root 为它保留了旧版 `pi-ai`）在 web 端是否仍被使用，决定能否一并移除。
- Docker/Electron：`Dockerfile.base` 的 `bubblewrap`、`socat`（沙箱用）可移除；`scripts/after-pack.cjs`（修复 `node-pty` 的 `spawn-helper` 权限）和 `build.asarUnpack` 里对应的条目可移除；`restart-dev.sh` 的 `--sandbox` 选项移除。

## 4. 分阶段计划

原则：每个阶段结束时仓库都能 `npm run build`、`npm test` 通过，阶段之间可以分别合并；先让 durable 成为唯一入口，最后才物理删除 legacy 代码，避免一次性大爆炸式改动。

### 阶段 A：前置对齐（先只读验证）

1. 在干净分支上跑基线：`npm run build`、`npm test`、`npm run test:integration`，记录通过数，作为后续各阶段的比较基线（本次盘点没有跑过）。
2. 列出"本地模式使用 durable"的功能缺口清单。需要逐项确认 durable 路径已覆盖：会话列表/详情/重命名/归档/删除、SSE 重放、话题生成、模型切换、附件和内联图片、技能加载（全局技能目录 + 工作区 `.skills`）、`agent.md`、调度任务和手动运行、渠道入站、BTW、上下文用量、研究上传和 Wiki 工具。缺口要在阶段 B 之前补齐，或明确写入"已知丢失"。
3. 确认本地模式无 PG 时 durable 的所有权/目录行为（`TenantStore` 缺省实现）完整可用。

### 阶段 B：让共享代码脱离 pi-coding-agent

不改变任何行为，只替换依赖，使 legacy 与 durable 同时仍可运行：

1. 工具定义：`document-tools`、`tavily-tools`、`scheduler-tools`、学习者/L2/L3/OCR/渠道工具统一产出 `ToolRegistration`；删除 `legacy-tool-adapter.ts`。
2. 技能：自写 `loadSkills` / `formatSkillsForPrompt`，对照现有行为写测试后替换 `workspace-context.ts` 与 `chat.ts` 里的调用。
3. L2 的 LLM 调用：改为接受窄接口 `CompleteFn`，由 durable 的 `Models` 提供实现；legacy 在此阶段仍传自己的实现。
4. `context-usage` 的估算函数自写。

**退出标准**：除 `pi-runner.ts`、`inno-extension.ts`、`observability-extension.ts`、`mcp-extension.ts`、`cli.ts` 外，没有文件再 import `pi-coding-agent`。

### 阶段 C：把所有入口切到 durable，legacy 变成不可达

1. 会话创建默认且仅为 durable；`POST /api/sessions` 忽略/拒绝 `runtime` 字段。
2. 聊天、取消、状态、事件重放：删除 `chat.ts` 中 legacy 分支。
3. 调度：`job-runner` 仅保留 durable 执行（`durable-job-runner.ts`）；`TenantCronScheduler` 与本地调度共用同一路径。
4. 渠道：本地模式的 `PersonalDispatcher` 也走 durable（多用户模式已经这样）。
5. BTW、话题生成、模型切换、上下文用量全部改为 durable 实现；`settings.ts` 的 `switchModel` 改为只更新配置，由新会话/下一轮读取。
6. 删除"启动时 `initSession`"和全局活动会话概念；前端如果依赖"当前活动会话"，同步调整。

**退出标准**：把 `pi-runner.ts` 临时改成 `throw` 后，全部单元和集成测试仍通过（证明没有路径还在用它）。

### 阶段 D：物理删除 legacy 与失去的能力

后端：

- 运行时：`agent/pi-runner.ts`、`inno-extension.ts`、`observability-extension.ts`、`mcp-extension.ts`、`question-bridge.ts`、`permission-bridge.ts`、`permission-system-config.ts`、`web-access-config.ts`、`provider-sync.ts`（核对是否仍被 durable 使用）、`cli.ts`。
- 终端与实践：`terminal/`、`server/routes/practice.ts`、`agent/practice-tools.ts`、`/api/terminal` WebSocket 升级与路由分发项。
- 路由与设置：`/api/mcp`、`PUT /api/settings/{permissions,computer-use,codemode,web-access}`、`/api/commands`（斜杠命令面板）及对应存储。
- 配置：`config.ts` 里 `plugins.*`、`mcp`、`subagents` 项及 `config.example.json`；`runtime.ts` 里 `PI_CODING_AGENT_*` 环境变量导出。
- 历史数据：`tenants/legacy.ts`、`tenants/migrate-legacy.ts`、legacy 集成测试；L3 `indexer.ts` 中读取 PI 会话 JSONL 的路径（仅保留 durable 快照索引）；`routes/sessions.ts` 中枚举 JSONL 的逻辑。

前端（`apps/inno-agent/web/src`）：

- `stores/terminal-store.ts`、`stores/mcp-store.ts`、`react/terminal/`、设置页中 MCP/权限模式/computer-use/codemode/web-access 区块、斜杠命令面板、Practice Lab 与 Run 控件。
- 保留 `QuestionDialog` / `PermissionDialog`：durable 的 question 和写入审批仍用它们。

**退出标准**：`grep -r "pi-coding-agent" apps/` 无结果；`npm run build` 与全部测试通过。

### 阶段 E：依赖、打包和文档收尾

- 移除第 3 节列出的依赖并重新生成 lockfile；root 里为 `pi-web-ui` 保留的旧 `pi-ai`、`jiti` alias（`web-access-config` 里的）一并核对清理。
- Docker、Electron、`restart-dev.sh`、`.env.example` 清理沙箱与终端相关项。
- 更新 `CLAUDE.md`（Agent core、Durable 运行时、Sandbox、Terminal、Skills、MCP 等整节重写）、`README`、`QUICKSTART`、`docs/DURABLE_RUNTIME.md`、`docs/MULTI_USER_DURABLE.md`、`docs/PERMISSIONS_AND_SANDBOX.md`；`CLAUDE.md` 里的测试数量、`server.ts` 行数等结构性事实按实际结果更新。
- 发布说明：列出被移除的能力、旧会话历史不再可见，以及可手动清理的目录。

## 5. 测试策略

- 先跑基线并保存各测试文件的通过情况；删除 legacy 代码时，同时删除只测 legacy 的测试，并在 PR 里列出被删除的测试及原因，避免静默降低覆盖。
- 新增对"本地模式 durable"的端到端测试：创建会话 → 流式对话 → 重启 → 重放，以及调度、渠道、BTW、话题生成。
- 阶段 C 的"临时让 pi-runner 抛错"检查作为合并门槛。
- 集成测试（`test:integration`）需要临时 PostgreSQL，要在 CI 中保持绿色。

## 6. 风险

| 风险 | 说明 / 缓解 |
|---|---|
| 桌面单机用户失去 bash、终端、MCP 等 | 已确认接受；发布说明明确列出，并把"在 durable 上重建 bash（经沙箱/权限）"列为后续事项（可与存储重构文档的阶段 2 合并考虑） |
| 本地模式 durable 存在未发现的功能缺口 | 阶段 A 的缺口清单与阶段 C 的"抛错检查"共同兜底 |
| 旧历史丢弃后 L3 召回内容突然减少 | 已确认接受；发布说明告知；L3 仅索引 durable 会话 |
| 大规模删除造成测试覆盖悄悄下降 | 第 5 节的列举和对比 |
| `pi-web-ui` 等未核对的依赖仍间接依赖 pi-coding-agent | 阶段 A 先用 `npm ls @earendil-works/pi-coding-agent` 核对依赖树 |
| 对 durable 路径的耦合假设（如全局活动会话、`runtime` 字段）散落在前端 | 阶段 C 在前端 store 层统一检查 `sessions-store`、`chat-store` 的相关逻辑 |

## 7. 与存储/执行层重构的先后关系

建议先做本规划，再做 [DURABLE_REFACTOR_PLAN.md](./DURABLE_REFACTOR_PLAN.md)：

- 删掉 legacy 后，需要迁移到 PG 和沙箱的路径只剩一套，会话目录、记忆工具、执行环境不用维护两份实现。
- 但本规划会让"本地/桌面"和"多用户"共用同一 durable 路径，因此存储重构里的 `SessionCatalog` 接口要同时服务本地（JSON 或 SQLite）和多用户（PG）两种实现，这一点在重构文档阶段 1 已有预留。
- bash 的重建依赖执行层沙箱，因此"在 durable 上恢复 bash"自然放在存储/执行层重构的阶段 2 之后。

## 8. 待决问题

1. 阶段 A 的缺口清单里，哪些缺口是"必须补齐才能发布"，哪些可以接受为已知丢失（需要你按产品优先级判断）。
2. `@earendil-works/pi-web-ui` 在 web 端的实际使用范围（决定能否移除 root 的旧版 `pi-ai`）。
3. 发布形态：是否在移除前先发一个带"legacy 即将移除"提示的过渡版本。
4. 估算工作量需要在阶段 A 完成后给出；此前不提供周数，避免凭空估计。
