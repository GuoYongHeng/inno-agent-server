# 变更说明：本地磁盘只保留三处（移除 INNO_DATA_DIR）

> 范围：`dev` 分支 `248191d`（交接文档）之后的未提交改动，共 75 个文件。
> 读者：需要核验这次破坏性更新的人。**不迁移任何历史数据。**

## 1. 准则

后端与本地磁盘交互只允许三处：

1. **配置文件**：`INNO_CONFIG_DIR` 下的 `config.json`、`skills.json`，以及技能目录 `INNO_SKILLS_DIR`。
2. **agent 执行任务的工作目录**：`INNO_WORKSPACE_DIR`。**当前没有远程沙箱**，服务器本地的 workspace 就是执行环境。
3. **日志**：默认写 stdout；在 `config.json` 里配置 `logging.dir` 才写文件。

除此之外，会话、记忆、配置、元数据、缓存、同步状态一律直接读写 PostgreSQL 或对象存储，不在本地落任何文件、缓存或临时文件。远程沙箱（E2B 等）相关路径本次**不在核验范围**——当前部署不用它。

## 2. 对外可见的变化（部署/运维）

| 项 | 之前 | 现在 |
|---|---|---|
| 环境变量 `INNO_DATA_DIR` | 存在，默认 `<home>/data` | **删除** |
| CLI 参数 `--data` / `--data-dir` | 存在 | **删除**（传入会被当作未知参数忽略） |
| 日志 | 固定写 `<dataDir>/log/server-*.log` | 默认 stdout；`config.json` 的 `logging.dir` 非空时写 `<dir>/server-YYYY-MM-DD.log` |
| `durable:fsck` 命令 | 存在 | **删除**（根目录 `package.json` 与 `apps/inno-agent/package.json` 的脚本也已删除） |
| 启动后的孤儿目录审计 | 存在 | **删除** |
| `Dockerfile.backend` | 设置 `INNO_DATA_DIR` | 不再设置；新增 `COPY apps/inno-agent/presets/ /app/apps/inno-agent/presets/`（包内默认路径） |
| 预设（Simple Mode 模板） | 从内容中心远程下载 + 本地缓存，随应用打包的作离线兜底 | **只读镜像目录**；路径由 `config.json` 的 `presets.dir` 配置（默认 `<code>/presets`），无 `INNO_PRESETS_DIR` / `--presets`，不再下载、不再缓存 |
| `contentHub.presetsPath` | 存在 | **删除**（`config.example.json`、后端类型、设置页输入框同步删除）；`contentHub` 现在只管技能库 |
| compose 注释、`.env.example`、两份 README、`QUICKSTART.md`、`SYSTEM_DEPENDENCIES.md` | 提到 data 目录 | 已同步 |

新增配置项（platform 级，不读租户配置）：

```json
"logging": { "dir": "/var/log/inno-agent" },
"presets": { "dir": "/app/apps/inno-agent/presets" }
```

`logging.dir`：
- 留空或不配：只写 stdout。
- 进程启动时由 `readLoggingDir`（`config.ts`）单独读取这一项，不依赖完整配置的懒加载，所以其他配置有误也不影响日志。
- 相对路径按进程工作目录解析；目录不可写时向 stderr 报一行错并回退到 stdout，不会让服务起不来。

`presets.dir`：
- 留空或不配：用 `<codeDir>/presets`（镜像里即 `/app/apps/inno-agent/presets`）。
- 由 `readPresetsDir` 在 `resolveRuntimePaths` 时单独读取，不依赖完整配置校验。
- 相对路径按进程工作目录解析；无环境变量 / CLI 覆盖。

`config.example.json` 增加了 `logging.dir: ""` 与 `presets.dir: ""` 示例。

## 3. 代码层面的变化

