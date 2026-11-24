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
- Docker/Electron：`deploy/Dockerfile.base` 的 `bubblewrap`、`socat` 可移除；`scripts/after-pack.cjs` 和 `build.asarUnpack` 里 `node-pty` 相关条目可移除；`restart-dev.sh` 的 `--sandbox` 移除。
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

**S2 实施结果（2026-11-18）**

- 工具：`document-tools`、`tavily-tools`、`scheduler-tools` 改为 `defineInnoTool` 原生工具；legacy 通过既有的 `createLegacyToolDefinitions` 适配，行为不变。**同时把它们注册进 durable 会话**（新增 `extraTools` 选项、`getSchedulerTools`、`skillsDir`），这是 S1 漏掉的缺口 G8。durable 里调度工具的 `run_scheduled_job` 暂返回"不可用"（`runMode: "unavailable"`），待 S3 接入 durable 的任务执行器。`practice-tools` 随终端在 S4 删除，不移植。`ConfigHolder` 抽到 `agent/config-holder.ts`。
- 技能：新增 `agent/skills.ts`（`loadSkillsFromDir`、`formatSkillsForPrompt`、`buildGlobalSkillsSection`），与 pi-coding-agent 原实现在含嵌套、忽略规则、禁用技能和非法名称的目录树上逐项对照一致；工作区 `.skills` 与**全局技能目录（含 `.ignore` 启停）**现在都会注入 durable 会话，G1 解决。
- L2 后台 LLM 调用：没有改成 `CompleteFn`。五个文件只用到 `getApiKeyAndHeaders` 一个方法，且 durable 的 L2 归档本来就不调用模型，所以只引入窄接口 `ModelAuthProvider`（`memory/l2/model-auth.ts`），legacy 的 `ModelRegistry` 结构兼容。
- 上下文用量：`context-usage.ts` 去掉对 `estimateTokens` 与 `AgentSession` 的依赖，自写 `estimateMessageTokens`（与原函数逐种消息类型对照一致）和本地结构类型。durable 的用量本身仍未实现，见 S3。
- 退出标准达成情况：除 legacy 专属文件（`inno-extension`、`legacy-tool-adapter`、`mcp-extension`、`observability-extension`、`pi-runner`、`practice-tools`、`cli`）、`routes/chat.ts` 里 legacy 流式分支的一个内联类型、以及一个 legacy 测试外，没有文件再 import `pi-coding-agent`。这些都会在 S3/S4 随 legacy 一起删除。

### S3 所有入口切到 durable，legacy 变成不可达

1. 会话创建默认且仅为 durable；`POST /api/sessions` 忽略/拒绝 `runtime` 字段。
2. 聊天、取消、状态、事件重放：删除 `chat.ts` 的 legacy 分支。
3. 调度：`job-runner` 仅保留 durable（`durable-job-runner.ts`）；本地与多租户调度共用路径。
4. 渠道：本地模式的 `PersonalDispatcher` 也走 durable。
5. BTW、话题生成、上下文用量改为 durable 实现；**模型切换**：durable 增加会话级换模型（`conversation.configure({ model })`，下一轮生效，设计见 [DURABLE_S1_FINDINGS.md](./DURABLE_S1_FINDINGS.md) 第 6 节），`settings.ts` 的 `switchModel` 只保留为设置默认模型。
6. 删除启动时 `initSession` 和"全局活动会话"概念，并同步前端依赖。

**退出标准（合并门槛）**：把 `pi-runner.ts` 临时改为 `throw` 后，全部单元和集成测试仍通过，证明没有路径还在用它。

**S3 实施结果（2026-11-18）**

已完成：

- durable 常开：服务端不再读 `INNO_DURABLE_ENABLED`，`/api/session` 固定报告 `durableEnabled: true`、`durableRequired: true`；`INNO_MULTI_USER_ENABLED` 与分片配置也不再要求该环境变量。路由层的 `durableRequired` 对所有模式生效，legacy 会话创建、legacy 提示执行和 legacy 手动运行都被拒绝；会话列表不再列出旧 JSONL 会话。
- **去掉启动时的 `initSession`**，服务器不再创建 legacy `AgentSession`。这一步让一批隐藏依赖暴露出来并已修复：`/api/btw/ask`（原来静默返回 502，现改用会话自己的模型，新增 `completeConfiguredDurableChat` 与 `DurableSessionService.completeSideQuestion`）、全局技能列表与 trace（改用自写 `skills.ts`）、设置页的模型列表与默认模型（只由配置文件决定）、`getCurrentSessionId` 等几个未初始化即抛错的访问器（改为无运行时返回空）。
- 渠道入站（本地模式）、调度创建会话、定时任务默认运行时全部走 durable；agent 工具 `run_scheduled_job` 在 durable 会话里改为"为任务新建一个 durable 会话并执行"。
- **会话级换模型**：`PATCH /api/sessions/:id` 接受 `provider` + `modelId`，下一轮生效，重开后保持，非法模型 400；会话摘要新增 `model`；前端模型选择器在打开会话时改会话的模型，无会话时仍改"新会话默认模型"。
- **durable 上下文用量**：改用提供方最近一次上报的用量加其后消息的估算，首轮前全部估算，并给出 system/tools/messages/skills 分项。

用真实服务器加假 OpenAI 端点做了端到端验证：创建会话、流式与非流式对话、重启后历史仍在、会话换模型（回显的模型名从 m1 变 m2）、上下文用量、BTW 提问、新建并在 durable 会话里运行定时任务、读取会话工作区，均正常且服务日志无错误。

**尚未完成（交给 S4 或需要决定）：**

- ~~G9 编辑历史消息并重发~~：**已实现**，见下方“G9 实现”。
- legacy 代码仍在仓库里但已不可达：`pi-runner.ts`、`inno-extension.ts` 等，以及路由里的 legacy 分支、`/api/commands`、MCP/终端/练习相关路由，留给 S4 删除。
- `maybeAutoGenerateTopic` / `completePromptOnce` 仍被 legacy 流程引用，S4 一并清理。
- 已存在的 durable 会话：全局技能写在 instructions 里，每次打开运行时都会重建；新增工具能否加到早就创建的会话**已验证**：`harness.root(...)` 的 `agent` 只在建根时应用，但打开时 `rootConversation.configure(agentConfig)` 重放当前配置——`durable-tools-reopen.test.ts` 钉死该行为（含 fork 后会话）。

**G9 实现（durable 编辑历史消息并重发）**

- 做法：编辑某条用户消息时，在 pi-durable 里对当前对话 `fork(该消息的前一条 entry)`（若是第一条消息则新建空对话），会话之后在这个新对话里继续；被放弃的消息和回复留在原对话里，但不再出现在可见历史和模型上下文中。会话目录记录新增 `conversationId`，运行时打开时据此选择活动对话，并对 fork 重新应用最新的 agent 配置（模型、instructions、工具、工作区）。
- 接口：`POST /api/sessions/:id/branch-before-message`，沿用原响应形状；会话正在生成时 409，找不到或不是用户消息 404（`code: entry_not_found`）。放弃分支上未回答的问题卡片和权限审批会被取消，但只在分叉成功之后才取消。
- 一致性：分叉先提交，目录记录随后更新。两步之间进程崩溃时，会话仍停在原对话，只留下一个无人引用的 fork，没有可见影响。
- 验证：服务层测试（可见历史、模型实际收到的消息、编辑第一条、拒绝助手消息和未知 entry）；冒烟测试覆盖路由校验；真实服务器加假模型做了端到端：编辑后模型只看到 `uau`，重启后仍在新分支上继续。

### S4 物理删除 legacy 与失去的能力

后端：

- 运行时：`pi-runner.ts`、`inno-extension.ts`、`observability-extension.ts`、`mcp-extension.ts`、`question-bridge.ts`、`permission-bridge.ts`、`permission-system-config.ts`、`web-access-config.ts`、`provider-sync.ts`（核对是否仍被 durable 使用）、`cli.ts`。
- 终端与实践：`terminal/`、`routes/practice.ts`、`practice-tools.ts`、`/api/terminal` WebSocket 升级与分发项。
- 路由与设置：`/api/mcp`、`PUT /api/settings/{permissions,computer-use,codemode,web-access}`、`/api/commands` 及存储。
- 配置：`config.ts` 里 `plugins.*`、`mcp`、`subagents`，及 `config.example.json`；`runtime.ts` 里 `PI_CODING_AGENT_*` 导出。
- 历史数据：`tenants/legacy.ts`、`tenants/migrate-legacy.ts` 与 legacy 集成测试；L3 `indexer.ts` 读取 PI 会话 JSONL 的路径（只保留 durable 快照索引）；`routes/sessions.ts` 枚举 JSONL 的逻辑。

前端（`apps/inno-agent/web/src`）：`stores/terminal-store.ts`、`stores/mcp-store.ts`、`react/terminal/`、设置页的 MCP/权限模式/computer-use/codemode/web-access 区块、斜杠命令面板、Practice Lab 与 Run 控件。保留 `QuestionDialog` / `PermissionDialog`（durable 仍使用）。

**退出标准**：`grep -r "pi-coding-agent" apps/` 无结果；构建与全部测试通过。

**S4 实施结果（2026-11-18）**

已删除的后端：`pi-runner`、`inno-extension`、`observability-extension`、`mcp-extension`、`question-bridge`、`permission-bridge`、`permission-system-config`、`web-access-config`、`provider-sync`、`legacy-tool-adapter`、`practice-tools`、`host-execution-policy`、`cli.ts`、`terminal/`、`mcp/`、`server/routes/{practice,commands}`、`agent-command-store`、`tenants/{legacy,migrate-legacy}`、`showcase/`（含导出路由与 `scripts/` 里的导出和预览脚本）、终端 WebSocket 与优雅关机里的 WS 处理、设置里的 MCP/权限/computer-use/codemode/web-access 接口、`config.ts` 的 `plugins`/`mcp`/`subagents`、`runtime.ts` 的 `PI_CODING_AGENT_*` 与 `--sandbox`。共用的纯类型搬到 `question-types.ts`、`permission-types.ts`，`resolvePluginFile` 搬到 `plugin-resolve.ts`。

