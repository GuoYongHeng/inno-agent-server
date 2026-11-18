# S1 前置对齐结果

对应 [DURABLE_ROADMAP.md](./DURABLE_ROADMAP.md) 的阶段 S1。只做验证，没有改动任何源码。日期：2026-11-18，基于 `main`（`236ee80`）。

## 1. 基线

| 项 | 结果 |
|---|---|
| `npm run build`（后端 tsc + web vite） | 通过 |
| `npm test`（`vitest run`） | **132 个文件、981 个测试全部通过**，与 `CLAUDE.md` 所述一致 |
| `npm run test:integration` | **未能运行**：本机没有 PostgreSQL（`initdb` / `postgres` / `pg_ctl` 均不存在），`db/test-postgres.ts` 依赖 `initdb` 起临时实例。需要在装有 PostgreSQL 的机器或 CI 上取得基线（31 个测试，按 `CLAUDE.md`） |

## 2. 依赖树核对

`npm ls @earendil-works/pi-coding-agent` 的结果：除 `apps/inno-agent` 直接依赖外，间接依赖方只有

- `@gotgenes/pi-permission-system`
- `@juicesharp/rpiv-todo`
- `pi-web-access`
- `@juicesharp/rpiv-ask-user-question`（经 `inno-agent-web` 工作区声明）
- `pi-subagents`（经 `inno-agent-web` 工作区声明）

它们全部是路线图 S4/S5 要移除的插件，**没有发现路线图之外的间接依赖**。两点补充：

- `rpiv-ask-user-question` 和 `pi-subagents` 是声明在 **web 工作区**里的（不是后端），移除时要改 `apps/inno-agent/web/package.json`，路线图原来只写了后端依赖。
- `@earendil-works/pi-web-ui`（web 端 `^0.75.3`）**不依赖** pi-coding-agent，且 web 端有 6 个文件在用：`utils/markdown-math.ts`、`SkillsPanel.tsx`、`WorkspaceBrowser.tsx`、`office/XlsxPreview.tsx`、`office/DocxPreview.tsx`、`notebook/PageView.tsx`。结论：**pi-web-ui 保留**，root 里为它保留的旧版 `pi-ai` 也先不动（路线图待决问题 2 的答案）。

## 3. 本地模式（无 PostgreSQL）下 durable 是否可用

实测：用临时目录和一个假 provider 配置启动服务器，设置 `INNO_DURABLE_ENABLED=true`，不连任何数据库。

- `GET /health` 正常；`GET /api/session` 返回 `mode: "local"`、`durableEnabled: true`。
- `POST /api/sessions {"runtime":"durable"}` 返回 201 和 `durable-<uuid>`；`GET /api/sessions` 能列出该会话。
- 存储锁在无 PG 时是可选的，会话创建走本地配置回退，符合代码阅读（`acquireDurableStorageLock` 返回空即跳过）。

**没有验证**：真正发一轮对话（需要可用的模型端点）、重启后重放、工作区 `read`/`write`/`edit`。这些在 S3 的端到端测试里补。

## 4. 功能缺口清单（本地模式 durable vs legacy）

### 4.1 已覆盖（durable 路径已有对应路由或实现）

会话读取/详情、重命名（`PATCH`）、删除、归档/取消归档、`activate`、话题生成（`generate-topic`）、流式与非流式聊天、`question-response`、`permission-response`、**上下文用量**（`/api/sessions/:id/context-usage` 在 durable 资源路由里有处理）、BTW（快照与带回，durable 分支）、调度任务的 durable 执行器、渠道入站的 durable 提示执行（仅多用户分支）。

### 4.2 缺口（需要在 S2/S3 补齐或决定舍弃）