### 3.1 路径体系（`runtime.ts`、`tenants/paths.ts`、`config.ts`）
- `RuntimePaths` 删除 `dataDir`、`sessionDir`、`jobsDir`、`l2DataDir`、`l3DataDir`、`presetCacheDir`。
- `applyRuntimeEnvironment` 不再回写 `INNO_DATA_DIR`。
- `config.ts` 删除遗留的 `getDataDir/getRuntimeDataDir/getSessionDir/getJobsDir/getL2DataDir`。
- 新增常量 `VIRTUAL_TENANT_ROOT = "/inno-virtual"`（`tenants/paths.ts`）。租户的 L2 wiki、L3 索引、durable 会话仍用 `<root>/tenants/<id>/<domain>` 形式的字符串作为**后端标识 key**，但这个目录**从不创建、从不存放数据**；它是不可写的绝对路径，万一有代码误写本地会直接报错。`server.ts` 里的 `dataDir` 局部变量现在就是这个常量。

### 3.2 日志（`logger.ts`、`server.ts`）
- `StdoutStream` + 按需切换的 `LogStream`；新增 `configureLogging({ dir })`，`server.ts` 启动时调用。
- 新增 `logger.test.ts`（写文件、懒创建目录、`readLoggingDir` 容错）。
- `vitest.config.ts` 对单测设 `LOG_LEVEL=silent`；`vitest.setup.ts` 已删除（它只用来设置 `INNO_DATA_DIR`）。
- `fetch-logger.test.ts` 改为监听 `process.stdout.write` 捕获日志；`server.smoke.integration.test.ts` 改为在 config 里配置 `logging.dir`。

### 3.3 迁入 PostgreSQL `tenant_state`
| 数据 | 原位置 | 现在的 key |
|---|---|---|
| 会话附件元数据 | `sessions/attachments.json` | `attachments:<sessionId>` |
| workspace 文件活动 | `sessions/workspace-activity.json` | `activity:<sessionId>` |
| BTW 侧问状态 | `sessions/btw.json` | `btw:session:<sessionId>` + 租户级 `btw:window` |

- `tenants/state-store.ts` 新增 `updateTenantState`（按 租户+key 排队的读改写，因为 `tenant_state` 没有 CAS，而租户固定在一个 worker 上）和 `FileStateKv`（仅单测/本地回退）。
- `attachments-store.ts`、`btw-store.ts`、`workspace-activity-store.ts` 全部改为 async，第一个参数由 `dataDir` 改为 `TenantStateKv`；调用方（`durable-session-service`、`durable-routes`、`durable-job-runner`、`routes/btw`、`routes/workspaces`、`workspace-switch`）同步改为 await。
- BTW 保留“进程重启后第一次读取，把 pending 提问标为中断”的语义（进程内记录已处理的会话）。
- `workspace-activity-store` 不再读旧 trace；`trace-store.ts`（生产代码里没有任何写入方，且缓存是全局的，多租户会串数据）连同测试**整个删除**。
- 删除会话时一并清掉它的 BTW 状态（此前遗漏）。
- （附带、本次不核验）远程沙箱同步清单的代码也改成了可注入的 `tenant_state` 存储；当前部署走本地 workspace 执行，不会走到这条路径。

### 3.4 改为进程内存（不落盘）
- **`WorkspaceRegistry`**（`workspace-registry.ts`）：构造函数只剩 `workspaceDir`；`registry.json`、`sessions/workspaces.json` 不再读写，数据由 `WorkspaceReplica.materializeWorkspace` 按需从 PG（`tenant_workspaces`、`session_workspaces`）采纳。删除 `migrateUnboundSessions`。
- **`WorkspaceReplica`**（`workspace-replica.ts`）：构造函数去掉 `stateDir`；每个 工作区 的“已推送/已拉取文件状态”改为进程内 Map。
- **内容中心目录缓存**（`content-source/catalog-cache.ts`）：改为内存缓存；`ContentHubCatalog` 不再需要 `dataDir`。

### 3.5 预设（`presets/preset-store.ts`、`routes/presets.ts`、`routes/sessions.ts`、`content-source/*`）
预设内容随镜像打包：
- `RuntimePaths` 新增 `presetsDir`：来自 `config.json` 的 `presets.dir`（`readPresetsDir`），默认 `<codeDir>/presets`；**无** `INNO_PRESETS_DIR` / `--presets`。
- `preset.json` 可声明 `skills: string[]`（平台 catalog skill id）。`agent.md` 只读存在于镜像。
- `instantiatePreset` **只建空 workspace**（不拷贝模板）；会话记录 `presetId`（`durable_sessions.preset_id`，迁移 17）。打开运行时时从镜像注入 `agent.md`，并把预设 skills ∪ 租户已启用 skills 物化到 `.global-skills/`。
- `/api/presets` 与 `/api/preset-library` 返回同一份镜像内列表。
- 内容中心收窄为只有 skills 浏览；预设不在 hub。镜像：`Dockerfile.backend` COPY 到 `/app/apps/inno-agent/presets/`。