已重写：`routes/chat.ts`（约 1000 行 → 约 170 行，只剩 durable 分发）、`routes/sessions.ts`（只剩列表与创建，其余在 `durable-routes.ts`）、`routes/btw.ts`、`routes/jobs.ts`、`routes/workspaces.ts` 的会话换工作区、L3 索引（只索引 durable 会话的投影历史，删除 JSONL 读取）。

前端：删除终端抽屉、运行按钮、`terminal-store`/`mcp-store`、MCP 设置页、权限模式控件、computer-use/codemode 开关、联网研究设置、代码块的"运行代码"、会话菜单里的"导出为回放案例"，以及对应的 i18n 文案。斜杠面板保留**应用动作**（新对话、模型、档案等），不再列出智能体命令。

S4 期间发现并修复的回归：

- 提醒类任务（`push_reminder`、`check_in_reminder`）被分配了 durable 会话后会被 `job-runner` 当成"durable 不支持提醒"而抛错。现在提醒文本作为助手通知写入该 durable 会话（`DurableJobExecution.notifyOnly`），并照常推送到渠道。
- 补上 durable 会话的 `GET /api/sessions/:id/export.md`（原来只有 legacy 有）。

**有意的取舍（可从 git 历史恢复）：**

- **回放案例导出（showcase export）已移除**：它读取 legacy JSONL 会话。静态展示应用 `apps/showcase` 保留，但它的数据导出管线不再存在。
- **L2 的 LLM 生成页面**（`summarizer`、`wiki-generator`、`wiki-linker`、`wiki-page-merge`、`overview` 叙述）在产品里已不可达：durable 的 L2 归档本来就是确定性的、没有模型。代码和测试保留，通过 `createL2Tools` 的 `richGeneration` 参数接入点留作后续。
- `channels.json` 等会话元数据旁路文件仍在写，但已不再被读取，S5 一并清理。

**验证**：构建通过；单元测试 112 个文件、877 个测试全绿（比 S3 少，因为删掉了只测 legacy 的测试）；真实服务器加假模型的端到端覆盖了流式与非流式对话、列表、上下文用量、导出 Markdown、BTW、换模型、工作区、提醒任务运行、归档与删除，已删接口全部 404。**集成测试（`test:integration`）已按新行为改写，但本机没有 PostgreSQL，没有运行过。**

退出标准：`apps/` 下除 `apps/inno-agent/package.json` 的依赖声明外，已没有 `pi-coding-agent` 引用。

### S5 依赖、打包、文档收尾

- 移除第 4 节所列依赖并重新生成 lockfile；清理 `web-access-config` 里的 jiti alias 与 root 旧版 `pi-ai`（核对后）。
- 清理 Docker、Electron、`restart-dev.sh`、`.env.example` 中的沙箱与终端项。
- 重写 `CLAUDE.md`（Agent core、Durable、Sandbox、Terminal、Skills、MCP 等节），并更新 README、QUICKSTART、`docs/DURABLE_RUNTIME.md`、`docs/MULTI_USER_DURABLE.md`、`docs/PERMISSIONS_AND_SANDBOX.md`；测试数量、`server.ts` 行数等结构性事实按实际结果更新。
- 发布说明：列出被移除的能力、旧会话历史不再可见，以及可手动清理的目录。

**S5 实施结果（2026-11-18）**

- **依赖**：后端移除 `@earendil-works/pi-coding-agent`、`@gotgenes/pi-permission-system`、`@injaneity/pi-computer-use`、`@juicesharp/rpiv-ask-user-question`、`@juicesharp/rpiv-todo`、`node-pty`、`pi-mcp-adapter`、`pi-sandbox`、`pi-subagents`、`pi-web-access`、`ws`、`@types/ws`、`jiti`；前端移除 `@juicesharp/rpiv-ask-user-question`、`pi-subagents`、`@xterm/*`。锁文件重新生成：删除 256 个包，保留下来的包版本零变化；`npm ci` 干净重装后构建与测试通过。`@earendil-works/pi-web-ui` 保留（前端仍在用）。
- **`ask_user_question`**：采用"拷进仓库"方案。questionnaire 的 schema、校验和响应信封（约 300 行，MIT）放在 `src/agent/ask-user-question/`，附上游 LICENSE 并带来源注释，durable 不再通过 jiti 加载外部包。新增了对应的单元测试。
- **打包与镜像**：删除 `scripts/after-pack.cjs` 和 `build.afterPack`（它只为 `node-pty` 的 `spawn-helper` 存在），`asarUnpack` 去掉 `node-pty`、`pi-computer-use`、`@homebridge`；`deploy/Dockerfile.base` 去掉沙箱用的 `bubblewrap`、`socat`、`ripgrep`；`restart-dev.sh` 去掉 `--sandbox`；Electron 默认配置去掉 `subagents`；`config.example.json` 去掉 `subagents`、`mcp`、`plugins`。
- **顺带清理**：未使用的 `WEB_ACCESS_PROMPT_HINT`、前端 `TodoWidget`、上下文用量里的 `mcp` 分类、指向旧插件的注释。
- **文档**：重写 `CLAUDE.md`（480 → 约 420 行，全部按现状）；`README.md`、`README.zh-CN.md`、`QUICKSTART.md`、`apps/inno-agent/README.md`、`docs/AUTHENTICATION.md`、`docs/SYSTEM_DEPENDENCIES.md`、`docs/features/context-usage.md` 同步更新；`docs/PERMISSIONS_AND_SANDBOX.md` 改写为 `docs/PERMISSIONS.md`（没有 shell、没有沙箱，只有工作区文件边界和写入审批）；`DURABLE_RUNTIME.md`、`MULTI_USER_DURABLE.md`、`quality-remediation-plan.md`、`apps/showcase/*` 加了说明性提示。**这几份仍保留大量与旧运行时对比的历史描述**，读的时候以文件开头的说明为准，没有逐段重写。
- **发布说明要点**：移除的能力（CLI、bash 与终端、MCP、子代理、系统沙箱、权限三档模式、computer-use、codemode、斜杠命令里的智能体命令、回放案例导出）；旧 JSONL 会话历史不再可见（文件仍在磁盘上，可手动清理 `data/sessions/*.jsonl`）；`config.json` 里的 `plugins`、`mcp`、`subagents` 字段会在下次保存时被丢弃。

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

#### H0 结果（已执行部分）

测试在 `apps/inno-agent/src/agent/durable-h0-safety-net.test.ts`，已进入单元测试套件。标记为 `it.fails` 的用例钉住**已知缺陷**：缺陷修复后它们会开始失败，届时必须去掉标记。

**已知问题清单**

| # | 问题 | 证据 | 影响 | 归属 |
|---|---|---|---|---|
| K1 ✅已修复 | `WorkspaceFileEnv` 检查后按路径打开（TOCTOU）：检查通过后把文件换成指向工作区外的符号链接，读写都会逃逸 | 确定性用例（读、写各一）；压力探针 5 秒内 7813 次读取泄露 7 次 | 模型本身无法创建符号链接（没有 shell、写工具只写文件），所以需要工作区里已有并发修改文件的第二方（同工作区的另一进程、同步盘）；多租户下每租户独立工作区，风险限于同租户 | 已修：`readTextFile`/`readBinaryFile`/`writeFile` 改为解析真实路径后以 `O_NOFOLLOW` 打开，并校验 fd 与路径解析结果同一 inode 且仍在工作区内，写入在校验后才截断；回归测试含 1.5 秒翻转压力。未覆盖：行读取器/二进制读取器等次要读接口仍按路径打开，写入时父目录被换成链接可能在工作区外新建空文件（不会覆盖已有数据）；彻底隔离仍属 H2 |
| K2 ✅已修复 | `sessions.json` 跨进程读改写会丢更新，且 `writeJson` 用固定的 `.tmp` 文件名，并发写会让 `rename` 抛 ENOENT | 4 个进程各 200 次追加，期望 800 条，实际 200 条，3 个进程崩溃 | 同一数据目录只能有一个进程写目录；Electron 与服务共用目录、多 worker 共享目录时都会触发 | 已修：`writeJson`/`writeJsonl`/`writeText` 用进程+计数的唯一临时文件名；目录的读改写走 `storage/file-lock.ts` 跨进程锁（mkdir 原子锁，死进程锁自动清理）。4 进程×60 次追加测试无丢失。锁只保护同机多进程；多机/多 worker 共享目录仍需 H1 |
| K3 | `delete` 先写目录后删数据，中间崩溃留下孤儿目录（`storage/`、`questions/`、`permissions/`） | 用例模拟该窗口 | 磁盘泄漏，无数据正确性问题 | 已提供 `durable-orphans.ts`（`findOrphanedSessionData` 只读检查、`removeOrphanedSessionData` 修复）；尚未接入启动自检或运维命令 |

同一进程内的目录操作是同步读改写，没有 `await` 穿插，40 个交错的 create/rename 与两个服务实例交替写都没有丢更新，所以"单进程"这个前提在代码里成立；失效的只有跨进程路径（K2）。

> L1 已移除（见下文"L1 移除"），下面的复核结论里涉及 L1 工具的部分仅作历史记录。

**`replay: "safe"` 复核**：只读工具（`get_learner_context`、`assess_learning_prerequisites`、`review_learner_profile`、`l2_query`、`l2_lint`、`l3_recall`）无副作用；`record_learning_event`、`record_learning_evidence`、`patch_learner_profile`、`update_learner_profile` 用 session+toolCallId 的持久操作标记；`l2_archive` 靠内容哈希去重与可续写的 manifest 记录；提问与写入审批靠按稳定调用 ID 持久化的决定；`ocr_image` 与 `send_file_to_channel` 有 job-ID 检查点与外发队列，提交/外发窗口仍是至少一次。没有发现需要降级的工具。记忆工具集合已用测试钉住，新增 safe 工具必须在测试注释里写明依据。

**容量基线**（`sessions.json`，每租户一份；单次同步读改写，会阻塞事件循环）：

