# 权限与文件访问边界

Inno Agent 的 agent **没有宿主机上的 shell 或执行能力**。它能做的事只有通过工具完成，工具对文件的访问被限制在会话的工作区内。可选地，可以打开[远程沙箱](#远程沙箱可选)：那时 shell 命令和文件工具都在云端沙箱里运行，仍然不接触宿主机。本文说明这条边界的组成、审批流程和限制。

> 早期版本有 bash、PTY 终端、OS 级沙箱（pi-sandbox）和可配置的"三档权限模式"。这些随旧的 `pi-coding-agent` 运行时一起移除了，原因和范围见 [DURABLE_ROADMAP.md](./DURABLE_ROADMAP.md)。

## 文件工具的边界

durable 会话只注册三个文件工具：`read`、`write`、`edit`。它们通过 `agent/durable-env.ts` 的 `WorkspaceFileEnv` 访问文件系统：

- **只在工作区内**：每次访问都先检查路径是否落在会话工作区之内。检查同时对"词法路径"和"真实路径"（解析符号链接后）生效，所以指向工作区外的符号链接、`..` 越界和绝对路径越界都会被拒绝。
- **只允许读、写、精确编辑**：追加、截断、重命名、建目录、删除、监听以及任何 shell 调用都直接失败，即使以后有人误注册了一个新工具，也会在环境层被拒绝。
- **其他自定义工具同样受约束**：文档解析 `parse_document`、文件型 `l2_archive`、本地文件 `ocr_image` 使用同一套 realpath 与祖先目录检查（`agent/workspace-path-guard.ts`）。
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
  "timeoutMinutes": 30, "commandTimeoutSeconds": 600, "allowInternetAccess": true } }
```

也可用 `INNO_SANDBOX_ENABLED=true` 加 `E2B_API_KEY`。启用但没有密钥时，服务在启动引导阶段直接报错。`domain` 可指向自部署的 e2b 兼容服务，`template` 指定镜像。改配置需要重启。

**行为**
- 沙箱在会话第一次打开时创建，ID 记在会话目录里；运行时关闭（会话空闲）时暂停，再次使用时恢复；会话被删除时销毁。已不存在的沙箱会自动重建并重新同步。
- **工作区同步**：沙箱里的 `/home/user/workspace` 与宿主工作区同步。每轮对话前，宿主上新增或修改的文件上传到沙箱（宿主优先）；每轮结束后，以及 `parse_document`、`l2_archive`、`ocr_image`、`send_file_to_channel` 这几个按宿主路径读文件的工具执行前，沙箱里新增或修改的文件下载到宿主（沙箱优先）。agent 在沙箱里删除的文件，只有在宿主副本自上次同步后没被改过时才在宿主删除；宿主上删除的文件不会传到沙箱。`.git`、`node_modules`、`__pycache__`、`.venv`、`.cache`、符号链接和超过 20 MB 的文件不同步。
- 全局技能目录同步到沙箱的 `/home/user/.inno/skills`，提示词里的路径相应改写。
- **审批**：`requireApproval` 为 `always`（默认）时每条 shell 命令都要在网页上批准（"本会话允许"只对完全相同的命令生效）；`never` 时不询问。非流式或无头运行（定时任务、IM 渠道）无法询问，在 `always` 下 shell 会被拒绝。
- **崩溃恢复**：`bash` 不可重放，进程崩溃后该次调用返回 `interrupted`，不会重复执行；审批卡片未决时崩溃，模型需要重新发起。

**限制**：沙箱内的文件修改要等一轮结束才回到宿主，所以网页的文件面板有一轮的延迟；一轮进行中崩溃，那一轮在沙箱里的修改要等下次打开会话时的同步才回到宿主；沙箱是云服务，工作区文件内容会离开本机。

## 提问卡片

`ask_user_question` 与审批共用同样的恢复语义：问题和答案持久化，崩溃后恢复同一个问题，无头运行按 `no_ui` 处理。接口：`POST /api/chat/question-response`。

## 已不存在的东西

下面这些在旧版本里存在，现在没有，也没有对应配置项：宿主机上的 bash 与终端（Practice Lab；沙箱里的 `bash` 是新实现）、`default`/`auto`/`yolo` 三档权限模式、deny 底线规则表、pi-sandbox 的 `sandbox.json`、MCP、子代理、computer-use、codemode。`config.json` 里残留的 `plugins`、`mcp`、`subagents` 字段会在下一次保存配置时被丢弃。