### 3.6 渠道（`channels/*`）
- `FeishuChannel` 不再有 `downloadDir`/`dataDir`：图片从流读入内存；**非图片文件不再下载**，只在提示里写“用户发送了文件「xxx」，通道暂不支持读取文件内容”（原先文件落在 agent 读不到的目录里，功能本来就不可用）。`MessageAttachment.filePath` 字段已删除。
- 渠道 outbox：`OutboxPayload` 为 `{ path?, bytes?, cleanup }`；认证模式 intent 在 `recovery_records`，**payload 在 ObjectStore**（`tenants/<t>/outbox/...`），不再进 `recovery_blobs` / PG bytea，也不落临时文件；发送时再读成 `bytes`。`ChatChannel.sendFile` 接受 `string | { bytes }`。bridge/wechat 仍抛 `FileSendNotSupportedError`。
- `TenantChannelManager` 去掉 `dataDir` 选项与 `channelsDataDir`；`channels` 路由去掉 `dataDir`，WeChat token 持久化缺失时报错而不是回退到目录。
- `PersonalChannelDispatcher.sessionDir` 改为可选（仅测试用的文件会话），生产走 `resolveSessionTarget`。

### 3.7 其他清理
- `server.ts`：删除 `ensureDir(sessionDir/jobsDir)`、旧 `.jsonl` 会话扫描、启动后的孤儿审计及其 import。
- `routes/workspaces.ts`：删除对 `sessions/*.jsonl` 的扫描和 `dataDir` 入参；`routes/wiki.ts` 的 `l2DataDir` 改为可选。
- 删除 `durable-fsck.ts`。`durable-audit.ts`、`durable-orphans.ts` 保留（仅单测等引用）。
- `.gitignore` 增加 `.inno-scratch/`（中途方案的残留条目，可删）。

## 4. 测试改动

- 新增：`logger.test.ts`；`server.integration.test.ts` 末尾新增 “local disk footprint” 用例，断言 `home/data`、`workspace/.inno-scratch`、`/inno-virtual` 都不存在。
- 删除：`trace-store.test.ts`。
- 预设相关：`server.integration.test.ts` 的预设用例改为在测试 `config.json` 里写 `presets.dir` 指向测试镜像目录，不再起 bundle 服务返回 tarball，也不再设置 `INNO_PRESETS_DIR`。
- 改写：`attachments`、`btw-store`、`workspace-activity-store`、`workspace-switch`、`workspace-replica`、`personal-dispatcher`、`tenant-channel-manager`、`channel-tools`、`durable-runtime`、`pg-channel-outbox.integration`、两个 workspace 路由测试、`server.integration`（预设改用测试内置的 bundle 服务返回 tarball；原来检查旧文件是否存在的断言改为查 `tenant_state` 行）、`durable-sharding.integration`、`server.smoke.integration`。
- 集成测试不再设置 `INNO_DATA_DIR`。

## 5. 如何核验

```bash
# 类型检查
npm --workspace inno-agent exec -- tsc --noEmit -p .

# 单测（预期 669 过；workspace-store.test 在受限环境里可能因写 .git/config 报 EPERM，与本改动无关）
npx vitest run apps/inno-agent/src

# 集成测试（需 docker，会拉 ParadeDB）。预期：18 个文件通过、2 个跳过
npm run test:integration

# 代码里不应再出现的东西
rg "INNO_DATA_DIR|--data-dir|\.inno-scratch" apps/inno-agent/src deploy .env.example README.md   # 仅测试断言与文档说明里应有
rg "readJson|writeJson|ensureDir|mkdtemp|tmpdir\(" apps/inno-agent/src -g '!*.test.ts'          # 逐个确认只属于工作区/配置/日志/技能或本地模式的测试替身
```