| 会话数 | 文件大小 | 读 | 更新（读+写） |
|---|---|---|---|
| 100 | 0.05 MB | 0.2 ms | 0.4 ms |
| 1,000 | 0.45 MB | 1.0 ms | 1.9 ms |
| 10,000 | 4.6 MB | 11.8 ms | 18.5 ms |
| 100,000 | 45.6 MB | 125.6 ms | 224.9 ms |

每次改名、模型切换、话题生成和 `get` 都会读整个文件，1 万会话以内可接受，10 万会话时单次更新 200ms 以上。**指标与孤儿自检（已完成）**：`utils/metrics.ts` 提供进程内计数器、仪表和耗时汇总，经仅限回环地址的 `GET /metrics`（Prometheus 文本）暴露：`inno_catalog_read_ms`/`inno_catalog_write_ms`、`inno_catalog_sessions`、`inno_advisory_lock_{acquired,busy,lost}_total`、`inno_advisory_lock_acquire_ms`、`inno_file_lock_{wait_ms,timeouts_total,stale_broken_total}`、`inno_durable_orphan_sessions`、`inno_durable_disk_bytes`、`inno_durable_tenants`。启动后异步做一次只读孤儿审计并写 warn 日志；离线命令 `npm run durable:fsck [-- --data-dir <dir>] [-- --repair]` 输出各根（本地与每租户）的孤儿和磁盘占用，`--repair` 才删除，目录读不出来时拒绝判定孤儿。磁盘占用只在审计时遍历计算（启动一次或手动 fsck），不是每次抓取都扫。指标是单进程的，多 worker 需分别抓取；`/metrics` 无鉴权，所以只接受回环地址。

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

#### H1 结果（已实现）

**范围**：目标规模按"几千用户"设计。会话目录进 PG，多用户（认证）模式使用；本地/桌面模式没有 PG，继续用 `sessions.json`。

- **接口隔离**：`agent/session-catalog.ts` 定义异步 `SessionCatalog`（`get/list/insert/update/remove`），`FileSessionCatalog`（原逻辑，带跨进程文件锁）和 `agent/pg-session-catalog.ts` 的 `PgSessionCatalog` 实现它。`DurableSessionService` 按请求是否带已验证租户选择实现；服务的 `get/list/create/rename/setArchived/markSchedulerOrigin/noteSubmission/prepareAttachments/prepareImages` 全部改为异步，调用方（路由、任务、server.ts、测试）同步改好。
- **表**：`durable_sessions`（`tenants.id` 外键、级联删除；列覆盖 `DurableSessionRecord` 全部字段，外加乐观并发用的 `version`；索引 `(tenant_id, updated_at DESC)`），建表语句在 `tenants/schema.ts`，随现有迁移执行。
- **原子性**：创建会话时在一个事务内校验成员关系、写 `resource_ownership` 并写目录行；ID 已被其他租户占用则整体回滚。删除同样一个事务删目录行和归属行。`session.sqlite` 仍在运行时首次打开时惰性创建。
- **更新**：`UPDATE … WHERE id AND tenant_id`，只改补丁里的列并自增 `version`，不再整文件覆盖。不同字段的并发更新互不丢失（测试：5 个并发更新同一会话的不同字段，全部保留，`version` 为 5）。
- **租户隔离**：每条语句都用请求里已验证的租户过滤，不接受调用方传入的租户 ID；跨租户的 `get/update/remove` 命中不到。
- **迁移**：某租户首次访问目录时，若其旧 `sessions.json` 还在，则幂等导入到表（`ON CONFLICT DO NOTHING`，且只导入该租户在 `resource_ownership` 里已拥有的会话，手改文件无法把别人的会话挂到自己名下），导入后把文件改名为 `sessions.json.migrated`。两个 worker 同时导入结果一致；之后删除的会话不会被旧文件复活。旧文件不可解析时只记错误日志、原地保留、跳过导入。
- **与草案的差异**：没有做"双写 + 读切换开关"。双写需要两套目录同时保持一致，而旧文件已被改名保留，回滚时只能退回导入时刻的快照，回滚后期间新建的会话不在其中。如果上线策略需要无损回滚，要补一个反向导出命令。
- **孤儿自检跟进**：租户目录的目录内容在 PG 里，所以启动审计和 `durable:fsck`（设置 `DATABASE_URL`）改为对照 PG；有数据但找不到目录文件时报错，不再把所有会话目录当成孤儿，避免 `--repair` 误删。

**基线**（PG 17，本机；22 万行 = 3000 租户 × 40 个会话 + 1 个 10 万会话的租户）：

| 操作 | 文件目录（H0 基线） | PG |
|---|---|---|
| 典型租户（40 会话）列表 | <1 ms | 0.8 ms |
| 按 ID 读取 | 同列表（读整个文件） | 0.2 ms |
| 单会话更新 | 10 万会话 225 ms，且阻塞事件循环 | 1.2 ms（10 万会话租户 1.5 ms） |
| 10 万会话租户列表 | 126 ms | 233 ms |
| 200 个并发更新（10 连接） | 逐个串行 | 总计 38 ms |

更新从随会话数线性增长变成与会话数无关，这是 H1 的主要收益；`list` 仍返回整个租户的全部会话，10 万会话的极端租户要 233ms，后续如需支持极端租户应给列表接口加分页。

**测试**：`agent/pg-session-catalog.integration.test.ts`（8 个）：字段往返与归属同事务、跨租户隔离、归属冲突整体回滚、并发更新不丢字段、60 个并发创建不丢、排序与删除带走归属、旧文件导入（只导入已拥有会话、双 worker 竞态一致、不复活已删会话）、旧文件损坏时保留。集成套件共 6 个文件 38 个测试通过，其中认证模式下的真实服务测试已走 PG 目录。单元套件 117 个文件 907 个测试通过。

**未做**：目录分页；反向导出（回滚）命令；`durable_sessions` 的指标（目前复用 `inno_catalog_pg_get` / `inno_catalog_pg_update` 两个耗时汇总，`inno_catalog_sessions` 仅在文件目录下更新）。

### H2 执行层隔离（约 3–5 周）

`WorkspaceFileEnv` 已实现 pi-durable 的 `ExecutionEnv`。pi-durable 的 `env` 是**每次工具调用时的工厂**（`env: ({ cwd }) => ...`），自定义环境用 `id` 标识"同一套文件"，README 约定一个容器对应一个 id；README 还提到 pi-env 的 `RemoteExecutionEnv` 可作起点（是否随依赖安装、是否满足租户隔离，待验证）。包内带 `registerEnvConformance`（可选 `shell` / `symlinks` / `listFiles`）可直接验证新环境。

- 2a 抽出 `ExecutionEnv` 工厂，使 `durable-runtime.ts` 不直接构造 `WorkspaceFileEnv`；本地实现作为默认，行为不变。
- 2b 实现 `SandboxedExecutionEnv`：每租户（或每会话）一个受限沙箱（容器加 gVisor/Firecracker 之一，选型待评审），工作区经租户级卷挂载；env 方法转为沙箱服务调用；路径包含检查下沉到内核级挂载边界。
- 2c 沙箱内才考虑开放 shell：默认关闭，经权限 `ask`，保持 deny floor；CPU、内存、时间、网络出口在沙箱层限额。**这也是被收敛线移除的 bash 的重建位置。**
- 回放语义：README 写明工具调用先提交意图再执行，崩溃后只有声明 `replay: "safe"` 的工具会重跑，否则模型收到 `interrupted`。pi-durable 内置 `read`/`write`/`edit`/`bash` 源码里没有任何 `replay` 声明，所以它们崩溃后不重跑，这是 `write`/`edit` 的安全默认，远程实现保持这一语义，不要擅自标 safe；远程调用仍带稳定 tool-call ID 作幂等键。

**退出标准**：`durable-env.test.ts` 加官方 `registerEnvConformance` 对本地与沙箱实现都通过；符号链接逃逸测试在沙箱下无法逃逸；沙箱服务宕机时工具调用 fail-closed 并可重试，不破坏会话。

#### H2 结果（E2B 云沙箱已跑通，待真实账号验证）

**决定**：数据可以放 E2B 云；先用云把整条链路跑通，沙箱接口按 e2b 的形状定义，后续可换成自建的 e2b 兼容后端而不动上层。

**已实现**（`apps/inno-agent/src/sandbox/`）：
- `sandbox-backend.ts`：e2b 形状的最小契约（文件读写/列表/重命名、`run`、`keepAlive`、`pause`、`kill`，以及 `SandboxProvider` 的 `create/connect/destroy`）。
- `e2b-backend.ts`：用 `e2b` SDK 实现；非零退出码是结果不是异常；命令超时与取消会杀掉远端进程；`connect` 找不到沙箱返回 null。
- `sandbox-env.ts`：把后端适配成 pi-durable 的 `ExecutionEnv`。**通过 pi-durable 自带的 `ExecutionEnv` 一致性用例**（跳过目录监听，harness 与本应用都不调用 `watch`），对象是目录支撑的测试替身；同一套用例也接入了真实 E2B 的集成测试。
- `sandbox-session.ts`（`SandboxManager`）：每会话一个沙箱的创建、重连、暂停、销毁，沙箱 ID 存进会话目录（文件目录与 PG 表都加了 `sandbox_id` 列，PG 用 `ADD COLUMN IF NOT EXISTS` 平滑升级）。
- `workspace-sync.ts`：宿主与沙箱工作区的增量双向同步（规则见 `docs/PERMISSIONS.md`），清单持久化，重启后不会整体重传。
- 运行时：有沙箱时注册 pi-durable 的 `bash` 工具；审批用新增的 `withDurableCommandPermission`（决定按稳定调用 ID 持久化，工具保持不可重放）。提示词加入沙箱说明，技能与工作区路径改写成沙箱路径。
- 配置：`sandbox` 段与 `INNO_SANDBOX_ENABLED`/`E2B_API_KEY`，平台级，不读租户配置。指标：`inno_sandbox_{created,resumed,paused,destroyed}_total`、各类 `*_errors_total`、`inno_sandbox_bind_ms`、`inno_sandbox_sync_{uploaded,downloaded,skipped}_total`。

