# Durable 运行时分阶段重构设计

状态：草案（待评审）。本文基于对以下文件的阅读，以及 pi-durable 1.4.0 的类型声明和 README（已确认 `Storage` 与 `ExecutionEnv` 均为公开可替换接口）：`agent/durable-runtime.ts`、`agent/durable-session-service.ts`、`agent/durable-env.ts`、`agent/durable-memory.ts`、`tenants/schema.ts`、`storage/file-store.ts`。标注"待验证"的条目没有在代码或运行中确认。

## 1. 背景与目标

多用户 Durable 模式的恢复语义（请求去重、SSE 重放、question/permission 持久化、SIGKILL 恢复）已有测试覆盖，正确性设计较扎实。问题在于**状态与执行都绑定在单台机器的本地磁盘上**，因此无法做到弹性伸缩、自动故障转移和强隔离。

目标：

1. worker 无状态化：任意 worker 可接管任意租户的任意会话。
2. 会话/租户元数据可事务化、可备份、可查询。
3. 工具执行与宿主隔离，并在隔离之后才考虑开放 shell。
4. 每个阶段独立可上线、可回滚，不要求一次性重写。

非目标：改动 PI SDK 内核；改变 legacy（单机/桌面）模式；追求 exactly-once 的外部副作用（渠道发送、OCR 提交继续按 at-least-once 设计）。

## 2. 现状问题（带证据）

| 问题 | 位置 | 后果 |
|---|---|---|
| 会话目录是租户目录下的整文件 `sessions.json`，每次更新整文件读-改-写 | `durable-session-service.ts` `catalog()` / `writeCatalog()` / `update()`；`storage/file-store.ts` `writeJson` | 写放大 O(会话数)；仅靠同进程同步执行和"同租户固定路由到一个 worker"避免丢更新；原子 rename 只防损坏，不防并发覆盖 |
| 会话数据是每会话一个本地 `session.sqlite` | `durable-session-service.ts` `storage/<id>/session.sqlite`；`durable-runtime.ts` 单所有者守卫 | 数据绑定节点磁盘；节点故障即会话不可用 |
| 单所有者只有进程内 `Set` 加 PG advisory lock | `durable-runtime.ts` `openStoragePaths`；`durable-session-service.ts` `acquireDurableStorageLock` | 文档自述"不是抗网络分区的存储围栏"；无故障转移 |
| 租户到 worker 是静态哈希映射 | `tenants/durable-tenant-router.ts` | 不能动态扩缩容；换 worker 数等于重分片 |
| 状态散落四处且无跨存储事务 | PG（租户/归属/租约）、`sessions.json`、`session.sqlite`、流日志/question/permission 文件 | 创建/删除会话时 PG 归属行与目录项之间失败可能留下孤儿（待验证，见阶段 0） |
| 文件工具直接落宿主文件系统 | `durable-env.ts` `WorkspaceFileEnv extends NodeExecutionEnv` | 隔离只有应用层路径检查；检查与使用之间的符号链接竞态未验证 |
| 记忆/OCR/发件箱直接读写本地文件 | `durable-memory.ts`、`durable-ocr.ts`、`durable-channels.ts` | 同上，且不经过 `ExecutionEnv` 接缝 |
| 所有记忆工具被统一标 `replay: "safe"` | `durable-memory.ts` 末尾 `createDurableMemoryRegistrations` | 标记靠各工具自觉保证幂等，没有机制强制 |

## 3. 设计原则

- **先加测试和度量，再动存储。** 每个阶段的前置条件是上一阶段的故障注入和恢复测试保持绿色。
- **PostgreSQL 已经是依赖，优先复用它**，不引入新的有状态组件，除非阶段内明确论证。
- **双写、回填、开关、回滚**：每个迁移阶段都按"双写 → 回填 → 读切换 → 停止旧写"推进，旧存储保留到下一阶段验收后再删。
- **租户隔离改成数据层强制**：新增表一律带 `tenant_id`，查询经统一的租户作用域层，不依赖调用方记得过滤。

## 4. 阶段划分

### 阶段 0：基线与安全网（先行，约 1-2 周）

不改架构，只补验证能力。

- 创建/删除/改名会话的**故障注入测试**：在 PG 归属写入与目录写入之间、目录写入与 `session.sqlite` 创建之间分别模拟崩溃，确认是否留孤儿，并写出自检/修复脚本。
- 目录并发测试：同租户并发 create/update/rename 的丢更新测试，确认当前依赖的"同步 + 固定路由"假设在哪些路径上会失效。
- 符号链接竞态测试：`WorkspaceFileEnv` 在检查后替换为指向工作区外的链接，确认是否可逃逸。
- 指标：会话数 vs `sessions.json` 读写耗时；每租户磁盘占用；advisory lock 获取/丢失次数。
- 复核 `replay: "safe"`：逐个列出被标记的工具，写明各自的幂等依据（操作标记、内容哈希、天然幂等），缺依据的改标为非安全或补实现。注意 pi-durable 对非 safe 工具的崩溃行为是返回 `interrupted` 错误结果而不重跑，所以误标 safe 的风险是重复副作用，漏标的代价只是该次调用失败，应偏向保守。

