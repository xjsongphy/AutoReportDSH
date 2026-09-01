<div align="center">

<img src="assets/title.svg" alt="AutoReportDSH" width="100%" />

### 面向 DeepSeek Harness 的固定团队物理实验报告工作流

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#)
[![Node](https://img.shields.io/badge/node-22.19%2B-339933.svg)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-3366cc.svg)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

</div>

一款运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的
**固定团队报告工作流**，用 LaTeX 或 Typst 自动撰写物理实验报告。它把
[AutoReportCLI](../autoreportcli) 的报告领域行为迁成 `dsh` 插件 —— 不再造第二套
harness，不自带 provider，不加一层 agent loop。
DSH 是运行时，实验目录就是项目；选择 **`autoreport`** 即进入工作流。

该插件遵循 DSH 标准的可安装 bundle 机制；源码仓库也提供了向用户现有 DSH 安装插件的一键脚本。

## 概述

AutoReportDSH 保留 AutoReportCLI 的五角色报告流水线，但跑在 DSH 里。打开一个实验目录，
选择 `autoreport` preset，通过普通 DSH session 协调 Main、Theory、Data Analysis、
Plotting 和 Report。未选择该 preset 的 `standard` session 仍是原样 DSH。

## 功能特性

### 核心能力
- **多智能体协作** — Main、Theory、Data Analysis、Plotting、Report 分工协作，并拥有各自的写入边界
- **面向项目目录** — 当前文件夹即实验项目；`/report-init` 或 MAIN 的首个 turn 会创建标准目录，不覆盖已有用户文件
- **LaTeX 与 Typst 报告** — 支持语言选择、内置模板/主题、参考文献资源、编译 skill，以及基于 Python 的数据分析和绘图
- **使用 DSH 的 Provider** — 只用 DSH 里已配置的模型路由；AutoReportDSH 不维护自己的凭证或 provider 列表
- **资源同步** — 插件启动时把清单中的远端刷新到 `$DSH_HOME/autoreport/resources`；`pnpm run sync:resources` 不必启动 DSH 也能做同样的事
- **任务与产物追踪** — `send_to_agent` 记录持久化任务和版本；artifact 事件记录实际变更；各 agent 用 `manifest` 读取其他角色的文件说明、更新自己的说明和 role notes，再用 `report_workflow` 结束
- **安全执行** — DSH `workspace-write` 把每个角色钉在各自的可写根目录；AutoReport session 不能通过 `sandbox_permissions` 提权；网络允许访问
- **内置默认资源** — 自带 persona、模板和 skills，新项目开箱即用

### 工作流
- **可选 preset** — 只有顶层 `autoreport` session 进入 runtime；加载 overlay 不会改变普通 DSH session
- **很小的模型接口** — MAIN 只增加 `send_to_agent` 和 `manifest`（外加 DSH 的 `ask_user_question`）；subagent 增加 `manifest` 和 `report_workflow`；其余是 DSH 的 `read` / `write` / `edit` / `bash` / `skill`
- **可续写的 subagent** — child 在后续任务中保留角色上下文；用户直接与 subagent 对话是普通对话，不会自动变成 workflow 任务
- **按角色隔离的 skill** — MAIN 有 `pdf-reference-reader`；REPORT 有 `experiment-report-writer` 以及 `latex-compile` 或 `typst-compile`；实验目录 `References/skills` 是按 cwd 发现的 DSH skill 根
- **设置与实时模型** — 语言、等待超时和 Python 在 **设置 → 插件 → 插件配置**；运行中的 subagent 在对话窗口切换模型
- **Python 环境** — AutoReport 托管 venv 仅在你选中时用 `uv` 创建（`$DSH_HOME/autoreport/venv`，安装 numpy/scipy/pandas/matplotlib）；或检测到的本机解释器；或自定义路径。未选择则不占磁盘；删除该目录即可回收空间。owned bash 注入 `DSH_AUTOREPORT_PYTHON` 并前置 PATH，因此裸的 `python3` 也会打到该解释器

## 快速开始

### 从 npm 安装

`autoreportdsh` 发布后，按 DSH 标准方式安装到 Web profile：

```bash
npx @deepseek-ai/dsh plugin --profile web add autoreportdsh
npx @deepseek-ai/dsh web
```

安装器会自动加入 `autoreport` preset。打开 DSH 默认的
`http://127.0.0.1:3080`，选择 **`autoreport`**，再选择实验目录。

升级已有安装：

```bash
npx @deepseek-ai/dsh plugin --profile web update autoreportdsh
```

### 从源码安装

源码安装器会使用 PATH 中已经安装的 DSH。它只构建 AutoReportDSH、安装
`autoreport` preset，并把插件加入 DSH 正常的 `web` profile；不会 clone 或修改 DSH：

```bash
git clone https://github.com/xjsongphy/AutoReportDSH.git
cd AutoReportDSH
pnpm run install:source
```

如果 AutoReportDSH 已经安装，安装器会先询问是否覆盖。要在非交互环境中明确升级，使用
`pnpm run install:source -- --yes`。

然后启动 Web UI：

```bash
pnpm run start:source
```

默认地址仍是 `http://127.0.0.1:3080`。如果 DSH 可执行文件名称或位置不标准，设置
`AUTOREPORT_DSH_COMMAND` 即可。

## 配置

Provider、凭证和 MAIN 模型路由由 DSH 负责。AutoReportDSH 只在工作流开始时冻结报告策略：

```text
项目设置            <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH 用户设置        namespace: autoreport
        ↓
composition 默认值
        ↓
schema 默认值
```

之后改设置，不会影响正在跑的报告。

- **设置卡片** — `defaultReportLanguage`、`delegationWaitTimeoutMs`、`pythonExecutable` 在 **设置 → 插件 → 插件配置**
- **subagent 模型** — 新建 subagent 默认继承 MAIN，除非在 cordis 或项目设置里写了 `specialistModel`；运行中的 subagent 在对话窗口切换（`session.models` / `selectModel`）
- **Python** — 托管（`__managed__` → `$DSH_HOME/autoreport/venv`，保存时用 `uv venv` 创建再 `uv pip install numpy scipy pandas matplotlib`；未选择不会创建；删除该目录即可回收空间）、本机（conda / virtualenv / pyenv / PATH，若存在也包括 `~/.autoreport/venv`；不会自动装包），或自定义绝对路径
- **`/report-init [--language latex|typst]`** — 幂等初始化；LaTeX 与 Typst 文件可以共存，活动语言由项目设置决定。命令注册在 host 全局 catalog；非 AutoReport session 会在产生任何文件改动前被拒绝

## 工作区结构

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

```bash
pnpm test
pnpm run build
```

`tests/eval/workflow-eval.test.ts` 覆盖 assembled workflow 路径（LaTeX/Typst 全链路、
blocked 恢复、忘记 `report_workflow`、cold rebind、artifact `modified`、Python snapshot、
coexistence）。真实 provider smoke 是显式 opt-in：

```bash
export AUTOREPORT_LIVE_TEST=1
export AUTOREPORT_E2E_DSH_HOME="/path/to/configured/dsh-home"
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

见 [docs/live-provider-testing.md](docs/live-provider-testing.md)。该测试不声明
provider 或 API key。

CI（`.github/workflows/ci.yml`）在 Linux、macOS、Windows 上针对固定的 DSH 兼容 checkout
运行：应用临时补丁后执行 install、无密钥测试、typecheck 和 build。运行
`pnpm run prepare:npm` 可在 `dist/npm` 生成待发布 bundle；npm 用户通过 DSH 标准的
`dsh plugin --profile web add autoreportdsh` 安装。

设计与实现记录见 **[PLAN.md](PLAN.md)**；依赖 pin 见
**[docs/dependencies.md](docs/dependencies.md)**。