**测试**（单元 126 个文件 972 个测试通过，集成 7 个文件 42 个通过，另有 1 个仅在设置 `E2B_API_KEY` 时运行的真实 E2B 用例）：`sandbox-env.test.ts`（一致性 14 项）、`workspace-sync.test.ts`、`e2b-backend.test.ts`（mock SDK：退出码、超时、取消、错误映射、创建参数、重连）、`sandbox-config.test.ts`，以及 `durable-sandbox.test.ts`：用真实的 `DurableSessionService` 与 faux 模型验证 bash 在沙箱里执行、双向同步、宿主编辑下一轮可见、同一沙箱在重新打开时被重连、沙箱丢失后自动重建并重新播种、会话删除时销毁沙箱、无法询问时拒绝需审批的命令。

**未验证**：没有在真实 E2B 账号上跑过。`e2b-live.integration.test.ts` 会在有密钥时验证真实的 create/run/超时/取消/暂停/恢复/销毁，并跑一致性用例；`E2B_API_KEY=... npm run test:integration -- e2b-live`。上线前必须跑一次，并实测以下与云服务相关的数值：暂停与恢复耗时、冷启动耗时、`files.list` 的深度行为、国内访问延迟。

**每租户配额（已补）**：`sandbox.limits` 三项（同时运行数默认 3、拥有总数默认 20、每 UTC 日运行分钟默认 480，0 为不限）。超限时会话照常打开、历史可看，沙箱被 `GuardedSandboxBackend` 关闭，工具返回超限原因，每一轮重试，容量释放或次日重置后自动恢复。认证模式账目在 PG（`sandbox_leases`、`sandbox_usage`，租户级咨询锁内判定，12 个并发打开恰好放行上限数；崩溃 worker 的租约 10 分钟无心跳即回收并按最后心跳计时），本地模式在进程内。指标：`inno_sandbox_quota_denied_{concurrent,time,sandboxes}_total`。取舍：一轮进行中不打断，时长可能超一轮；配额为软上限，不替代云账号侧的用量上限，仍应在 E2B 控制台设置账号级预算。

**H2 收尾（已补）**：
- **孤儿沙箱清理**：`SandboxProvider.listManaged()`（E2B 按 `metadata.app=inno-agent` 列出运行中与已暂停的，跨页）、`sandbox-audit.ts` 的 `findOrphanSandboxes`/`removeOrphanSandboxes`（只处理无会话记录引用且超过宽限期的）、命令 `npm run sandbox:fsck [-- --repair]`。
- **网络出站白名单**：`sandbox.allowedDomains`，E2B 侧为 `denyOut: 0.0.0.0/0` 加 `allowOut`；断网（`allowInternetAccess:false`）优先；提示词同步告知模型。
- **设置界面**：设置页"集成"里的"云端沙箱"卡片（启用、密钥、审批、联网与白名单、三项配额、超时、自部署域名与模板），后端 `PUT /api/settings/sandbox`（严格校验，掩码密钥表示保留，启用必须有密钥，保存后重建沙箱管理器）。仅本地模式可编辑；认证模式下租户看不到也改不了。顺带修了一个泄露隐患：设置接口原先会把 `config.sandbox.apiKey` 原样随配置展开返回，现在统一掩码（有测试）。

**已知限制与后续**：
- 一轮中途崩溃，该轮在沙箱里的改动要等下次打开会话时的同步才回到宿主；网页文件面板有一轮延迟。
- 宿主侧删除不传到沙箱；符号链接、超大文件、被忽略的目录不同步。
- 每次 `bash` 都经 E2B 往返，长输出不做截断以外的处理（pi-durable 的 bash 工具自己做输出窗口）。

### L1 移除（H3 之前）

**决定**：产品不再需要 L1 学习者画像，整层删除，目的之一是缩小 H3 的范围：L1 是 H3 里状态语义最复杂的一块（带版本的画像 JSON 读改写、事件追加日志、靠 `applied_operation_ids` 去重的操作标记、事件重放重建）。记忆现在只有两层：L2 Wiki 与 L3 会话召回。

**删掉的东西**
- 后端：`memory/learner/` 整个目录（画像存储与更新、证据与状态引擎、上下文包、前置知识解析与教学入口门控、`rebuild-profile`），7 个 L1 工具（`get_learner_context`、`record_learning_event`、`record_learning_evidence`、`assess_learning_prerequisites`、`review_learner_profile`、`patch_learner_profile`、`update_learner_profile`），`/api/learner/*` 路由，每轮注入的"学习者上下文"和新手引导，`memory.l1Enabled` 配置与设置接口字段，`runtime.ts` 里的 `learner/` 数据目录，`tenants/paths.ts` 的 `learner` 域，定时任务类型 `learner_profile_reflection`。
- 提示词：改为"两层记忆"，去掉 L1 工作原则、教学入口门控和依赖 L1 状态的教学策略指南。
- 前端：学习者画像页面与面板、侧边栏入口、`/profile` 斜杠命令、记忆设置里的 L1 开关、相关翻译、store 与 API 模块。`?page=learner` 与 `?tab=profile` 的旧链接落回聊天页。
- 文档：`docs/learner-state-engine-design.md`，以及 CLAUDE.md、README、持久运行时、多用户、认证等文档里的 L1 描述。

**连带影响**
- `assess_learning_prerequisites` 一并删除（它依赖 L1 的掌握度）；L2 里的前置关系数据本身没动，只是目前没有工具消费它。
- 崩溃重放的验证改用真实的 `l2_archive`：`durable-runtime.test.ts` 里"SIGKILL 后重放被打断的工具"原先用 L1 事件工具，现在用被杀在"写完记录、提交结果之前"的 `l2_archive`，验证重放后 manifest 仍只有 1 条。`replay: "safe"` 的记忆工具集合从 10 个降到 3 个（`l2_archive`、`l2_query`、`l2_lint`，加条件注册的 `l3_recall`）。
- **磁盘上已有的 L1 数据不再被读取**，也不会被删除或迁移：本地模式的 `<data>/learner/`、多用户模式每个租户的 `tenants/<id>/learner/` 保持原样，可自行清理。旧 `config.json` 里的 `memory.l1Enabled` 会被忽略，下次保存配置时丢弃。已有的 `learner_profile_reflection` 定时任务仍会按其提示词作为普通任务运行，只是不再出现在创建选项里。
- 展示用静态数据（`apps/showcase`）里仍有 L1 的演示内容，那是导出的历史案例，没有改。

**效果**：H3 从四批变成三批（恢复类记录、L2 wiki、L3 召回），L1 的画像 JSON 与事件日志不再需要迁移。

### H3 记忆、OCR、发件箱、恢复记录迁出本地文件（约 4–6 周）

**已定决策**
- 目标是任意 worker 都能接管会话，所以 H3 与 H4 都必须完成：H3 迁出租户级状态，H4 迁出每会话 SQLite。
- 数据库统一换成 ParadeDB 镜像（`paradedb/paradedb:*-pg17`，带 pgvector、`pg_search`、`pg_trgm`）。中文全文检索用 `pg_search` 的 BM25（`chinese_lindera` 分词）。本地与 CI 的临时 PG 也用该镜像。
- 对象存储：生产用阿里云 OSS，本地与测试用 MinIO，两者都走 S3 兼容接口，通过一层 `ObjectStore` 抽象隔离（桶、前缀按租户分隔）。

按风险从低到高分批，每批独立开关：

0. ✅**基础设施（已完成）**：换 ParadeDB 镜像；引入带编号的迁移文件与 `schema_migrations` 表，取代 `tenants/schema.ts` 里零散的 `IF NOT EXISTS`；加 `ObjectStore` 抽象（OSS/MinIO 实现与内存测试替身）。
1. ✅**恢复类记录（已完成）**（question、permission、流日志、OCR 检查点、渠道发件箱）→ PG 表。幂等键变成唯一约束，如 `UNIQUE (session_id, tool_call_id)`，取代文件里的操作标记，最能提升 `replay: safe` 的可信度。发件箱用 `FOR UPDATE SKIP LOCKED` 认领并回收过期认领，重试用尽进死信表；30 天保留改为按 `completed_at` 删除。
2. ~~L1 画像与事件 → PG~~：**已取消**——L1 学习者画像层已整体移除，见上面"L1 移除"。
3. ✅**L3 召回（已完成）**：每租户 `node:sqlite` 加 FTS5 → PG 表（`tenant_id` + `session_id` 过滤），检索用 `pg_search` BM25。不建向量索引：按租户过滤后的精确扫描比近似索引稳。
   - 实现：`L3Backend` 异步接口（`SqliteL3Backend` 本地、`PgL3Backend` 认证模式），表 `l3_chunks`（BM25 索引，`rowid` 为 key field）与 `l3_index_state`。沿用 SQLite 那套 `segmentForFts` CJK 二元分词，把分词结果存进 `tokens` 列并用 whitespace 分词器建索引，查询用 `tokens ||| '…'`（match disjunction）加 `paradedb.score`，因此两个后端的分词、召回与阈值筛选完全一致，不依赖 `chinese_lindera` 的分词质量。重建索引时旧块、新块和状态在同一事务里替换。
   - 索引是派生数据：不导入旧的 `l3/memory.db`，会话在下一次快照时按提交 revision 惰性重建；删除会话时同步清理其块（失败仅留下已被所有权过滤隐藏的块）。
   - 已知限制：召回质量按"词元覆盖率"阈值把关，BM25 只负责取候选；没有跨租户的全局统计，每个租户的 BM25 统计量来自整张表（语料大时 IDF 偏向全局），排序影响有限，阈值不受影响。
