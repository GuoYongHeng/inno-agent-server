# Inno Agent

基于 `pi-durable` 的个人学习 Agent 后端，支持 Web UI / 飞书 / 微信、两层记忆（L2 Wiki + L3 跨对话检索）与定时任务。每个对话的 durable 存储在 PostgreSQL（`ds_*`）。Better Auth + PostgreSQL 是启动必需项，没有未认证模式。

> 本文档聚焦后端开发与运行细节。项目整体介绍见仓库根目录的 [README.md](../../README.md)；多用户架构、隔离与恢复边界见 [docs/MULTI_USER_DURABLE.md](../../docs/MULTI_USER_DURABLE.md)，实现契约见 [docs/DURABLE_RUNTIME.md](../../docs/DURABLE_RUNTIME.md)。

## 前置条件

- Node.js >= 22.19.0（pi-durable 的最低版本要求）
- 已 `npm install` 并 `npm run build`（在仓库根目录执行）
- `runtime/config/config.json` 已配置（参考 `config.example.json`，部署字段 + 默认模型），provider 目录已用 `npm run platform:config -- <file>` 写入 `platform_config` 行

## 安装

```bash
# 后端依赖
npm install

# 前端依赖
cd web && npm install && cd ..
```

## 启动

### 开发模式（推荐）

需要两个终端：

```bash
# 终端 1：启动后端（先编译再运行）
npm run build && npm run server
# 后端监听 http://localhost:3000

# 终端 2：启动前端开发服务器
npm run web:dev
# 前端监听 http://localhost:5173，自动代理 /api 到后端
```

浏览器打开 **http://localhost:5173**

### 开发后重启

如果修改后刷新浏览器没有生效，先停掉旧的前后端进程：

```bash
pkill -f "node dist/server.js"
pkill -f "vite"
```

然后重新启动两个终端：

```bash
# 终端 1：后端
npm run build
npm run server

# 终端 2：前端
npm run web:dev
```

重启规则：

- 修改 `src/server.ts` 或后端 API：需要 `npm run build` 后重启后端。
- 修改 `web/vite.config.ts`：需要重启前端开发服务器。
- 只修改 `web/src/` 下的前端组件或样式：通常 Vite 会热更新，刷新页面即可。
- 上传接口、Wiki API、代理没有生效：优先完整重启前后端。

可以用下面的命令确认服务是否正常：

```bash
curl http://localhost:3000/health
curl http://localhost:5173/api/wiki/pages
```

### 生产模式

```bash
# 编译前端到 web/dist/
npm run web:build

# 编译后端并启动（自动托管 web/dist/ 静态文件）
npm run build && npm run server
```

浏览器打开 **http://localhost:3000**

## 项目结构

```
src/                  # 后端 (Node.js)
├── server.ts         # HTTP Server + SSE + REST API
├── runtime.ts        # 运行时路径解析（命令行参数 > env > 默认）
├── agent/            # pi-durable 会话运行时、会话服务与原生工具
├── channels/         # 飞书 / 微信等渠道
├── scheduler/        # 定时任务
├── memory/           # L2 Wiki + L3 跨对话检索记忆
│   ├── l2/           # L2 Wiki 知识库
│   └── l3/           # L3 会话记录的 sqlite 索引与阈值召回
└── storage/          # 文件存储


web/                  # 前端 (React + Tailwind + Vite)
├── src/
│   ├── api/          # 纯 TS fetch 封装（无框架依赖）
│   ├── stores/       # EventEmitter 状态管理（无框架依赖）
│   ├── react/        # React 组件
│   ├── types/        # 共享类型
│   └── utils/        # 工具函数
└── index.html
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/api/chat` | 发送消息（完整响应） |
| POST | `/api/chat/stream` | 发送消息（SSE 流式） |
| GET/POST | `/api/sessions` | 会话列表 / 新建会话（均为 durable） |
| GET/PATCH/DELETE | `/api/sessions/:id` | 会话详情 / 重命名或切换该会话的模型（`provider` + `modelId`，下一条消息起生效）/ 删除 |
| GET | `/api/sessions/:id/context-usage` | 上下文用量（system / tools / messages / skills 分项） |
| GET | `/api/sessions/:id/export.md` | 导出为 Markdown |
| POST | `/api/sessions/:id/branch-before-message` | 在指定用户消息前分叉出新的对话，会话在分支上继续，被放弃的回复不再出现在历史和模型上下文中 |
| GET | `/api/wiki/pages` | Wiki 页面列表 |
| GET | `/api/wiki/page?path=` | 读取 Wiki 页面 |
| PUT | `/api/wiki/page` | 保存 Wiki 页面 |
| GET | `/api/wiki/graph` | 知识图谱数据 |
| GET | `/api/wiki/stats` | Wiki 统计 |
| GET | `/api/skills` | Skills 列表（`skill_catalog`：平台共享 + 本租户上传） |
| POST | `/api/skills/upload` | 上传 `<skill-name>.zip`，发布到对象存储 `tenants/<t>/skills/` 并归租户所有 |
| PATCH | `/api/skills/:name` | 启用/关闭 Skill（`tenant_skills`） |
| DELETE | `/api/skills/:name` | 删除 Skill（仅租户自有；平台共享技能只读） |
| POST | `/api/skills/reload` | 刷新技能面板（durable 会话在运行时打开时读取技能目录） |
| GET | `/api/settings` | 配置信息（合并视图：服务端托管目录 + 租户选择，`serverManaged` 标记供 UI 隐藏编辑入口） |
| POST | `/api/settings/model` | 选择默认模型（租户唯一的模型写口，校验服务端目录） |
| PUT | `/api/settings/channels` | 渠道开关/白名单（`enabled`/`personalOnly`/`allowedUserIds`；凭据与端点字段 403，由服务端托管） |
| PUT | `/api/settings/memory` | 记忆层开关 |
| GET/POST/PATCH/DELETE | `/api/jobs[/:id]` | 定时任务 CRUD |
| POST | `/api/jobs/:id/run` | 立即执行任务 |
| GET | `/api/jobs/status` | 定时任务总览状态 |
| GET | `/api/jobs/runs` | 最近任务执行记录 |
| GET | `/api/jobs/:id/runs` | 指定任务执行记录 |

## 定时任务运行时

任务台账存 PostgreSQL（`tenant_jobs` / `tenant_job_runs`）。服务端加载租户的 cron 定义并维护运行状态字段：

- `nextRunAt`：根据 cron 和 timezone 计算的下一次触发时间。
- `lastStatus` / `lastError`：最近一次运行状态。
- `runCount` / `failureCount`：累计执行和失败次数。

每次任务执行追加一条 `tenant_job_runs` 记录，包含 run id、开始/结束时间、耗时、触发来源、错误信息和输出摘要。任务可以由后台 cron 自动触发，也可以通过 `/api/jobs/:id/run` 或 agent 工具 `run_scheduled_job` 手动触发。
