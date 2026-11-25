# Inno Agent 系统环境依赖文档

本文档列出了 Inno Agent 在容器镜像中运行所需的全部系统级依赖，分为**构建时依赖**、**运行时必要依赖**、**可选运行时依赖**、**Python 科学计算环境**、**Native 原生模块**五个部分。

---

## 一、构建时依赖（Docker 镜像构建阶段）

构建阶段需要编译 TypeScript 后端 + Vite 前端，并安装 npm 依赖。其中 `sharp`、`koffi` 等原生模块在缺少预编译二进制时可能需要从源码编译。

| 依赖包 | 用途 | 备注 |
|--------|------|------|
| `node` (>= 22.19.0) | JavaScript 运行时 | pi-durable 的最低版本要求；内置 `node:sqlite` 支持 L3 与 durable storage |
| `npm` | 包管理器 | 随 Node.js 一起安装 |
| `python3` | 原生模块的 `node-gyp` 编译 | 仅当目标平台缺少预编译二进制时需要 |
| `make` | 原生模块的 `node-gyp` 编译 | 同上 |
| `g++` | 原生模块的 `node-gyp` 编译（C++ 源码） | 同上 |
| `ca-certificates` | npm install 和 HTTPS 连接的基础 CA 证书 | Debian 基础镜像通常已内置 |

**建议基础镜像**: `node:22-bookworm`（或更新版本）

---

## 二、运行时必要依赖

这些是项目自身代码直接调用的系统工具，**缺一不可**。

### 2.1 系统命令行工具