4. ✅**L2 wiki（已完成）**：manifest 与页面元数据、正文进 PG；`raw/` 下的原始文件文本类进 PG，PDF、Word、图片进对象存储（库中只存对象键与 `sha256`）；`wiki-graph` 继续按需在内存构建。
   - 实现：新增 `L2Backend` 异步接口（`memory/l2/l2-backend.ts`），把 L2 的所有读写统一成"后端相对路径"语义——`FileL2Backend` 保持本地文件+SQLite 索引，`PgL2Backend`（`memory/l2/pg-l2-backend.ts`）落到 `l2_files`（全部文本文件：wiki 页面、导航、提取文本、reviews）、`l2_objects`（对象键/sha256/大小/类型，字节在 `ObjectStore`）、`l2_manifest`（每源一行 JSONB）、`l2_pages`（检索索引，沿用 `segmentForFts` CJK 二元分词 + whitespace 分词器 + `tokens ||| '…'` BM25，与 L3 同方案）。服务端按 dir 注册 resolver：`<dataDir>/tenants/<tenantId>/l2` → `PgL2Backend`（pool 用 `tenantStore.database`，对象存储按 `objectStorage` 配置惰性创建），其余路径仍是文件后端；所有调用点（工具、路由、lint、graph、overview、indexer）只跟 `L2Target`（dir 或 backend）打交道，不看具体实现。
   - 迁移：首次访问时把租户的本地 `l2/` 目录一次性导入（`manifest.jsonl` 逐行进 `l2_manifest`，文本扩展名进 `l2_files`，其余进对象存储，跳过 `index.db*` 与 `ingest-progress`），导入后检索索引从已入库页面重建，目录改名 `l2.migrated`。导入期间用不带 legacyDir 的内部 backend 跑 `indexAllPages`，避免公共方法 `await init()` 自等死锁。
   - 已知限制：本地/认证两条路径的文件视图语义有差异（PG 没有目录，只有路径键），但都在 `L2Backend` 抽象内；wiki 页面写合并（`wiki-page-merge`）与摘要检查点（`ingest-progress`）仍是非持久的本地缓存，不迁移；两个 worker 并发归档同一内容时去重靠 content hash 读-改-写，非数据库仲裁，依赖 H4 的单 owner 路由。

**第 1 批实现说明**：
- 抽象为异步的 `RecoveryRecordStore`（`agent/recovery-store.ts`）：本地模式仍是 JSON 文件（目录布局不变），认证模式是 `recovery_records` 表，主键 `(tenant_id, session_id, kind, record_key)`，`record_key` 即工具调用 operation ID 的 SHA-256，所以幂等键就是主键。question、permission、OCR 检查点走它；渠道发件箱用 `recovery_records`（kind `outbox`）加 `recovery_blobs`（快照字节，与记录同事务写入，上限 100 MB）；SSE 流日志用 `stream_turns`/`stream_events`（批量写入保序，结束后 5 分钟可重放）。
- 旧文件在认证租户首次访问某会话时一次性导入（只导入该租户拥有的会话；per-session 目录改名为 `.migrated`，共享目录里的 OCR/发件箱文件逐个删除）。**旧的 SSE 流日志文件不导入**：它只覆盖结束后 5 分钟或进行中的回合，升级窗口内的进行中回合需要用户重发。
- 同步文件代码天然的原子性没有了：`DurableQuestionStore`/`DurablePermissionStore` 内部用 `SerialQueue` 串行化，避免同一进程里 `present` 用旧快照覆盖已答复的记录。
- 集成测试发现并修复两个 PG 特有的问题：`jsonb` 不保留键顺序（原来按 `JSON.stringify` 比较重放时的参数会误报"参数变了"，现用 `canonicalJson`）；`jsonb` 不能存 U+0000（审批键里的 `\0` 分隔符不再入库，命令预览里的 NUL 替换为 U+FFFD）。
- 已知限制：两个进程同时答复同一张卡片，数据库不做仲裁（"读—改—写"非原子），依赖 H4 的单 owner 路由；OCR/发件箱仍是至少一次语义。

**退出标准**：worker 重启或迁移不丢任何租户状态；任一租户目录整体删除后，能从 PG 加对象存储重建全部非缓存状态。

### H4 PG 版 `Storage` 与租约路由（约 3–6 周，依赖 H1–H3）

**状态（H4 第 1 批已完成）**：`PgDurableStorage`（`agent/pg-durable-storage.ts`）是 pi-durable `Storage` 接口的 PostgreSQL 移植，`agent/pg-durable-storage.integration.test.ts` 用官方 `createStorageConformance` 一致性套件全量验证（25 例）并加租约/fencing/旧 sqlite 导入测试。

- 表结构（迁移 v8，`ds_*`）：`ds_metadata`（每会话一行：`next_id`/`next_seq` 计数器 + `owner_worker`/`lease_epoch`/`lease_expires_at` 租约）与 `ds_record_ids`/`ds_conversations`/`ds_entries`/`ds_tasks`/`ds_submissions`/`ds_documents`/`ds_document_revisions` 逐表镜像 sqlite schema，全部按 `session_id` 隔离并 `REFERENCES durable_sessions(id) ON DELETE CASCADE`；`record`/`content` 列用 text 存 JSON，与 sqlite 逐字节一致。
- `commit()` 在事务首句做 fencing：`UPDATE ds_metadata SET next_seq = next_seq + 1, next_id = GREATEST(...) WHERE session_id AND lease_epoch = <epoch> RETURNING next_seq - 1`——epoch 不匹配即抛 `DurableStorageFencedError`，按"错误即致命"契约使旧 Session 失败。`mintId()` 走同一行的原子自增，跨 reopen 单调。
- 租约认领（`TenantStore.claimDurableStorage`）：条件 UPDATE 在"无主/同 worker/租约过期/advisory 锁无其他持有者"任一时成功并递增 epoch。advisory lock 仍保留为活跃 worker 间的快速互斥与 `onLost` 通知；SIGKILL 后锁随连接释放→立即接管，SIGSTOP 僵尸进程要等租约 TTL（45s）过期→心跳续约（TTL/3）失败即关闭 runtime。`openStorage` 选项接进 `DurableSessionRuntime.open`，认证模式开 PG storage，本地模式仍是 sqlite。
- 旧 `session.sqlite` 首次打开时一次性导入（逐表 `INSERT ... ON CONFLICT DO NOTHING`，计数器取 GREATEST），成功后改名 `session.sqlite.migrated`。

**状态（H4 第 2 批已完成）**：会话级请求按 `ds_metadata` 的活 owner 动态路由（`durable-tenant-router.ts`）：URL（`/api/sessions/:id*`、`/api/chat/status|events/:id`、`/api/chat/:id/:turn/abort`、`/api/btw/state/:id`）或 JSON body（`/api/chat*`、`/api/btw/ask|bring-back`）里的 sessionId → `TenantStore.durableSessionOwner`（租约未过期且 advisory 锁仍被持有才算活 owner）→ 命中配置内 worker 即转发，否则回退租户哈希；会话请求的转发目标不可达时降级为本地服务并认领租约（跨 worker 接管链路），租户级请求仍哈希转发、目标死了回 502。body 在路由层缓冲并以 replay 流还原，32MB 上限同 `readBody`。

- 租户 `config.json` 复制进 PG（迁移 v9 `tenant_configs`，权威副本）：settings/channels 写路径经 `persistTenantConfig` 双写文件+PG；每个认证请求在租户挂接后 `syncTenantConfigFromStore` 按 `updated_at` 标记把 PG 内容物化成本地文件，文件仍是同步读路径——非 owner worker 接管后才有 provider/channel 配置可跑会话。
- `owner_worker` 只在 runtime 活跃期间记录（最后一个引用释放即清租约），所以 owner-follow 只作用于活跃 turn 期间的并发请求（abort/status/question-response 等）；空闲会话无主，但走 `last_worker` 亲和（迁移 v10：每次认领记录、释放保留），把会话路由回最后持租约、也就持有其本地文件的 worker；亲和目标不可达时照常回退本地认领并改写亲和。

**已知限制**："偷来"的 owner 若在 advisory 锁释放与下次续约重拿锁之间被第三个 worker 撞上，epoch fencing 仍保证单写者，但旧 owner 的会话会被判失败关闭。channel/job 内部 prompt（`runDurableJobPrompt`、`appendAssistantNotification`）在会话被另一 worker 的活跃 turn 持有时不再立即失败：`lease({ busyWaitMs })`（默认 `INNO_DURABLE_JOB_BUSY_WAIT_MS`=120s）有界轮询重试，远端 turn 结束放租后本地认领执行——owner 只在 runtime 活跃期间存在，所以"等远端 turn 结束再接管"等价于排队。若远端 turn 超过等待上限仍按 busy 失败。

**状态（H4 收尾已完成）**：`pg-durable-storage-benchmark.integration.test.ts` 用 pi-durable 官方 `storage-benchmark` 对比 SQLite 与 PG 后端（同一数据集经 `Storage` 契约播种，多样本取 median/mean）。首轮暴露 PG `commit()` 每条 write 3+ 次串行往返（100 条 entry ≈ 300 次查询、median 201ms）；批量化后（`checkGlobalIds` 单条 `ANY()` 查询、`ds_record_ids` 认领与四种表写入各一条 `unnest` 多行 INSERT、文档存在性/版本探测 `ANY()` 化）降至 median 74ms，混合 commit 168→8.4ms，conformance 套件 25 例语义不变。单条读/写仍有 ~0.2–2.7ms 的容器内网络+SQL 固有开销（sqlite 0.01–0.9ms），属预期量级。`durable-sharding.integration.test.ts` 增加 SIGSTOP 僵尸 owner 用例：慢 turn in-flight 时冻结 owner → TCP 不报错故转发带响应头超时 → 租约过期后本地认领 → events 重连驱动 `waitForSubmission` 完成被接管 turn（epoch≥2）→ SIGCONT 后僵尸写被 fencing（无重复 entry）且 worker 可复活重投路由。

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

**H4 之后剩余工作**（最初目标"任意 worker 接管会话"已达成并验证；以下为记录在案的开放项）：

