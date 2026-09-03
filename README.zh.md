<div align="center">

<img src="assets/title.svg" alt="AutoReportDSH" width="100%" />

### 面向 DeepSeek Harness 的固定团队物理实验报告工作流

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#)
[![Node](https://img.shields.io/badge/node-22.19%2B-339933.svg)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-3366cc.svg)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

</div>

基于多 Agent 协作的自动化物理实验报告撰写系统，以
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件的形式
运行。用户提供实验数据和参考资料，固定的五角色团队 —— Main、Theory、Data Analysis、
Plotting、Report —— 负责理论推导、数据分析、绘图和 LaTeX/Typst 报告编译。工作流
移植自 [AutoReportCLI](https://github.com/xjsongphy/AutoreportCLI)。

## 功能特性

### 核心能力
- **多 Agent 协作** — Main 负责规划与调度，Theory、Data Analysis、Plotting、Report 四个 specialist 各司其职
- **目录权限隔离** — 每个 Agent 的写入目录由 DSH 的 `workspace-write` 沙箱钉死（见下表）
- **LaTeX 与 Typst 报告** — 每个项目自选语言，内置模板、主题、参考文献资源与编译 skill；Python 负责数据处理与绘图
- **使用 DSH 的 Provider** — 模型路由与凭证来自 DSH 自己的配置
- **资源保持最新** — 模板、主题和 skills 在每次插件启动时从远端刷新；`pnpm run sync:resources` 可手动触发
- **开箱即用** — 插件自带 persona、模板和 skills，新项目立即可跑

### 工作流
- **工作区自动初始化** — Main 首个回合只初始化一次；`/init` 用于手动修复或选择报告语言
- **任务与产物追踪** — Main 通过 `send_to_agent` 委派任务；specialist 在共享的 `manifest` 里描述自己的产出，下一个角色无需被告知即可找到；每个任务以声明完成收尾
- **specialist 可续写** — 每个 specialist 在后续任务中保留角色上下文；直接与它对话仍是普通对话
- **其余是原样 DSH** — 未选择 `autoreport` preset 的 session 与没有本插件的 DSH 行为一致

## 快速开始

**前置要求：** Node 22.19+。DSH 本体通过 `npx @deepseek-ai/dsh` 按需获取。

### 从 npm 安装

**安装插件** —— 下载已发布的包，并连同 `autoreport` preset 一起注册进 DSH 的
`web` profile：

```bash
npx @deepseek-ai/dsh plugin --profile web add autoreportdsh
```

**启动 DSH** —— Web UI 打开在 `http://127.0.0.1:3080`：

```bash
npx @deepseek-ai/dsh web
```

**升级已有安装：**

```bash
npx @deepseek-ai/dsh plugin --profile web update autoreportdsh
```

### 从源码安装

**构建并安装** —— 构建本仓库、把 `autoreport` preset 装进 DSH home、并把插件注册
进 DSH 的 `web` profile。使用 `PATH` 中的 `dsh`，不修改 DSH 本身；已安装时会先询问：

```bash
pnpm run install:source
```

加 `--yes` 跳过询问直接替换，适合脚本环境：

```bash
pnpm run install:source -- --yes
```

**启动 Web UI** —— 针对已安装的 profile 启动 `dsh web`，同一个界面，同一个默认地址：

```bash
pnpm run start:source
```

**`dsh` 不在 `PATH` 或名称不同时**，为上面两个脚本指定 DSH 命令：

```bash
AUTOREPORT_DSH_COMMAND="/path/to/dsh" pnpm run install:source
AUTOREPORT_DSH_COMMAND="/path/to/dsh" pnpm run start:source
```

### 写第一份报告

1. 打开 `http://127.0.0.1:3080`，选择 **`autoreport`** preset 启动 session，并选定
   实验目录。
2. 运行 `/init` 或直接在第一条消息里描述实验 —— 首个回合会创建标准目录结构，
   且不改动已有文件。`/init --language typst` 选择 Typst；LaTeX 与 Typst 文件
   可以共存，由项目设置决定当前语言。
3. 把测量数据和参考资料放进目录，让 Main 写报告；编译好的 PDF 会出现在 `Report/`。

## 配置

Provider、凭证和 Main 模型路由由 DSH 负责。本插件按以下顺序读取报告相关设置，并在
工作流开始时冻结结果，因此之后的修改不会影响正在进行的报告：

```text
项目设置            <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH 用户设置        namespace: autoreport
        ↓
composition 默认值
        ↓
schema 默认值
```

- **设置卡片** —— 报告语言、委派空闲超时、委派最长等待和 Python 解释器位于
  **设置 → 插件 → 插件配置**。
- **specialist 模型** —— 新建的 specialist 默认继承 Main 的模型，除非在 cordis 或
  项目设置中指定 `specialistModel`；运行中的 specialist 可在对话窗口切换模型。
- **Python** —— 三选一：由插件用 `uv` 在 `$DSH_HOME/autoreport/venv` 创建的托管环境
  （仅在你选中时创建，含 numpy、scipy、pandas、matplotlib；删除该目录即回收磁盘）、
  本机已有的解释器（conda、virtualenv、pyenv 或 `PATH`，包括存在时的
  `~/.autoreport/venv`；不会自动安装包），或任意自定义路径。agent 的 shell 会拿到
  `DSH_AUTOREPORT_PYTHON` 指向所选解释器；托管环境还会进入 `PATH`，因此裸的
  `python3` 也会解析到它。

## 工作区结构

实验目录保存报告所需的全部内容：

```text
.
├── Data/            原始数据（Data/Raw）与处理结果（Data/Processed）
├── References/      论文、图片、模板、自定义 skills
├── Theory/          Theory 智能体输出
├── Plots/           图表（Plots/Fig）与脚本（Plots/Scripts）
├── Report/          当前 LaTeX/Typst 源文件与编译后的 PDF
└── Outline/         Main 智能体的大纲与规划
```

程序状态不写进实验目录（`$DSH_HOME` 默认为 `~/.dsh`）：

```text
$DSH_HOME/
├── .agent-presets/autoreport/     已安装的 user preset
├── profiles/node_modules/autoreportdsh
└── autoreport/
    ├── resources/                 同步的模板、主题、skills
    ├── venv/                      AutoReport 托管的 Python（可选）
    └── <workspaceId>/
        ├── project.json           语言、Python、subagent 路由
```

### 角色权限

| 角色 | 写入目录 | 读取范围 |
|---|---|---|
| Main | `Outline/` | 全部目录 |
| Theory | `Theory/` | 全部目录 |
| Data Analysis | `Data/Processed/` | 全部目录 |
| Plotting | `Plots/` | 全部目录 |
| Report | `Report/` | 全部目录 |

## 开发

```text
AutoReportDSH/
├── cordis.template.yml    host + report-router overlay
├── patches/               sibling Harness API 补丁
├── presets/autoreport/    user preset（id = 目录名）
├── resources/             捆绑的 persona、skills、LaTeX 模板
├── scripts/               preset 安装、资源同步、client 构建
├── src/
│   ├── host.ts · preset.ts · runtime.ts · client/
│   ├── workflow/ · tools/ · policy/ · workspace/ · artifacts/
│   └── python-detect.ts · python-env.ts · settings.ts
└── tests/                 unit、integration、client/、eval/、e2e/
```

| 命令 | 作用 |
|---|---|
| `pnpm test` | 用 Vitest 运行 unit、integration、client、eval 测试套件 |
| `pnpm run typecheck` | 对 host 与 client 代码做类型检查，不产出文件 |
| `pnpm run build` | 清理 `dist/`，编译 TypeScript，复制资源，并构建 web client |
| `pnpm run sync:resources` | 把受管资源刷新到 `$DSH_HOME/autoreport/resources`，无需启动 DSH |
| `pnpm run install:preset` | 在 DSH home 中物化 `autoreport` user preset 及其 overlay（源码安装器会代为执行） |
| `pnpm run prepare:npm` | 构建并在 `dist/npm` 组装可发布的 npm 包 |

`tests/eval/workflow-eval.test.ts` 断言组装后的工作流路径：LaTeX 与 Typst 全链路、
blocked 委派的恢复、specialist 忘记声明完成、cold rebind、artifact `modified` 事件、
Python snapshot，以及 LaTeX/Typst 共存。真实 provider smoke 测试针对真实 DSH 安装
运行且为显式 opt-in：设置 `AUTOREPORT_LIVE_TEST=1`，把 `AUTOREPORT_E2E_DSH_HOME`
指向一个已配置好 provider 的 DSH home，然后运行

```bash
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

该测试从那个 DSH home 读取 provider，自身不声明任何 provider。详见
[docs/live-provider-testing.md](docs/live-provider-testing.md)。

CI（`.github/workflows/ci.yml`）在 Linux、macOS、Windows 上针对固定的 DSH 兼容
checkout 运行：应用临时补丁后依次执行 install、无密钥测试、typecheck 和 build。
依赖 pin 见 [docs/dependencies.md](docs/dependencies.md)。

设计与实现记录见 **[PLAN.md](PLAN.md)**。

## 参考项目

- [AutoReport](https://github.com/xjsongphy/AutoReport) — 本工作流来源的桌面版
- [AutoReportCLI](https://github.com/xjsongphy/AutoreportCLI) — 被移植的终端版工作流
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 运行时、session 与沙箱模型