人工核验建议：
1. 起一个带 PG 的实例，跑一圈会话/附件/BTW/预设后执行 `find <INNO_WORKSPACE_DIR> -maxdepth 2`，确认只有各 workspace 目录。
2. 在 `config.json` 里设 `logging.dir`，确认日志文件生成；去掉后确认日志只在 stdout。
3. `SELECT key FROM tenant_state WHERE key ~ '^(attachments|activity|btw)'` 能看到对应行。
4. 重启服务后访问 `/api/workspaces`、打开已有会话，确认 workspace 与会话绑定能从 PG 恢复。

## 6. 已知限制与风险（请重点看）

1. **不迁移历史数据。** 旧的 `btw.json`、`attachments.json`、`workspace-activity.json`、`registry.json`、`workspaces.json` 内容全部丢弃：旧会话的附件气泡、BTW 标签页、切换工作区时的文件清单会消失。
2. **replica 状态重启即失。** 进程重启后，本地已有但没有记录的文件会被当作新文件重新上传（不会被误删），多一点流量；重启期间发生的本地删除不会同步。
3. **飞书非图片文件接收**功能被明确降级（见 3.6）。
4. **预设模板只读、随镜像：** 改 `agent.md` / `preset.json` 需重建镜像；用户工作区不再持有模板副本。远程内容中心里的预设不再生效。
5. **没有完全覆盖的磁盘接触：**
   - `INNO_OBJECT_STORAGE_PROVIDER=fs` 时对象存储本身落在本地目录（属于对象存储实现，不是应用状态）。
   - 文档解析（`@llamaindex/liteparse`）等第三方库自己是否使用临时文件，没有逐一审计。
   - 本地模式的文件版替身（`File*` 实现、`FileL2Backend` 回退、`FileStateKv`）仍在代码里，仅供单测，生产路径不会选用。
   - `/inno-virtual` 只是 key 命名空间；若以后有人往里写，会因为不可写而报错，而不是静默落盘。
6. **集成测试中 “restores tenant model … deferred jobs” 在整套并发运行时出现过一次超时**，单独运行与整套重跑均通过，疑为并发时序抖动。
7. `.gitignore` 里的 `.inno-scratch/` 和 `durable-audit/durable-orphans` 两个模块可视情况删除。
8. **远程沙箱不在本次范围。** 当前用服务器本地 workspace 做执行环境；代码里仍保留 E2B 相关路径，但核验与风险清单都不覆盖它。

## 7. 后续：平台技能目录（已实现）

共享技能不再依赖「下载 tar → 解压进 `INNO_SKILLS_DIR`」：

- 正文：`platform/skills/<id>/<version>/`（对象存储）+ `skill_catalog` / `tenant_skills`（PG，迁移 16）
- 租户启用：`POST /api/skills/:id/enable|disable` 或 `PATCH {enabled}`；`skill-library/import` 仅 enable 已发布项
- 会话：物化到 workspace `.global-skills/`（replica push 已排除该目录）
- 发布：`npm run skills:publish`；启动时从镜像 skills 目录 seed

## 8. 预设绑共享 skill + 只读 agent.md（已实现）

- 不再把 `agent.md` / `.skills/` 拷进用户 workspace；`ppt-builder` 迁到仓库 `skills/` 作为平台 skill。
- `preset.json.skills` + 会话 `presetId`；prompt 从镜像读说明、从 catalog 物化绑定技能。

## 9. 聊天图片只留路径（已实现）

浏览器在发消息前把图片上传到对象存储（可签名时直传，否则走 workspace upload），路径为 `.chat-images/<id>.<ext>`。`POST /api/chat` 与 `/api/chat/stream` 只接受 `{ workspacePath, mimeType }`，带 `data` 返回 400。durable 记录里是路径标记；请求模型时再读对象。

仍会短时使用系统临时目录的路径：技能 zip、工作区 zip 导入导出、Office/PPT 预览。`INNO_EXEC_BACKEND=local` 时工作区目录仍是执行现场。延迟任务定时器与进行中的 SSE 订阅仍在进程内存。