- ~~channel/job 内部调用方仍锚定租户哈希 worker，会话 owner 漂移后内部 prompt 被 fencing 拒绝~~ **已缓解**：内部 prompt 通过 `lease({ busyWaitMs })` 有界等待远端活跃 turn 结束后本地认领（超上限仍 busy 失败）。彻底方案（把内部 prompt 转交给 owner worker 执行）需要 inter-worker 认证或 PG 队列，暂未做。
- ~~空闲会话无 owner，owner-follow 只覆盖活跃 turn 期间~~ **已实现会话亲和**：迁移 v10 给 `ds_metadata` 加 `last_worker`（每次认领写入、释放时保留），`durableSessionRouteHint` 一次查询返回 `{owner, affinity}`；路由目标顺序 live owner → last_worker → 租户哈希，目标不可达照旧本地回退认领（亲和自动自愈迁移）。sharding 集成测试端到端验证：SIGKILL 接管后，重启的哈希 owner 收到的空闲会话请求被转发到最后认领 worker。
- ~~workspace 目录与 registry 仍是 worker 本地、未复制~~ **已实现 workspace→对象存储复制**（`workspace/workspace-replica.ts` + 迁移 v11）：registry 行复制到 `tenant_workspaces`、会话绑定复制到 `session_workspaces`（FK 级联）、文件清单复制到 `workspace_files`，文件字节进 `tenants/<t>/workspaces/<ws>/<path>` 对象（base64url 编码路径段）。同步点：会话打开（`lease()`，持租约后）物化 registry 行+绑定并 `pull` 缺失文件；runtime 关闭（持租约内）`push` 增量；workspace 文件写路由（file/create/rename/delete/move/upload/skills）与 workspace/绑定变更端点同步复制。**已知限制**：文件级 last-writer-wins——两个 worker 同时写同一共享 workspace 会互相覆盖（无 OT/合并）；push 在 runtime 关闭与路由写时触发，worker 在 turn 中途死亡丢当轮写入；pull 只在物化/会话打开时发生，远端 push 不会主动推给另一 worker 的本地副本；`memory` 对象存储是进程内的，跨 worker 部署需 `INNO_OBJECT_STORAGE_PROVIDER=s3` 或 `fs`（`fs` 供单机多进程/测试，`INNO_OBJECT_STORAGE_DIR`）。新增 `FsObjectStore` 与跨 worker 集成测试：owner 上传文件→SIGKILL→存活 worker 认领打开会话→文件内容恢复验证。
- ~~H1 未做项：目录分页、回滚导出命令、`durable_sessions` 专用指标~~ **已全部补齐**：`SessionCatalog.listPage` 提供 `(updated_at, id)` 游标分页，`GET /api/sessions?limit=&cursor=` 返回 `{sessions, nextCursor}`（无参数保持旧数组响应，前端未改）；`npm run durable:export-catalog -- --data-dir <dir> [--tenant <id>]` 把 PG 目录导出回每租户的 `durable/sessions.json`（`sessions.json.migrated` 只是导入时快照，回滚需先导出）；指标改专用名 `inno_durable_sessions_{get,list,insert,update,remove}_ms` + `inno_durable_sessions` gauge（list 时刷新）。
- ~~缺"旧会话重开后能看到新工具"的验证测试~~ **已覆盖**：`durable-tools-reopen.test.ts` 验证重开后 `configure()` 重放 agent 配置使新注册工具可见，含 fork 后会话变体。
- E2B 沙箱仅 mock 验证；真实验收针对自部署的 E2B 兼容服务：设置 `E2B_API_KEY` 与 `E2B_DOMAIN`（可选 `E2B_TEMPLATE`）后运行 `e2b-live.integration.test.ts`，上线前必跑并实测暂停/恢复/冷启动与延迟。
- **部署形态变更（已完成）**：产品定位转为分布式部署的后端 + 浏览器 Web UI，不再提供 Electron 桌面客户端。已删除 `electron/`、`build/`、mac/win/linux 打包脚本与发布工作流、`package.json` 的 `electron*` 脚本与依赖，以及前端 `window.innoDesktop` 桥接、窗口宽度扩展、`ui.closeBehavior` 配置与 `PUT /api/settings/close-behavior`。部署清单统一放在 `deploy/`：`Dockerfile.backend`（仅 API）、`Dockerfile.frontend`（nginx + 静态前端，反代 `/api`、`/health`）、`docker-compose.yml`；原单体 `Dockerfile` 与 `Dockerfile.base` 已删除。浏览器版面板开关保留为 `PanelToggles`。
- benchmark 现状：单条读/写 ~0.2–2.7ms PG 固有开销可接受；`commit 100 entries` 批量化后仍 ~74–140ms（Docker PG 往返主导），若真实部署往返更低可复跑基线；进一步压缩需减少 fencing UPDATE/unnest INSERT 的往返（如 PREPARE 或单语句复合写）。

### H5 无状态后端：会话文件离开 worker 磁盘（进行中：S0、S1、S2、S3 核心已完成，其余未开始）

**进度**（实施顺序：S0 → S1 → S2 → S3 → S4 → 阶段 6，每一步系统保持一致、可上线）：
- S0 已完成：T0.2 故障注入测试（`agent/durable-tool-replay.test.ts`）。
- S1 已完成：T1.1/T1.2（迁移 v12、`WorkspaceStore` 接口与 `ObjectWorkspaceStore`/`LocalFsWorkspaceStore` 两个实现、14 项共用契约测试、复制器支持空目录）；T1.3 的读路由部分（目录树、文件内容、raw、下载文件夹、office/pptx 预览改读 `WorkspaceStore`；认证模式且对象存储为 `s3`/`fs` 时读对象存储与 PG 清单，不碰 worker 磁盘）；S1c（`workspace_change` 事件发布前先 `replica.push`，按工作区排队合并、10 秒上限，`drain()` 保证 `done` 不会先于最后一次变化事件，见 `server/replica-push.ts`）。
- S2 已完成（T2.1 到 T2.5，行为不变的重构）：新增 `WorkspaceFileAccess` 接口（`workspace/workspace-files.ts`：`toRelative`/`stat`/`read`/`withLocalFile`/`withLocalDir`）与两个实现——`LocalWorkspaceFileAccess`（真实目录，沿用 `checkWorkspaceMutationPath` 的判定，不复制文件）和 `StoreWorkspaceFileAccess`（任意 `WorkspaceStore`，需要真实路径时物化到 0700 临时目录并保证清理）。`parse_document`、`ocr_image`、`send_file_to_channel`（发件箱快照在临时文件清理前完成）、`l2_archive` 的文件分支、工作区上下文（`agent.md`、`.skills`）都改走该接口；`durable-session-service` 每次打开运行时创建一个 `LocalWorkspaceFileAccess`，所以当前行为与改造前一致。三个实现共用契约测试，五类工具有 Local 与 Store(对象存储) 的结果一致性测试。阶段 3 换执行目录时只需改 `durable-session-service` 里的接线。
- S3 核心已完成（T3.0/T3.1/T3.2 的本地一期）：`INNO_EXEC_BACKEND=local` 时 `LocalExecManager`（`sandbox/local-exec-manager.ts`）经 `SandboxRuntimeBinding` 把会话工作目录挂成 `LocalDirSandbox`，`bash` 随绑定自动注册，本地与认证模式都生效；env 走 `SandboxExecutionEnv`，路径语义与真实沙箱一致。`beforeTurn` 增量 `replica.pull`（面板经对象存储的写、其他 worker 的写在下一轮前可见），`pullToHost`（每轮 settle 后）与 `release` 增量 `replica.push`。远程沙箱开启时 E2B 优先，开关默认 `persistent`（不启用本地 bash）。`LocalDirSandbox` 已生产化：文件操作做 realpath containment（逃逸符号链接报 permission_denied 而非跟随），shell 本身不隔离（第一期已知并接受）。集成测试证明：`INNO_EXEC_BACKEND=local` + fs 对象存储下 bash 写文件 → 字节进对象存储 → 删本地目录后面板照常读。
- S3 的取舍（与阶段 3 原方案的偏差）：没有做"每任务一个临时目录"——工作目录仍是 `resolveWorkspaceDir` 的稳定路径，但作为可随时丢弃的工作副本存在（pull 可重建，push 只删除自身状态文件里已知的文件，所以从未拉取的 worker 上写路由+push 是安全的）。写路由与附件上传因此不需要改动，对象存储直写面板仍留待 T1.4。T3.5/T4 的孤儿目录清理、遗留临时目录清扫仍未做。
- S3 剩余已完成（T3.0/T3.1 的懒激活与并发上限、T4.2、T5.1）：`GatedLocalBackend` 包住 `LocalDirSandbox`，第一次文件/命令操作才占并发位（纯推理会话不占位），`INNO_EXEC_LOCAL_MAX_CONCURRENT`（默认 0 不限）超限返回 `SandboxRunError("unavailable")` 的可重试拒绝，`release` 归还；包装方法全部 async，超限是 rejected promise 而非同步抛错。指标：`inno_workspace_replica_push_ms`/`pull_ms`、`inno_workspace_replica_uploaded_bytes`/`downloaded_bytes`、`inno_local_exec_pull_ms`/`push_ms`、`inno_local_exec_pull_errors_total`/`push_errors_total`/`busy_total`/`activations_total`。T5.1 集成测试（`server.integration.test.ts`）：`INNO_EXEC_BACKEND=local` + fs 对象存储下 bash 写文件 → SIGKILL → 删本地工作区目录 → 新进程重启后打开会话经 pull 从对象存储重建本地副本并完成新一轮。测试证实一个既有恢复行为：SIGKILL 发生在 done 事件 fire-and-forget 落盘前后时，journal 里的 turn 恢复为 active，新 prompt 按设计返回 409，需先走 `/api/chat/events` 重放让孤儿 projection 收尾（真实客户端的 SSE 重连路径），此后一切正常。
- T2.6 已完成：全局技能随后端镜像分发（见任务表）。- 未开始：T1.4 附件/写路由走对象存储（可选）、T1.5、T3.3 到 T3.6、阶段 4 的 T4.1、阶段 5 的 T5.2/T5.3、阶段 6。
- 守卫：对象存储未配置（默认 `memory`）时，认证模式仍读本地磁盘并在启动时告警。原因：内存对象存储进程重启后字节丢失而清单仍在，面板会列出打不开的文件，且复制器的本地状态认为已推送，不会重传。