| 工具 | 绝对路径 | 调用位置 | 用途 |
|------|----------|----------|------|
| **unzip** | `/usr/bin/unzip` | [`server.ts:642`](apps/inno-agent/src/server.ts#L642) [`server.ts:719`](apps/inno-agent/src/server.ts#L719) | 1. 技能包 ZIP 解压安装<br>2. ZIP 文件内容校验（`unzip -Z1`） |
| **zip** | `/usr/bin/zip` | [`server.ts:688`](apps/inno-agent/src/server.ts#L688) | 工作区目录下载时打包为 ZIP 归档 |

> ⚠️ **注意**：当前 `deploy/Dockerfile.backend` 的 runtime 阶段只安装了 `unzip`，缺少 `zip`。如需支持工作区下载功能，需补充安装 `zip`。

### 2.2 安装命令（Debian/Ubuntu）

```bash
apt-get update && apt-get install -y unzip zip bash && rm -rf /var/lib/apt/lists/*
```

`bash` 在 Debian 基础镜像中通常已预装，但建议显式声明。

### 2.3 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NODE_ENV` | `production` | 生产模式 |
| `INNO_HOME` | `/var/lib/inno-agent`（Docker） | 主目录 |
| `INNO_CONFIG_DIR` | `/etc/inno-agent`（Docker） | 配置文件目录 |
| `INNO_SKILLS_DIR` | `<home>/skills` | 平台技能 seed 目录（启动时发布进对象存储 catalog，非运行时真源） |
| `INNO_WORKSPACE_DIR` | `/srv/inno-workspace`（Docker） | 默认工作区目录（对象存储的一次性执行镜像，非事实源） |
| `INNO_PORT` | `3000` | HTTP 服务端口 |
| `INNO_OBJECT_STORAGE_PROVIDER` | — | **必填** `s3` \| `fs`（无 memory 模式，缺失时启动失败） |
| `INNO_OBJECT_STORAGE_DIR` | — | `provider=fs` 时对象键镜像到的目录（单机/测试） |
| `INNO_OBJECT_STORAGE_ENDPOINT` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_REGION` | — | `provider=s3` 的连接参数（OSS / MinIO / S3） |
| `INNO_OBJECT_STORAGE_PUBLIC_ENDPOINT` | `ENDPOINT` | 预签名 URL 面向浏览器的 endpoint（可选） |
| `LANG` | `en_US.UTF-8` | 系统语言编码 |

### 2.4 目录结构和权限

```
/etc/inno-agent/          # 配置文件目录（只读；平台配置唯一事实源）
  └── config.json         # 部署字段 + 默认模型 + 托管目录（providers/渠道凭据/tavily/contentHub）
/var/lib/inno-agent/
  └── skills/             # 技能 seed 目录（只读；启动时发布进对象存储 catalog）
/srv/inno-workspace/      # 会话工作区执行目录（读写；对象存储副本的临时镜像，非事实源）
/tmp/                     # 临时文件（ZIP 打包等操作使用）
```

> 租户状态（会话、L2/L3 记忆、jobs、技能 catalog 元数据、租户选择）全部在 PostgreSQL；技能与 workspace 字节在对象存储（`INNO_OBJECT_STORAGE_*`，必填，`fs` 或 `s3`）。日志只输出到 stdout，不写本地文件。

---

## 三、可选运行时依赖

这些依赖仅在启用特定功能时才需要，缺失时对应功能会优雅降级或不可用。

### 3.1 L3 跨对话记忆

| 依赖 | 要求 | 降级行为 |
|------|------|----------|
| `node:sqlite` | 项目 Node.js >= 22.19.0 基线已包含 | 当前支持版本均可使用；不再支持低于 22.19 的运行环境 |

### 3.2 文档解析（parse_document 工具）

文档解析通过 `@llamaindex/liteparse` 实现，支持 PDF、Office 文档和图片的文本提取。

**Office 文档解析需要系统级依赖：** liteparse 通过 headless LibreOffice 将 Office 文档（`.docx`、`.xlsx`、`.pptx` 等）转换为 PDF 后再提取文本。

| 平台 | 安装命令 |
|------|----------|
| macOS | `brew install --cask libreoffice` |
| Ubuntu/Debian | `apt-get install libreoffice` |
| Windows | `choco install libreoffice-fresh` |

其他格式的依赖通过 npm 包预编译二进制捆绑，无需安装系统级库：

- PDF 解析：`@hyzyla/pdfium`（WASM），`pdfjs-dist`（WASM）
- 支持的格式：`.pdf` `.docx` `.xlsx` `.pptx` `.png` `.jpg` `.jpeg` `.gif` `.webp` `.tiff`
- 没有独立 OCR 包。扫描件解析失败时由文档解析器返回空文本错误。
- 文件大小上限：100MB

### 3.3 Python 科学计算环境（Miniforge）

> **现状**：agent 不再提供终端或 shell，服务进程本身不执行用户的 Python 脚本；运行时只用到 `python3` 标准库（pptx→svg 预览转换器）。下面的 Miniforge 方案是**可选的**——只有当你的镜像还要给其他工具（例如挂载进来的 Jupyter 或离线数据处理）提供 Python 科学生态时才需要，否则只装 `python3` 即可。

Inno Agent 是一个面向学习和探索的智能体项目，如果镜像还需要提供完整的 Python 科学生态，可以预装 **Miniforge**（conda-forge 社区维护的 conda 发行版）。

#### 为什么不选 Anaconda / Miniconda？

Anaconda 公司自 2020 年起修改了服务条款：**员工 ≥ 200 人的商业组织**使用 Anaconda 默认包仓库（`defaults` channel）需要购买商业许可。Miniconda 虽然安装器本身是 BSD 协议，但默认源同样指向 Anaconda 的商业仓库，存在同样的合规风险。

Miniforge 由 conda-forge 社区维护，**完全开源免费，商用无限制**，且 conda-forge 的包更新更快、覆盖更广。

#### Docker 安装

```dockerfile
# 安装 Miniforge（conda-forge 社区版，商用无限制）
ENV CONDA_DIR=/opt/conda
RUN wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh \
    -O /tmp/miniforge.sh \
    && bash /tmp/miniforge.sh -b -p ${CONDA_DIR} \
    && ${CONDA_DIR}/bin/conda init bash \
    && rm /tmp/miniforge.sh
ENV PATH=${CONDA_DIR}/bin:${PATH}
```

安装后可用 `conda install` 或 `pip install` 安装任意 Python 包，如：

```bash
conda install -y numpy pandas matplotlib scikit-learn jupyter
pip install torch torchvision  # 深度学习框架
```

#### 包选用建议

| 场景 | 推荐安装 |
|------|----------|
| 基础数据分析 | `numpy pandas matplotlib` |
| 机器学习 | `scikit-learn xgboost` |
| 深度学习 | `pytorch` (conda-forge) 或 `tensorflow` |
| 交互式编程 | `jupyterlab ipykernel` |
| Web 爬虫 | `requests beautifulsoup4 lxml` |
| 图像处理 | `opencv pillow` |

---

## 四、Native 原生 Node.js 模块

以下 npm 包包含 C/C++ 原生扩展（`.node` 二进制文件），需要在目标平台上正确加载。

### 4.1 直接依赖

| 包名 | 原生文件 | 系统要求 | 备注 |
|------|----------|----------|------|
| **sharp** | `@img/sharp-<platform>/` | 无（捆绑 libvips） | 图像处理，通过 `@llamaindex/liteparse` 间接依赖。libvips 已预编译捆绑在所有主要平台上。 |
| **koffi** | 编译的 `.node` 二进制 | `dlopen`/`dlsym`（Unix） | C FFI 接口，用于动态加载系统共享库。通过 `@hyzyla/pdfium` 间接依赖。 |

---

## 五、完整 Docker 镜像安装参考

### 5.1 多阶段构建的 Dockerfile 建议

```dockerfile
# ===== 构建阶段 =====
FROM node:22-bookworm AS build

# 安装原生模块编译工具（python3, make, g++）+ CA 证书
RUN apt-get update && apt-get install -y \
    ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ... npm ci & npm run build ...

# ===== 运行时阶段 =====
FROM node:22-bookworm AS runtime

# 安装运行时系统工具
RUN apt-get update && apt-get install -y \
    unzip zip bash wget \
    && rm -rf /var/lib/apt/lists/*

# 安装 Miniforge（Python 科学计算环境，conda-forge 社区版，商用无限制）
ENV CONDA_DIR=/opt/conda
RUN wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh \
    -O /tmp/miniforge.sh \
    && bash /tmp/miniforge.sh -b -p ${CONDA_DIR} \
    && ${CONDA_DIR}/bin/conda init bash \
    && rm /tmp/miniforge.sh
ENV PATH=${CONDA_DIR}/bin:${PATH}


ENV NODE_ENV=production \
    INNO_HOME=/var/lib/inno-agent \
    INNO_CONFIG_DIR=/etc/inno-agent \
    INNO_SKILLS_DIR=/var/lib/inno-agent/skills \
    INNO_WORKSPACE_DIR=/srv/inno-workspace \
    INNO_PORT=3000

# 创建必要的目录结构
RUN mkdir -p /etc/inno-agent \
    /var/lib/inno-agent/skills \
    /srv/inno-workspace

EXPOSE 3000
CMD ["node", "apps/inno-agent/dist/server.js"]
```

### 5.2 一行安装（Debian/Ubuntu 完整版）

```bash
# 运行时必要
apt-get update && apt-get install -y unzip zip bash wget

# Miniforge（Python 科学计算环境，商用免费）
wget -q https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh -O /tmp/miniforge.sh \
  && bash /tmp/miniforge.sh -b -p /opt/conda \
  && /opt/conda/bin/conda init bash \
  && rm /tmp/miniforge.sh
ENV PATH=/opt/conda/bin:${PATH}

```

---

## 六、依赖关系图

```
Inno Agent
├── [运行时必要] unzip ──────────────── 技能包安装、ZIP 校验
├── [运行时必要] zip ────────────────── 工作区下载打包
├── [单测遗留] Node.js >= 22.5 ──────── 文件版 L3 fake（node:sqlite）；生产 L3 用 ParadeDB BM25
├── [运行时可选] Miniforge ──────────── Python 科学计算环境 (conda-forge)
│
├── [原生模块] koffi ────────────────── C FFI 动态库加载 (C/N-API)
├── [原生模块] @hyzyla/pdfium ───────── PDF 解析 (C++→WASM)
│
├── [构建时] node >= 22.19 ──────────── TypeScript 编译 + 运行时 / pi-durable
├── [构建时] python3 ────────────────── 原生模块 node-gyp 编译
├── [构建时] make ───────────────────── 原生模块 node-gyp 编译
├── [构建时] g++ ────────────────────── 原生模块 C++ 源码编译
└── [构建时] ca-certificates ────────── npm install HTTPS 连接
```

---

## 七、常见问题排查

| 问题现象 | 可能原因 | 解决方法 |
|----------|----------|----------|
| L3 记忆功能不工作 | 检查 L3 配置与 SQLite 初始化日志 | 当前 Node.js 基线为 22.19+；旧版本需先升级 Node.js |
| 技能包上传失败 | 缺少 `unzip` 命令 | `apt-get install -y unzip` |
| 工作区下载 ZIP 失败 | 缺少 `zip` 命令 | `apt-get install -y zip` |
| 文档解析报错 | `@llamaindex/liteparse` 原生模块加载失败 | 确保 npm install 完整执行，sharp 预编译二进制匹配平台 |
| npm install 时原生模块编译失败 | 缺少编译工具 | `apt-get install -y python3 make g++` |
