# 交接：租户状态 PG 化与服务端托管设置

> 范围：`dev` 分支上 `2d56181` → `fcbc71c` 共 7 个提交。读者：接手本仓库后端/部署的工程师。

## 1. 目标

把多租户运行态的事实来源统一收敛到 PostgreSQL + 对象存储，本地磁盘降级为纯执行 scratch；同时把 provider/搜索/渠道凭据从"租户可配"收紧为"服务端托管、租户只选"。

原状（交接前）：

- 租户 config 以 `<dataDir>/tenants/<id>/config/config.json` 为读路径，每次请求从 `tenant_configs` 行物化到本地文件供同步代码消费——双写、双读，真源不唯一。
- 租户可通过 settings API 自写 provider/apiKey/tavily/渠道凭据。
- 渠道台账（default targets、dedupe、run log、chat 绑定、wechat token）、调度任务、打卡记录散落在 dataDir 文件。
- compose 里 `inno-agent-data`/`inno-agent-workspace` 挂持久卷，语义和"scratch"冲突。

## 2. 变更总览

| Commit | 内容 |
|---|---|
| `2d56181` | 调度任务/运行租约/打卡台账 → `tenant_jobs`/`tenant_job_runs`/`tenant_checkins`/`tenant_checkin_occurrences` |
| `c7ec9a7` | 渠道状态台账 → `tenant_state` KV（default targets、dedupe、run log、chat-session 绑定、wechat token） |
| `798a5d3` | settings 收紧：providers/tavily 写端点删除；`PUT /channels` 凭据字段 403；`GET /settings` 返回合并视图 + `serverManaged` 标志；bridge 入站改按认领解析租户 |
| `9f4a1c1` | 文档 + compose 第一轮更新（删废弃 env、auth 必配化、卷语义注释） |
| `44dbf4b` | 租户 config 改为直接 async 读 `tenant_configs` 行，删除文件物化整条链路 |
| `0539453` | compose 删除 `inno-agent-data`/`inno-agent-workspace` scratch 卷 |
| `fcbc71c` | 修正 MULTI_USER_DURABLE.md 的存储布局图（workspace 副本在 `INNO_WORKSPACE_DIR` 不在 dataDir） |

## 3. 现在的架构

### 3.1 配置三层模型

| 层 | 载体 | 内容 | 写入方 |
|---|---|---|---|
| 运维目录 | `<INNO_CONFIG_DIR>/config.json` | providers+apiKey、tavily、渠道端点/mode、bridge.token、sandbox、objectStorage、全局默认模型 | 运维手写（卷 `inno-agent-config`） |
| 进程环境 | `INNO_*`/`DATABASE_URL`/`BETTER_AUTH_*` | 路径、数据库、分片拓扑、sandbox/exec 开关 | 部署清单 |
| 租户选择 | PG `tenant_configs` 行 | defaultProvider/defaultModel、渠道 `enabled`/`personalOnly`/`allowedUserIds`、memory/smartInput/ui、feishu 个人凭据 | settings API |

读取时 `mergeTenantConfig(localConfig, tenantConfig)` 合并：服务端字段取全局、用户字段取租户（`tenants/config.ts`）。**没有任何文件物化**，消费方 `await loadTenantConfig(store, tenantId)` 直接查 PG 行。

### 3.2 settings API 边界

- 保留：`GET /api/settings`（合并视图 + `serverManaged: {providers, tavily, channelCredentials}`）、`POST /api/settings/model`（用户唯一写口，校验合并目录）、`PUT /api/settings/channels`（只接受 `enabled`/`personalOnly`/`allowedUserIds`/`feishu` 之外的开关字段）、`PUT /api/settings/memory`、sandbox/skill 等只读面。
- 删除：`/api/settings/providers*`、`/api/settings/tavily`、模型增删改端点（404）。
- `PUT /api/settings/channels` 对 `feishu`/`bridge` key 及 `mode`/`sidecarBaseUrl` 字段 → 403。
- **例外**：`feishu.appId/appSecret` 是租户字段——QR 注册流绑定租户个人飞书应用，不走 settings 写入。