**S1 实施中的发现**：
- 复制器上限（5000 个文件、单文件 20 MiB、深度 24）远低于 `WorkspaceStore` 的 192 MiB 单文件上限与无限深度：本地创建的超限文件不会复制，两种实现在边界处行为不一致，需在写路由迁移时统一。
- 对象删除、移动、`deleteAll` 在清单提交后尽力删除对象，失败只记日志，没有清理孤儿对象的任务；需要一个按 `list(prefix)` 对比清单的清扫器。
- `starts_with(rel_path, prefix)` 在 `(tenant_id, workspace_id)` 主键前缀范围内做顺序扫描，随工作区文件数线性增长；存在性与最大 mtime 检查已改为单条聚合查询（`summarizeWorkspacePrefix`），列表与遍历仍取回子树全部行（上限 10 万行）。
- 行为差异：`normalizeWorkspacePath` 比旧的 `normalizeWorkspaceRelativePath` 严格，反斜杠输入现在返回 404（原先改写为 `/`）；指向工作区外的符号链接不再列出（原先作为无子节点显示）；认证模式下目录树的 `root` 为空字符串（前端不使用）。
- S2 中仅 Store 实现才有的差异：`parse_document` 的 `details.filePath` 是临时物化路径；`l2_archive` 经接口找不到文件时返回 `outside_workspace`（原为解析错误）；工作区技能的 `<location>` 指向物化出的 `.skills` 目录；`toRelative` 对 `a\b` 这类 POSIX 合法但不可寻址的名字返回 null。遗留在 `node:fs` 上的只有 `restrictToWorkspace === false` 的本地模式分支和未传 `files` 的旧调用方，工具层之外 `ChannelToolsDeps.workspaceDir` 与 `workspaceRegistry` 回退仍为非 durable 调用方保留。
- S1c 对后续的约束：推送源是会话的持久本地目录 `state.workspaceRoot`；阶段 3 把执行目录换成每任务临时目录时，推送必须改为以实际物化的目录为源。10 秒上限意味着极大的变化突发可能在最后字节落地前发布事件，面板下一个事件会补上。

**动机**：现在 `read`/`write`/`edit` 固定注册（`durable-session-service.ts` 里 `workspaceTools: true`）并写 worker 本地磁盘；本地文件模式下磁盘是唯一状态，无法横向扩展。H4 的 workspace 复制只把本地盘变成"可恢复的缓存"：写入先落本地，worker 在一轮对话中途死亡会丢这一轮的写入。目标是后端不再持有任何会话文件。

**核心决定：执行环境是一次性的，OSS 是唯一状态来源。** 执行环境（本地临时目录或沙箱）不依赖暂停/恢复/快照，也不要求共享存储；任务结束把变化推回 OSS 后环境即销毁。业界做法（OpenAI Code Interpreter 要求把容器当临时的并自行保存数据、Cloudflare Sandbox 把目录备份到 R2 后可销毁沙箱、Perplexity SPACE 的无状态控制面）都在把状态移出编排层。

**统一执行抽象层（已存在，沿用）**：所有工具执行都经 `sandbox/sandbox-backend.ts` 的 `SandboxBackend`/`SandboxProvider`（文件读写/列表/`run`/销毁），上层（`SandboxExecutionEnv`、同步、生命周期）只依赖该接口。分两期实施，抽象层不变：
- 第一期：由本地 provider 实现——每个任务在 worker 上建一个临时目录，全部工具（含 `bash`）在其中本地执行。起点是 `sandbox/local-backend.ts` 的 `LocalDirSandbox`（目前仅测试替身），需做成可用于生产的实现（临时目录生命周期、崩溃后的残留清理、并发上限）。第一期本地执行没有隔离，该风险已知并接受，随迁移到沙箱消失。
- 后期：把 provider 换成实现 E2B 协议的沙箱（`E2BSandboxProvider` 已有），上层与同步流程不改。

**已定设计**：
- 普通会话不依赖执行环境：聊天、L2/L3 记忆、联网搜索、提问、OCR、文档解析都不需要文件系统，状态在 PG 与对象存储。
- 附件进对象存储：上传直接写对象存储并登记 `workspace_files`，`parse_document`/`ocr_image`/`send_file_to_channel` 改为按对象取字节，不再按宿主机路径读。
- 能力扩展靠技能，不靠新增工具：内置工具集保持很小（`read`/`write`/`edit`/`bash` 加少数内置工具），新能力以技能形式提供（全局技能目录与工作区 `.skills/`，说明进提示词，脚本由模型经 `bash`/`read` 执行）。因此执行环境（含 `bash`）是唯一关键抽象，`SandboxBackend` 的文件与命令接口必须稳定，任何 provider 都要满足。内置工具若要访问文件，只能通过注入的 `env` 或 `WorkspaceStore`，不得直接 `import node:fs` 读写工作区路径。
- 工作面板与对象存储的交互（参考业界主流：AWS 预签名 URL 指南、Vercel Blob 客户端直传）：元数据（目录树、列表、改名、删除、移动、权限检查）与小文件/文本保存走后端 `WorkspaceStore` API；大文件上传、下载与二进制预览走预签名 URL 浏览器直连对象存储，后端不在字节路径上。面板始终读取对象存储与 PG 清单，不读 worker 磁盘；后端服务器只做计算，不留会话状态。
- 模型自己调用才创建执行环境：`bash`/`read`/`write`/`edit` 被调用时才懒创建（`GuardedSandboxBackend` 本就以"尚未就绪"启动，由 `activate()` 占配额并连接）。
- 一次任务的流程：首次调用文件/命令工具 → 新建执行环境 → 从 OSS 拉工作区所需文件 → 执行 → 变化文件推回 OSS 并更新 `workspace_files` → 销毁。下一次任务重新创建，重复同一流程。前端预览/下载走对象存储。认证模式下不再有写 worker 持久目录的本地文件工具。
- 配额与并发按任务计；E2B 沙箱的 ID 仅用于进行中任务与孤儿清理（`sandbox:fsck`），不再长期保存为会话状态。

**可复用**：`workspace-replica.ts` 的上传/下载/清单逻辑、`workspace_files` 与 `session_workspaces` 表、`WorkspaceSync` 的清单 diff 机制（宿主侧换成 OSS 与 PG 清单）、`GuardedSandboxBackend` 的懒就绪机制、`SandboxBackend`/`SandboxProvider` 抽象与 `LocalDirSandbox`。

**任务拆分**（S/M/L 仅表示相对难度，不代表工期）：

阶段 0：先核实一个不确定项

| 任务 | 内容 | 产出 | 规模 |
|---|---|---|---|
| T0.2 | 核实 pi-durable 恢复语义：工具执行中途 worker 死亡，已提交的 `bash` 调用恢复时是否重放。读文档与源码的结论是：工具未声明 `replay: "safe"` 时默认按 `unsafe` 处理（`harness/tool.js`），恢复时不重跑，模型收到带已提交输出的 `interrupted` 错误结果；pi-durable 自带的 `bash`/`write`/`edit` 未声明 `replay`。**已验证（`agent/durable-tool-replay.test.ts`，故障注入，3/3 通过，重复运行 3 次稳定）**：SIGKILL 后重开，内置 `bash` 与未声明 `replay` 的自定义工具都不会被重跑（计数文件保持 1 行），轮次正常结束，模型收到 `isError` 且文本含 `interrupted` 的结果，崩溃前已提交的部分输出（约每 100ms 一次进度提交）保留在结果里；声明 `replay: "safe"` 的对照工具会被重跑（计数 2），证明不是假阴性。结论：不需要任务幂等标记，进行中任务崩溃由模型看到"被中断"后自行决定是否重试 | 重放结论已定；无需幂等标记 | M（已完成） |

阶段 1：对象存储版工作区服务（第 1 批）

| 任务 | 内容 | 规模 |
|---|---|---|
| T1.1 | **（接口已定，见 `workspace/workspace-store.ts`；清单表加 `kind` 列的迁移 v12 表示目录，空目录是一行 `kind='directory'` 的清单行，没有对应对象；改名/移动目录为"逐个复制字节 → 单事务改清单 → 删旧对象"，清单晚于字节、删除时清单先于字节）** 定义 `WorkspaceStore` 接口（列表/读/写/删/改名/移动/stat）并实现对象存储版：数据来自 `ObjectStore` 与 PG 的 `workspace_files`；复用 `tenantObjectKey`；使用虚拟路径并沿用现有路径遍历防护规则；大目录分页。`ObjectStore` 接口保持现状（底层为 `@aws-sdk/client-s3`） | L |
| T1.2 | 本地文件版实现（本地模式仍为文件存储），与对象存储版共用同一接口；由"认证模式且已配置对象存储"选择实现 | M |
| T1.3 | `routes/workspaces.ts`（约 1100 行）迁移到 `WorkspaceStore`，**分两步**：先迁读路由（目录树、文件内容、raw、下载文件夹、office/pptx 预览——后两者调用 LibreOffice/Python，需把对象取到系统临时文件，转换后删除），此时执行仍在本地持久目录、H4 复制负责把数据推进对象存储；写路由（保存、新建、重命名、删除、移动、上传、技能上传、导入）在执行环境切到临时目录（阶段 3）时一并迁移，避免面板写对象存储而 agent 仍读本地目录的不一致；认证模式下 `resolveRequestWorkspace` 不再创建本地目录；重写相关测试 | L |
| T1.4 | 聊天附件与内联图片的上传路径改写到 `WorkspaceStore` | M |
| T1.5 | 预签名直连（叠加项，第一期可先用后端代理跑通再做，依赖 T1.1）：`ObjectStore` 增加可选 `presign`（引入 `@aws-sdk/s3-request-presigner`，与已用的 `@aws-sdk/client-s3` 同一套 SDK）；上传流程为"后端按租户前缀生成 key 并写 `pending` 清单行 → 返回短有效期预签名 PUT → 浏览器直传 → 完成回调后端 `HeadObject` 校验大小与校验和 → 改为 `ready`"，回调按 key 幂等 upsert；下载与二进制预览按需签发短有效期 GET；大于 100 MB 用分片上传；桶保持私有并配置 CORS；清单只存 key，不存 URL | M |

