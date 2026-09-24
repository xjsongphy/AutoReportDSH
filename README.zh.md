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
- **资源完全内置** — 模板、主题、skills 及其参考文档都提交在 `resources/` 并直接从仓库读取；会话永不联网拉取或用远端内容替换 prompt
- **开箱即用** — 插件自带 persona、模板和 skills，新项目立即可跑

### 工作流
- **工作区自动初始化** — Main 首个回合只初始化一次；`/init` 用于手动修复或选择报告语言
- **可重置工作区** — `/reset` 清掉生成物（`Outline/`、`Theory/`、`Plots/`、`Report/`、`Data/Processed/`），保留 `References/` 与原始 `Data/`，重建骨架，并把本会话的任务板清空
- **任务与产物追踪** — Main 通过 `send_to_agent` 委派任务；specialist 在共享的 `manifest` 里描述自己的产出，下一个角色无需被告知即可找到；每个任务以声明完成收尾
- **specialist 可续写** — 每个 specialist 在后续任务中保留角色上下文；直接与它对话仍是普通对话
- **其余是原样 DSH** — 未选择 `autoreport` preset 的 session 与没有本插件的 DSH 行为一致

## 快速开始

**前置要求：** Node 22.19+。DSH 本体通过 `npx @deepseek-ai/dsh` 按需获取。

### 从 npm 安装

**安装插件** —— 下载已发布的包，并连同 `autoreport` preset 一起注册进 DSH 的
`web` profile：

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-autoreport
```

**启动 DSH** —— Web UI 打开在 `http://127.0.0.1:3080`：

```bash
npx @deepseek-ai/dsh web
```

**升级已有安装：**

```bash
npx @deepseek-ai/dsh plugin --profile web update dsh-autoreport
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
   且不改动已有文件。`/init typst`（或 `--language typst`）为该工作区选择
   Typst 并切换模板：上一种语言里没改过的模板会被删掉，改过的一律保留，
   已存在的文件绝不覆盖。每个工作区的语言可在
   **插件 → 已安装 → dsh-autoreport** 里选，那里按语言列出项目，一个控件即可
   把项目换到另一种语言。
3. 把测量数据和参考资料放进目录，让 Main 写报告；编译好的 PDF 会出现在 `Report/`。
4. 想重来就运行 `/reset`：清掉各阶段的生成物、重建骨架、清空本会话任务板。
   `References/` 和原始 `Data/` 绝不改动；没有二次确认——删用户输入正是重置不该做的事。

## 配置

Provider、凭证和 Main 模型路由由 DSH 负责。本插件按以下顺序读取报告相关设置，并在
工作流开始时冻结结果，因此之后的修改不会影响正在进行的报告：

```text
工作区语言          DSH 用户设置 namespace: autoreport，
                   按工作区根路径为键（权威）
        ↓
DSH 用户设置        namespace: autoreport（默认值、超时、Python、路由）
        ↓
composition 默认值
        ↓
schema 默认值
```

- **设置页** —— 报告语言、委派空闲超时、委派最长等待和 Python 解释器位于插件自己的
  页面：**插件 → 已安装 → dsh-autoreport**。同一页按语言列出项目，一个控件即可把
  项目换到另一种语言并切换它的模板。
- **specialist 模型** —— 新建的 specialist 默认继承 Main 的模型，除非在 cordis 或
  AutoReport 设置中指定 `specialistModel`；运行中的 specialist 可在对话窗口切换模型。
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
├── profiles/node_modules/dsh-autoreport
└── autoreport/
    ├── venv/                      AutoReport 托管的 Python（可选）
    └── <workspaceId>/
        └── workflow/<session id>/ session.jsonl — 工作流状态记录
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
| `pnpm run install:preset` | 在 DSH home 中物化 `autoreport` user preset 及其 overlay（源码安装器会代为执行） |
| `pnpm run prepare:npm` | 构建并在 `dist/npm` 组装可发布的 npm 包 |

`tests/eval/workflow-eval.test.ts` 断言组装后的工作流路径：LaTeX 与 Typst 全链路、
blocked 委派的恢复、specialist 忘记声明完成、cold rebind、artifact `modified` 事件、
Python snapshot，以及两种报告语言。真实 provider smoke 测试针对真实 DSH 安装
运行且为显式 opt-in：设置 `AUTOREPORT_LIVE_TEST=1`，把 `AUTOREPORT_E2E_DSH_HOME`
指向一个已配置好 provider 的 DSH home，然后运行

```bash
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