**退出标准**：上述测试进入 CI；产出一份已知问题清单和容量基线。

### 阶段 1：会话目录迁移到 PostgreSQL（约 2-3 周）

目标：消除 `sessions.json` 和 PG 归属行之间的两阶段状态，归属与目录在同一事务内。

表设计草案（字段以 `DurableSessionRecord` 为准，以下为已见字段）：

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

- 创建会话：同一事务内写 `resource_ownership` 与 `durable_sessions`；`session.sqlite` 在事务提交后惰性创建，失败可重试且不留脏目录项。
- 更新使用 `UPDATE ... WHERE id=$1 AND tenant_id=$2` 加 `version` 检查，替代整文件覆盖。
- 迁移：服务启动时对每个租户把 `sessions.json` 回填到表（幂等 upsert）；上线期间双写；读切换由开关控制；旧文件保留一个版本周期。
- 本地/桌面模式不变，仍用 JSON 目录（通过一个 `SessionCatalog` 接口隔离两种实现）。

**退出标准**：阶段 0 的目录并发和孤儿测试在新实现上通过；会话数 10 万量级下列表/更新耗时有基线数据。

### 阶段 2：执行层隔离（约 3-5 周）

目标：文件类工具的执行不再发生在持有会话状态的 worker 宿主上。

`WorkspaceFileEnv` 已实现 pi-durable 的 `ExecutionEnv` 接口，这是现成的替换点。pi-durable 的 `env` 是**每次工具调用时的工厂**（`env: ({ cwd }) => ...`），自定义环境用 `id` 标识"同一套文件"，README 的约定是一个容器对应一个 id；README 还提到 pi-env 提供 `RemoteExecutionEnv`，可作为远程实现的起点（待验证其是否随依赖安装、是否满足租户隔离需求）。包内另带 `registerEnvConformance`（可选 `shell` / `symlinks` / `listFiles` 项），可直接用来验证新环境。

- 2a 抽出 `ExecutionEnv` 的工厂，使 `durable-runtime.ts` 不直接构造 `WorkspaceFileEnv`。保留现有本地实现作为默认，行为不变。
- 2b 实现 `SandboxedExecutionEnv`：每个租户（或会话）一个受限沙箱（容器加 gVisor/Firecracker 之一，选型待评审），工作区通过租户级卷挂载进沙箱；env 的每个方法转为对沙箱服务的调用。路径包含检查下沉到沙箱内（以内核级挂载边界为准，而非字符串检查）。
- 2c 在沙箱内才考虑开放 shell：默认关闭，经权限系统 `ask`，保持现有 deny floor；资源限额（CPU、内存、时间、网络出口）在沙箱层强制。
- 回放语义：README 写明工具调用先提交意图再执行，进程崩溃后只有声明 `replay: "safe"` 的工具会重跑，否则模型收到 `interrupted` 错误结果。因此 `write`/`edit` 是否标 safe 决定了崩溃后的行为；远程调用仍应带稳定的 tool-call ID 作为幂等键。

**退出标准**：同一套 `durable-env.test.ts` 加官方 `registerEnvConformance` 对本地与沙箱实现都通过；符号链接逃逸测试在沙箱实现下无法逃逸；沙箱服务宕机时工具调用 fail-closed 并可重试，不破坏会话。

### 阶段 3：记忆、OCR、发件箱与恢复记录迁出本地文件（约 4-6 周）

按风险从低到高分批，每批独立开关。

1. **恢复类记录**（question、permission、流日志、OCR 检查点、渠道发件箱）→ PG 表。幂等键直接变成唯一约束，例如 `UNIQUE (session_id, tool_call_id)`，取代文件里的操作标记。这批改动最能提升"replay: safe"的可信度。
2. **L1 学习者画像与事件** → PG（`tenant_id` 作用域，事件追加表加画像 JSONB 加版本号）。
3. **L2 wiki**：页面是文件加 manifest，按内容类型拆开——元数据/manifest 进 PG，大文件正文进对象存储；`wiki-graph`、搜索索引由派生任务重建。
4. **L3 召回**：当前是每租户 `node:sqlite` 加 FTS5；可迁到 PG（`tsvector`/`pg_trgm`），或保留 SQLite 作为可重建的缓存、以 PG 为准。先评估召回质量差异再定（待验证）。

**退出标准**：worker 重启或迁移不丢任何一类租户状态；任一租户目录整体删除后，从 PG 加对象存储能重建全部非缓存状态。

### 阶段 4：会话存储所有权与路由（约 3-6 周，依赖阶段 1-3）

**已确认（pi-durable 1.4.0 源码）**：`Storage` 是公开接口（`commit` / `mintId` / `scanEntries` 等十余个方法），`Harness.open(storage, ...)` 接受任意实现；包内已有 memory、jsonl、indexeddb、sqlite（node / cloudflare）几种后端，并随包提供 `createStorageConformance` / `registerStorageConformance`（可接入 Vitest）和 `storage-benchmark`。因此原先的"路径 B（网络卷上跑 SQLite）"不再需要，采用**路径 A：实现 PostgreSQL 后端的 `Storage`**。

