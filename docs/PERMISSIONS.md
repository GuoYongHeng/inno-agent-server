# 权限与文件访问边界

Inno Agent 的 agent **没有 shell，也没有宿主机执行能力**。它能做的事只有通过工具完成，工具对文件的访问被限制在会话的工作区内。本文说明这条边界的组成、审批流程和限制。

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

## 提问卡片

`ask_user_question` 与审批共用同样的恢复语义：问题和答案持久化，崩溃后恢复同一个问题，无头运行按 `no_ui` 处理。接口：`POST /api/chat/question-response`。

## 已不存在的东西

下面这些在旧版本里存在，现在没有，也没有对应配置项：bash 与终端（Practice Lab）、`default`/`auto`/`yolo` 三档权限模式、deny 底线规则表、pi-sandbox 的 `sandbox.json`、MCP、子代理、computer-use、codemode。`config.json` 里残留的 `plugins`、`mcp`、`subagents` 字段会在下一次保存配置时被丢弃。
