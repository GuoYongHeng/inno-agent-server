# 权限与文件访问边界

Inno Agent 的 agent **没有宿主机上的 shell 或执行能力**。它能做的事只有通过工具完成，工具对文件的访问被限制在会话的工作区内。可选地，可以打开[远程沙箱](#远程沙箱可选)：那时 shell 命令和文件工具都在云端沙箱里运行，仍然不接触宿主机。本文说明这条边界的组成、审批流程和限制。

> 早期版本有 bash、PTY 终端、OS 级沙箱（pi-sandbox）和可配置的"三档权限模式"。这些随旧的 `pi-coding-agent` 运行时一起移除了，原因和范围见 [DURABLE_ROADMAP.md](./DURABLE_ROADMAP.md)。

## 文件工具的边界

durable 会话只注册三个文件工具：`read`、`write`、`edit`。它们通过 `agent/durable-env.ts` 的 `WorkspaceFileEnv` 访问文件系统：

- **只在工作区内**：每次访问都先检查路径是否落在会话工作区之内。检查同时对"词法路径"和"真实路径"（解析符号链接后）生效，所以指向工作区外的符号链接、`..` 越界和绝对路径越界都会被拒绝。
- **只允许读、写、精确编辑**：追加、截断、重命名、建目录、删除、监听以及任何 shell 调用都直接失败，即使以后有人误注册了一个新工具，也会在环境层被拒绝。
- **其他自定义工具同样受约束**：文档解析 `parse_document`、文件型 `l2_archive` 使用同一套 realpath 与祖先目录检查（`agent/workspace-path-guard.ts`）。
- **多用户模式**：每个租户有独立的工作区根目录；跨租户的会话、工作区和文件请求返回 404。

这是**应用层**的路径检查，不是内核级隔离：同一台机器上的 worker 进程仍然以服务账号的权限运行。需要更强隔离（容器或沙箱执行环境）的方案见 [DURABLE_ROADMAP.md](./DURABLE_ROADMAP.md) 的 H2。

## 写入审批

`write` 和 `edit` 在执行前需要审批：

| 场景 | 行为 |
|---|---|
| 流式对话 | 在 web UI 弹出审批卡片：**仅此次**（`allow_once`）、**本会话允许**（`allow_session`）、**拒绝**（`deny`） |
| 非流式或无头运行（定时任务、IM 渠道、`POST /api/chat`） | 没有卡片可弹，直接拒绝，错误码 `no_ui` |
| 进程崩溃或重启 | 已作出的决定保存在磁盘上，恢复后原样返回，不会再弹第二张卡 |
| 页面刷新或重连 | 待决卡片会被重新绑定到新的流 |
| 旧的或跨租户的响应 | 返回 409 / 404 |

`allow_session` 的缓存只存在于进程内：它对同一会话中随后匹配的工具和路径生效，重启后会重新询问（原始的那次决定仍然保留）。

`read` 不需要审批。

接口：`POST /api/chat/permission-response`（`sessionId`、`turnId`、`requestId`、`decision`）。实现位于 `agent/durable-permissions.ts`。

## 远程沙箱（可选）

默认关闭。打开后每个会话有一个自己的 E2B 云沙箱，agent 多出一个 `bash` 工具，`read`/`write`/`edit` 也改为在沙箱里读写。

**开启**（平台级，只读服务器自己的 `config.json` 或环境变量，**不读租户的配置**，租户无法指定沙箱地址或密钥）：

```json
{ "sandbox": { "enabled": true, "apiKey": "e2b_...", "requireApproval": "always",
  "timeoutMinutes": 30, "commandTimeoutSeconds": 600, "allowInternetAccess": true, "allowedDomains": [],
  "limits": { "maxConcurrent": 3, "maxSandboxes": 20, "maxActiveMinutesPerDay": 480 } } }
```

也可用 `INNO_SANDBOX_ENABLED=true` 加 `E2B_API_KEY`，或在设置页"集成"里的"云端沙箱"卡片编辑（仅本地模式；认证模式下租户看不到也改不了，API Key 在接口里始终是掩码）。保存后服务会重建沙箱管理器，之后新打开的会话使用新设置。启用但没有密钥时，服务在启动引导阶段直接报错。`domain` 可指向自部署的 e2b 兼容服务，`template` 指定镜像。改配置需要重启。

**行为**
- 沙箱在会话第一次打开时创建，ID 记在会话目录里；运行时关闭（会话空闲）时暂停，再次使用时恢复；会话被删除时销毁。已不存在的沙箱会自动重建并重新同步。
- **工作区同步**：沙箱里的 `/home/user/workspace` 与宿主工作区同步。每轮对话前，宿主上新增或修改的文件上传到沙箱（宿主优先）；每轮结束后，以及 `parse_document`、`l2_archive`、`send_file_to_channel` 这几个按宿主路径读文件的工具执行前，沙箱里新增或修改的文件下载到宿主（沙箱优先）。agent 在沙箱里删除的文件，只有在宿主副本自上次同步后没被改过时才在宿主删除；宿主上删除的文件不会传到沙箱。`.git`、`node_modules`、`__pycache__`、`.venv`、`.cache`、符号链接和超过 20 MB 的文件不同步。
- 全局技能目录同步到沙箱的 `/home/user/.inno/skills`，提示词里的路径相应改写。
- **审批**：`requireApproval` 为 `always`（默认）时每条 shell 命令都要在网页上批准（"本会话允许"只对完全相同的命令生效）；`never` 时不询问。非流式或无头运行（定时任务、IM 渠道）无法询问，在 `always` 下 shell 会被拒绝。
- **崩溃恢复**：`bash` 不可重放，进程崩溃后该次调用返回 `interrupted`，不会重复执行；审批卡片未决时崩溃，模型需要重新发起。

**网络出站**：`allowInternetAccess: false` 完全断网；`allowedDomains` 非空（域名、通配符如 `*.github.com` 或 CIDR）时只允许访问这些地址，其余全部拒绝（对 E2B 用 `denyOut: 0.0.0.0/0` 加 `allowOut` 实现），提示词里会告诉模型哪些地址可用。留空表示不限制。

**孤儿沙箱清理**：会话记录已没有、但沙箱还在计费的沙箱（删除时销毁失败，或创建后、记录 ID 前崩溃）可以用下面的命令查找和销毁。只处理本应用创建的沙箱（按元数据 `app=inno-agent` 过滤），且只处理创建超过宽限期（默认 60 分钟）的，避免误伤刚创建、记录还没写完的。会话记录来自 PostgreSQL（设置了 `DATABASE_URL`）或本地的 `sessions.json`。

```bash
npm run sandbox:fsck                       # 只列出
npm run sandbox:fsck -- --repair           # 销毁
npm run sandbox:fsck -- --grace-minutes 180
```

**每租户配额**（`sandbox.limits`，0 表示不限；本地模式把整个本机当作一个租户）：
- `maxConcurrent`：同一租户同时运行的沙箱数（每个打开的会话占一个），默认 3。
- `maxSandboxes`：同一租户拥有的沙箱总数（含已暂停的），默认 20；超过后不再为新会话创建沙箱，删除会话即释放。
- `maxActiveMinutesPerDay`：同一租户每个 UTC 日的沙箱运行分钟数，默认 480。
- 超限时**会话照常打开、历史照常可看**，只是沙箱关闭：`bash` 和文件工具会返回超限原因，模型会如实告诉用户。之后每一轮都会重试，容量释放或次日重置后自动恢复，无需手动处理。一轮进行中不会被打断，所以时长可能超出上限一轮。
- 认证模式下账目在 PostgreSQL（`sandbox_leases`、`sandbox_usage`），所有 worker 共享；每次判定在租户级咨询锁内进行，并发打开不会同时越过上限。持有租约的 worker 崩溃后，租约 10 分钟没有心跳即被回收，时长计到最后一次心跳。本地模式的账目在进程内。

**限制**：沙箱内的文件修改要等一轮结束才回到宿主，所以网页的文件面板有一轮的延迟；一轮进行中崩溃，那一轮在沙箱里的修改要等下次打开会话时的同步才回到宿主；沙箱是云服务，工作区文件内容会离开本机。

## 提问卡片

`ask_user_question` 与审批共用同样的恢复语义：问题和答案持久化，崩溃后恢复同一个问题，无头运行按 `no_ui` 处理。接口：`POST /api/chat/question-response`。

## 已不存在的东西

下面这些在旧版本里存在，现在没有，也没有对应配置项：宿主机上的 bash 与终端（Practice Lab；沙箱里的 `bash` 是新实现）、`default`/`auto`/`yolo` 三档权限模式、deny 底线规则表、pi-sandbox 的 `sandbox.json`、MCP、子代理、computer-use、codemode。`config.json` 里残留的 `plugins`、`mcp`、`subagents` 字段会在下一次保存配置时被丢弃。