阶段 2：按路径读文件的工具改道（第 2 批，依赖 T1.1，可与阶段 3 并行）

| 任务 | 内容 | 规模 |
|---|---|---|
| T2.1 | `parse_document` 从 `WorkspaceStore` 取字节；需要本地路径时用系统临时目录，用完即删，不作为状态 | M |
| T2.2 | `ocr_image` 同上 | M |
| T2.3 | `send_file_to_channel` 同上 | S |
| T2.4 | 审计其余约 15 个引用 `workspaceDir` 的文件（`durable-memory`、`durable-channels`、`durable-questions`、`l2-tools` 等），逐个判断是本地路径还是应改走存储；改造完成后手写的 `HOST_PATH_TOOLS` 清单（`durable-runtime.ts`）及 `pullBeforeHostPathTools` 即可删除 | M |
| T2.5 | `workspace-context` 的 `agent.md`、工作区 `.skills/` 改从 `WorkspaceStore` 读取 | S |
| T2.6 | ~~全局技能的来源~~ **已完成（随镜像分发）**：根目录 `skills/` 打进后端镜像（`deploy/Dockerfile.backend` 复制到 `/app/skills` 并设 `INNO_SKILLS_DIR=/app/skills`，compose 同步更新并移除本地挂载），`.dockerignore` 加了 `!skills/**` 例外。理由：认证模式下共享技能管理本来就是只读（409），与镜像分发天然一致；本地开发用 `INNO_SKILLS_DIR=./skills` 或 `runtime/skills` 调试，发版时拷进 `skills/` 重建镜像即可覆盖所有 worker。技能激活进沙箱仍走 `SANDBOX_SKILLS_ROOT` 约定，本地执行时 bash 可直接按绝对路径读 `/app/skills` | S |

阶段 3：无状态执行环境（第 3 批，依赖 T0.2 与 T1.1，最关键）

| 任务 | 内容 | 规模 |
|---|---|---|
| T3.0 | ~~本地 `SandboxProvider`（第一期实现）~~ **部分完成**：`LocalExecManager` + `LocalDirSandbox`（realpath containment 已生产化，通过 `SandboxExecutionEnv` 一致性套件与端到端 bash 用例）；按任务临时目录与启动清扫未做——S3 偏差决定：工作目录是可丢弃工作副本而非每任务临时目录，故无遗留目录可清扫；`INNO_EXEC_LOCAL_MAX_CONCURRENT` 并发上限已实现 | M |
| T3.1 | ~~懒激活~~ **已完成**：`GatedLocalBackend` 在第一次文件/命令操作时才占并发位（`inno_local_exec_activations_total`），纯推理会话不占位；超限返回 `unavailable` 可重试拒绝 | M |
| T3.2 | 同步层：`WorkspaceSync` 的宿主侧换成 `WorkspaceStore`；激活时按清单拉取，之后增量推送且幂等；保留忽略目录与 20 MiB/5000 个文件/深度 24 的上限；定义删除的传播规则 | L |
| T3.3 | 推送时机：写文件类工具调用完成且无命令在运行时增量推送，避免推到写了一半的文件 | M |
| T3.4 | 生命周期：任务结束或 runtime 关闭时最终推送并销毁执行环境；更新孤儿清理（`sandbox:fsck`，另需覆盖本地临时目录），环境 ID 只用于进行中任务 | M |
| T3.5 | 工具集：认证模式下 `read`/`write`/`edit`/`bash` 全部经 provider 执行，去掉写 worker 持久目录的 `WorkspaceFileEnv`；由配置选择 provider（本地/E2B 协议） | M |
| T3.6 | 提示词里的路径改写（`rebasePaths`、`promptSection`）适配新流程，同时覆盖全局技能与工作区技能的路径 | S |

阶段 4：清理

| 任务 | 内容 | 规模 |
|---|---|---|
| T4.1 | 删除认证模式下已无用的本地目录复制路径（本地模式保留）；该处代码是 H4 刚做的，需谨慎 | M |
| T4.2 | ~~增加指标~~ **已完成**：replica push/pull 耗时与上传/下载字节、local exec pull/push 耗时与错误、激活与 busy 计数；`CLAUDE.md`、roadmap、`.env.example` 已更新 | S |

阶段 5：验证（本地 provider）

| 任务 | 内容 | 规模 |
|---|---|---|
| T5.1 | ~~集成测试~~ **已完成**（`server.integration.test.ts` 的 "local exec session survives SIGKILL"）：bash 产物已推送完整、删本地目录后重启 worker 经 pull 重建并完成新一轮；无每任务临时目录，故无遗留目录清理项 | L |
| T5.2 | 多租户隔离：存储键、清单、下载接口的跨租户拒绝测试 | M |
| T5.3 | 性能基线：拉取耗时随文件数的变化，据此决定是否做按需拉取 | M |

阶段 6：接入真实沙箱（后期，抽象层不变）

| 任务 | 内容 | 规模 |
|---|---|---|
| T6.1 | 对自部署的 E2B 协议服务跑 live 验收：下方清单加无状态流程用例（创建 → 同步进去 → 执行 → 同步出来 → 销毁）；`e2b-live.integration.test.ts` 的暂停/恢复用例改为可跳过 | M |
| T6.2 | 按 T6.1 的缺口清单在 `e2b-backend.ts` 里补绕开方案 | M |
| T6.3 | 配置切换 provider 到 E2B 协议沙箱；补"杀沙箱"故障用例（任务进行中沙箱死亡，已推送产物完整） | M |

依赖与并行：T0.2、T1.1 互不依赖，可同时开始；T1.2/T1.3/T1.4 依赖 T1.1；阶段 2 依赖 T1.1，可与阶段 3 并行；阶段 3 依赖 T0.2 与 T1.1（T3.0 不依赖 T1.1，可更早开始）；阶段 4、5 在其后；阶段 6 在阶段 5 之后择机进行，不阻塞前面任何阶段。

**决策点**：
1. 本地模式保留文件存储（T1.2）；若连本地模式也一并去掉，工作量会明显增大。
2. 工作面板与对象存储的交互采用业界主流的组合：元数据与小文件走后端 API，大文件字节走预签名直连（T1.5）；第一期可先全部走后端代理，T1.5 作为叠加项。`ObjectStore` 接口现有方法保持不变，仅新增可选的 `presign`。
3. 增量推送粒度：倾向于每次写文件类工具调用后推送一次。

**E2B 协议 live 验收清单**（T6.1 使用；只依赖 `create`/命令/文件/`kill`，不依赖暂停与快照；第三方实现的兼容性文档通常按 Python SDK 测试，本项目用 JS SDK，故必须实测）：
- 文件：`read`/`write`/`list`（含 `depth`）/`getInfo`/`makeDir`/`remove`/`rename`，含二进制与中文文件名。
- 命令：`commands.run` 流式 `onStdout`、退出码、超时、`AbortSignal` 中止；中止与超时路径依赖命令句柄的 `kill()`，部分实现不暴露按 pid 的杀进程接口，需确认句柄级 `kill()` 可用。
- 创建时的网络策略：`allowInternetAccess=false` 与 `network.denyOut/allowOut` 白名单是否真正生效。
- 孤儿清理：`Sandbox.list` 的状态/元数据过滤能否支撑 `sandbox:fsck`（有的实现不支持按时间排序与过滤）。
- 生命周期：`setTimeout`/`connect` 的超时语义（固定截止时间 vs 空闲窗口），确认一次性任务下的保活与回收行为。
- 工作区路径：`/home/user/workspace` 对沙箱用户可写（部分实现默认 root 用户）。
- SDK 版本：服务端声明支持的 SDK 版本与 `package.json` 里 `e2b` 的版本是否一致，差异需实测覆盖。

**待定项**：
- 执行环境把产物推回 OSS 的方式：第一版由后端 worker 经 provider 的文件接口读出再上传 OSS；沙箱阶段可评估让沙箱用预签名 URL 直传 OSS（需放行 OSS 域名并把预签名范围限定在该租户前缀）。
- 浏览器直传时对象元数据里没有 `sha256`（`S3ObjectStore.put` 目前把 `sha256` 写进对象元数据供清单校验）：改用签名里的校验和头，或 `HeadObject` 后由后端补算；所用 OSS 对校验和头的支持程度需实测。
- 增量推送的触发粒度（每次写文件类工具调用后，还是固定间隔）。
- ~~全局技能的分发方式（T2.6）~~ 已定：随后端镜像分发（见 T2.6）。
- 技能需要 API 密钥时的注入方式（按租户注入到执行环境，不写进技能文件）；第一期本地执行可暂缓，迁移到沙箱时需要。

**已知风险**：
- 第一期工具（含 `bash`）在 worker 上本地执行，没有隔离；该风险已知并接受，迁移到沙箱后消失。
- 技能脚本依赖 `bash` 与运行环境：技能需要的 Python 包、命令行工具必须预装在后端镜像（第一期）或沙箱模板（后期），否则每个任务都要重装；技能访问外网时，迁移到沙箱后需在出口白名单里放行对应域名。
- 只在结束时同步会丢中途产物，故需增量推送；环境在两次推送之间死亡仍会丢这一小段。
- 每次任务都是冷启动：依赖、虚拟环境和缓存不保留（`WorkspaceSync` 本就忽略 `.venv`、`node_modules`）；本地 provider 依赖 worker 镜像里预装的工具，沙箱阶段依赖模板预装。
- 新环境是空盘，工作区文件多时首次拉取较慢；沿用单文件 20 MiB、5000 个文件、深度 24 的上限，并考虑按需拉取。
- 预览与文件树改读对象存储后延迟升高，大目录需分页。
- 对象存储文件级"后写覆盖"，并行任务写同一路径会互相覆盖；预签名 URL 在有效期内可重复使用，同样是后写覆盖。
- 预签名 URL 本身相当于公开资源：必须短有效期、限定单个对象与方法，桶保持私有；key 一律由服务端生成，不接受客户端指定。

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