| # | 缺口 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| G1 | **全局技能目录不进 durable 提示** | `pi-runner.ts:374` 用 `additionalSkillPaths: [paths.skillsDir]` 加载全局技能；durable 只通过 `buildWorkspaceContextSections` 注入工作区 `.skills`（`durable-session-service.ts:723`） | 删掉 legacy 后，技能面板的上传、内容库导入、编辑、启停（`.ignore`）全部变成"能管理但不生效" | **必须补**：把全局技能（尊重 `.ignore`）按同一格式注入 durable 的 instructions；在 S2 自写技能加载时一并做 |
| G2 | **模型切换对既有会话无效** | `settings.ts` 的 `switchModel` 只作用于 legacy 单例；durable 在创建时把 provider/model 固定进会话目录（`durable-session-service.ts:348`），前端 `ChatCenter.tsx:316`、`ModelsSettings.tsx:272` 调 `settingsStore.switchModel` | 用户在对话中切换模型，只会影响之后新建的会话 | **已决定：durable 增加会话级换模型**，设计见第 6 节 |
| G3 | **本地模式渠道入站只有 legacy** | `server.ts:293-302` 的本地分支是 legacy 的 `runPromptSerialized`；durable 版（`:325-356`）只在多用户分支 | 删除 legacy 后本地模式渠道（飞书/微信/QQ）无法对话 | **必须补**：把多用户分支的 durable 渠道执行改为本地也使用（依赖 `TenantStore` 缺省实现） |
| G4 | **本地调度默认走 legacy** | `server.ts:479` 仅当多用户或 `job.runtime === "durable"` 才走 durable，否则 `createNewSession`（legacy）；`job-runner.ts:94` 的 `runPromptSerialized` | 旧任务元数据没有 `runtime` 字段时会走 legacy | **必须补**：所有 agent 任务一律 durable；提醒类任务不变 |
| G5 | **"全局活动会话"耦合面较大** | `getCurrentSessionId` / `getSession()` 在 `server.ts:262,1340`、`routes/chat.ts:399,457`、`routes/sessions.ts:335,349,619,802`、`routes/workspaces.ts:1014,1071`、`l3-tools.ts:203`、`inno-extension.ts:73`；`applyWorkspaceCwd` 切换工作区也走 legacy | S3 切换入口时每一处都要换成"请求里带的会话 ID" | S3 按此清单逐点替换；L3 当前会话排除改用显式会话 ID |
| G6 | **斜杠命令面板** | `ChatCenter.tsx` 使用 `api/commands`，对应 `/api/commands`（扩展命令、提示模板、技能） | 已确认舍弃；前端需要同步移除面板 | S4 删除，前端 `slash-palette` 相关代码一并清理 |
| G7 | **启动时必须 `initSession`** | `server.ts:434`；多用户模式也会初始化 legacy 单例 | 删除后启动流程要重排；本地模式配置错误（无 provider）的报错时机会变化 | S3 重排启动流程 |

### 4.3 未核对（S3 前补）

附件与内联图片在**本地**模式 durable 下的行为（`CLAUDE.md` 称已覆盖流式与非流式）、预设工作区打开后创建会话的路径、工作区切换（`applyWorkspaceCwd`）与 durable 会话的绑定、Wiki 上传等与会话无关的流程应无影响但未逐个验证。

## 5. 对路线图的修订建议

1. **S2 增加一项**：自写技能加载时同时覆盖"全局技能目录 + `.ignore`"，解决 G1（原先只写了工作区技能）。
2. **S3 增加两项**：G3（本地渠道走 durable）、G4（所有 agent 任务走 durable）；G5 作为带清单的子任务。
3. **S5 依赖清理**补充：web 工作区的 `rpiv-ask-user-question`、`pi-subagents`；`pi-web-ui` 保留，不动 root 旧版 `pi-ai`。
4. **取得集成测试基线**：在有 PostgreSQL 的环境补跑，作为 S3/S4 的比较对象。
5. **G2 已决定**：durable 增加会话级换模型，纳入 S3，设计见第 6 节。

## 6. G2 决定：durable 会话级换模型

**决定（用户确认）**：durable 会话支持在对话中切换模型，不再只影响新会话。

**可行性（已核对 pi-durable 1.4.0 README 与类型）**：`conversation.configure({ model: { provider, modelId } }, context)` 会把模型写入会话的 agent 配置；README 明确"一次请求的模型、提示和可用工具在准备时固定，变更从下一次请求起生效"。因此切换不会影响正在进行的 turn，也随 commit 持久化。

**设计要点**：

1. 新增会话级入口，例如 `PATCH /api/sessions/:id` 增加 `provider` / `modelId`，或单独的 `PUT /api/sessions/:id/model`。多用户模式下沿用现有会话所有权校验。
2. 服务端校验：目标 provider/model 必须存在于当前租户（本地为全局）配置里，且该模型的输入模态能满足会话里已有的图片内容，不满足则拒绝并返回明确错误。
3. 写入顺序：先调用 `configure({ model })` 提交，成功后再更新会话目录记录的 `provider` / `modelId`（目录里的值用于话题生成、会话摘要和 `getModels` 构造）。目录更新失败要可重试，不能让两处长期不一致；以 pi-durable 里已提交的 agent 配置为准，目录值可由它重建。
4. 进行中的 turn：不打断。如果会话当前有活动 turn，则对下一轮生效，并在响应里告知"将在下一条消息生效"。
5. `durable-session-service.ts` 里用到 `record.provider/modelId` 的地方（约第 425、485、681 行）要改为读取切换后的值，保证话题生成和图片原生/OCR 回退判断（`model.input.includes("image")`）与实际模型一致。
6. 前端：`ChatCenter` 的模型选择器对 durable 会话改为调用会话级接口，`settingsStore.switchModel` 保留为"设置默认模型（新会话使用）"。`ModelsSettings` 里的按钮语义同步调整。
7. 测试：切换后下一轮使用新模型；切换不影响进行中的 turn；SIGKILL 重启后仍用新模型；不存在的模型和不满足图片模态的模型被拒绝；跨租户切换他人会话返回 404。

**放入阶段**：S3（所有入口切到 durable）。依赖 S2 完成后才能删除 legacy 的 `switchModel`。