Web 端按 `serverManaged` 标志隐藏 AddProviderWizard、模型编辑/删除、tavily 编辑、渠道凭据字段；模型选择按钮保留。

### 3.3 存储布局

```text
PG（真源）            : tenant_configs、tenant_state、tenant_jobs*、tenant_checkins*、
                      ds_*（durable storage）、durable_sessions、recovery_records、
                      workspace_files manifest、L2/L3 表、tenant_workspaces
对象存储（文件字节真源）: tenants/<t>/workspaces/<ws>/<path>、L2 二进制原件
INNO_WORKSPACE_DIR    : workspace 本地副本（.tmp/.pub/<wsId>/.channels/<t>/<ch>/.presets/...），scratch
INNO_DATA_DIR         : 元数据 scratch（attachments.json、workspace-activity.json、
                        replica 状态、registry.json 镜像）+ log/ + 缓存 + 渠道暂存
INNO_CONFIG_DIR       : config.json（运维目录）+ skills.json（全局技能开关，auth 下只读）
```

本地磁盘没有任何"丢了找不回"的字节；compose 只挂 `postgres-data`/`minio-data`/`inno-agent-config` 三个卷。

### 3.4 bridge 入站路由（重要行为变化）

共享 `bridge.token` 只用于认证 sidecar，**不再标识租户**。租户解析改按资源认领：

- `channel-chat:<ch>:<chatId>`：`POST /api/channels/<ch>/default-target` 绑定 chatId 时声明
- `channel-user:<ch>:<uid>`：`allowedUserIds` 同步时声明
- `feishu:<appId>`/`wechat:<botId>`：QR/注册绑定的个人凭据声明（不变）

畸形 body → 400（`handleBridge` 重跑 `handleBridgeMessage` 校验）；合法 token 但无认领 → 401；认领冲突 → `ResourceOwnershipError`（分片下由 owner worker 处理）。

### 3.5 渠道构建变异步

`TenantChannelManager.runtime()` 仍同步返回骨架（registry/dispatcher/ledgers），但 `createChannels`（需要 await resolved config）挪进 `runtime.hydrated` 承诺。同步注册表读取（`all`/`get`/`getDefaultTarget`）前必须先 `await manager.ready()`——channels 路由经 `ensureChannelsReady` 统一等待；`getWechatChannel`/`startWechatChannel` 均为 async。

## 4. 关键坑位

- **`normalizeConfig` 修复**：providers 为空时必须保留 `defaultProvider/defaultModel` 原值，否则租户保存的模型选择被校验逻辑剥成空、回落全局默认。这是合并语义下的真实 bug，测试逼出来的。
- **`loadTenantConfig` 对缺 `loadTenantConfigRecord` 的 store 容错**（`?.` 回落空租户配置）——scheduler/workspace 测试里的 `as unknown as TenantStore` 字面量依赖这一点。
- **`setDefaultModel` 校验用合并后的目录**，不是租户行自己的 providers（租户行 `providers:{}` 恒空）。
- 假 provider 测试以前用 apiKey 区分租户；共享 key 后改按请求 body 内容区分。

## 5. 验证状态

- `tsc --noEmit` 干净；单测 981/992（11 个 jsdom 环境失败，与改动前基线一致）。
- `server.integration.test.ts` **25/25**；`durable-sharding.integration.test.ts` **4/4**（ParadeDB 容器）。
- `docker compose config -q` 通过。

## 6. 遗留事项 / 可做方向

- `runtime.ts` 仍派生 `sessions/`、`jobs/`、`l2/`、`l3/` 路径——authenticated 模式基本不写，属本地模式遗留，未清理。
- `INNO_DATA_DIR`/`INNO_WORKSPACE_DIR` env 仍在（scratch 位置指针），如要极简可删 env 只留 `INNO_HOME` 推导，代价是 scratch 不可独立重定位。
- `skills.json` 全局技能开关在 auth 下只读，未做 per-tenant 技能开关。
- L1 learner-profile 的磁盘残留不做迁移（DURABLE_ROADMAP 已声明忽略）。