实现要点（均来自 `Storage` 接口注释，需在实现中逐条满足）：

- `commit(writes)` 必须原子：一个 PG 事务写入一批 conversation/entry/task/submission/document 记录，返回单调的 `Seq`。
- `mintId()` 返回全局数字 ID 空间内单调递增、跨 reopen 仍递增的 ID（扫描按 ID 作创建顺序）：用 PG sequence。
- 方法抛出的错误即致命（会令 Session 失败且不重试），暂时性错误必须在方法内部重试；只有无效请求（`StorageRequestError`）和 context 被取消只让单次读失败。
- Session 自己串行化 commit，Storage 信任其写入语义有效。因此**同一时刻仍只能有一个 Session 写同一会话的存储**，所有权问题没有消失，但可以收敛成下面的做法。

所有权与 fencing：

- 会话的 owner 记录在 PG（`durable_sessions.owner_worker` + `lease_epoch` + `lease_expires_at`），认领用条件更新并递增 `lease_epoch`。
- `commit()` 的事务内校验"当前 `lease_epoch` 等于本 Session 持有的 epoch"，不相等则失败。这样租约被抢走后，旧 owner 的任何写入都会被存储层拒绝，取代现在只防误双开的 advisory lock，也不依赖网络分区下的时钟假设。
- 注意"错误即致命"：fencing 失败会让旧 Session 关闭，这正是期望行为，需保证上层把它映射为 `DurableSessionBusyError` 式的可重定向响应，而不是 500。
- pi-durable README 指出"每个打开同一存储的进程必须使用同一时钟"（睡眠截止时间存的是 `now`）：各 worker 需要统一时钟源和 NTP 监控。

路由：

- 把静态哈希路由换成基于租约的动态路由：路由层查 `durable_sessions` 的当前 owner；无 owner 或租约过期时，任意 worker 认领。支持动态扩缩容和故障转移。
- 空闲会话主动释放租约；运行中 turn 的租约由心跳续期。

测试：

- 用 `registerStorageConformance` 对 PG 实现跑官方一致性套件；用 `storage-benchmark` 与 sqlite 实现对比读写性能。
- 沿用现有 SIGKILL/重启恢复测试，扩展为跨 worker：杀掉 owner，另一 worker 在租约过期后接管并继续。
- 新增 fencing 测试：旧 owner 被暂停（SIGSTOP）超过租约后恢复，其写入必须被拒绝。

**退出标准**：一致性套件全绿；跨 worker 接管与 fencing 测试通过；PG Storage 的单会话 turn 延迟与 sqlite 基线的差距在可接受范围内（阈值待定，由阶段 0 的基线给出）。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 自实现 PG `Storage` 的正确性与性能（接口约束多，错误即致命） | 以官方 conformance 套件和 storage-benchmark 为准入门槛；先在影子流量或测试租户灰度；保留 sqlite 后端作为回退 |
| 双写期间两边数据不一致 | 回填后跑一致性校验任务，不一致告警，读切换前要求零差异 |
| 沙箱服务成为新的单点和成本中心 | 沙箱按租户池化并设置空闲回收；服务不可用时 fail-closed，不退回宿主执行 |
| 迁移期间 legacy 与本地模式回归 | `SessionCatalog` 等接口保留本地实现，现有测试作为回归套件 |
| 工作量估算偏乐观 | 每阶段独立上线，阶段 0、1 完成后重估后续阶段 |

## 6. 总体验收标准

- 任一 worker 被 SIGKILL 后，其承载的会话在可配置时间内由其他 worker 恢复，且不重复弹出 question/permission 卡片，不产生合成的用户回合。
- 删除任一 worker 本地磁盘，不丢失任何租户的非缓存状态。
- 跨租户读写在数据层（外键与租户作用域查询）被拒绝，而不只依赖应用层路径检查。
- 在同一 CI 中保持：`npm test`、`npm run test:integration` 和新增的故障注入/多 worker 恢复测试全部通过。

## 7. 待决问题

1. （已解决）pi-durable 支持自定义 `Storage`，并带 conformance 套件；剩余问题是 pi-durable 升级时接口是否稳定，需要与上游确认兼容性承诺。
2. 沙箱技术选型和部署形态（自建 Kubernetes 与托管服务）。
3. 对象存储选型，以及 L2 正文是否需要租户级加密。
4. （已解决）pi-durable 内置 `read`/`write`/`edit`/`bash` 的源码里没有任何 `replay` 声明，所以崩溃后它们不会被重跑，模型收到 `interrupted` 结果。这对 `write`/`edit` 是安全的默认；阶段 2 的远程实现保持这一语义即可，不要擅自标 safe。
5. 目标规模：租户数、单租户会话数、并发 turn 数——决定是否需要阶段 4 的完整动态路由，还是固定分片加人工迁移即可。