该测试从那个 DSH home 读取 provider，自身不声明任何 provider。详见
[docs/live-provider-testing.md](docs/live-provider-testing.md)。

CI（`.github/workflows/ci.yml`）在 Linux、macOS、Windows 上针对固定的 DSH 发布版
运行，依次执行 install、无密钥测试、typecheck 和 build。CI 与安装过程都不再给 DSH
打补丁：插件改为在进程内接管沙箱策略。依赖 pin 与兼容性接缝见
[docs/dependencies.md](docs/dependencies.md)。

设计记录（含被否决的方案与风险清单）见 **[PLAN.md](PLAN.md)**——rev 5、改 rev 8，
它自己也标注了哪些段落已属历史。**当前**行为、当前发布闸门与刻意留空的部分见
**[docs/own-features.md](docs/own-features.md)**。

## 参考项目

### 本工作流的来源

- [AutoReport](https://github.com/xjsongphy/AutoReport) — 本工作流来源的桌面版
- [AutoReportCLI](https://github.com/xjsongphy/AutoreportCLI) — 被移植的终端版工作流
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 运行时、session 与沙箱模型

### 内置文档的来源

模板、主题、skill 文档与语言指引都提交在 `resources/` 下并直接从仓库读取；运行时
不拉取、也不替换任何内容。因此署名放在这里，而不是某张同步表里，且每个上游自己的
许可证文件都随副本一起保存。

| 上游 | 许可证 | 贡献内容 |
| --- | --- | --- |
| [lucifer1004/claude-skill-typst](https://github.com/lucifer1004/claude-skill-typst) | MIT | `typst` skill 及其四篇参考文档（`resources/typst/skills/typst/`） |
| [xjsongphy/pkumpl-typst](https://github.com/xjsongphy/pkumpl-typst) | CC BY-SA 4.0 | Typst 主题、模板与参考文献资源（`resources/typst/`） |
| [CastleStar14654/PKUMpLtX](https://github.com/CastleStar14654/PKUMpLtX) | CC BY-SA 4.0 | `mpltx.cls`，北大近代物理实验 LaTeX 文档类（基于 `revtex4-2`），Typst 主题即其移植 |
| [xjsongphy/skills](https://github.com/xjsongphy/skills) | 上游未声明 | `latex-compile` skill，以及 `experiment-report-writer` 投影——其上游 commit 与逐模块 blob 哈希记录在同目录的 `provenance.json` |
| [citation-style-language/styles](https://github.com/citation-style-language/styles) | CC BY-SA 3.0 | `american-physics-society.csl`，作者 Richard Karnesky |

上游提供了许可证文件的，都把该文件与副本放在一起，让声明与其覆盖的内容同处一地。
`xjsongphy/skills` 未声明许可证，因此它那两份内置文档也不带。

仅在运行时引用、未内置：

- [MinerU](https://github.com/opendatalab/MinerU) — `pdf-reference-reader` 调用的 `mineru-open-api` CLI，把 `References/` 下的 PDF 抽取到 `Outline/.cache/mineru/`

## 许可证

本项目自身的代码——host 装配、工具、策略、工作流运行时与测试——采用
[MIT](LICENSE)。

内置文档**不**因该授权而改变许可证：每一份都保留自己的许可证，列在
[参考项目](#参考项目)中；上游提供了许可证文本的，文本就提交在副本旁边：

- `resources/typst/` 的其余部分 — CC BY-SA 4.0（[`LICENSE`](resources/typst/LICENSE)），来自 `pkumpl-typst`
- `resources/typst/skills/typst/` — MIT（[`LICENSE`](resources/typst/skills/typst/LICENSE)），来自 `claude-skill-typst`
- `resources/latex/themes/` — CC BY-SA 4.0（[`LICENSE`](resources/latex/themes/LICENSE)），`mpltx.cls` 来自 PKUMpLtX
- `resources/typst/templates/american-physics-society.csl` — CC BY-SA 3.0，声明在其自身的 `<rights>` 元素里
- `resources/skills/` — 内置自 `xjsongphy/skills`，该仓库未声明许可证

CC BY-SA 文档带传染性（share-alike）：本仓库再分发它们，且它们在本地的改动
（重定向的交叉引用、删除的死链、精简过的索引）与原文保持同一许可证。
