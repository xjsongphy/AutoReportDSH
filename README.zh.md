<p align="center">
  <img src="assets/title.svg" alt="AutoReportDSH — 在 DeepSeek Harness 上生成物理实验报告" width="100%" />
</p>

<p align="center">
  面向物理实验报告的固定角色工作流，构建于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-3f7ecb?style=flat-square" alt="支持 macOS、Linux 和 Windows" />
  <img src="https://img.shields.io/badge/runtime-Node%2022.19%2B-339933?style=flat-square" alt="Node.js 22.19 或更高版本" />
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-3366cc?style=flat-square" alt="DeepSeek Harness 插件" />
  <img src="https://img.shields.io/badge/report-LaTeX%20%7C%20Typst-7560c8?style=flat-square" alt="支持 LaTeX 与 Typst" />
  <img src="https://img.shields.io/badge/status-developer%20preview-f2a900?style=flat-square" alt="开发者预览版" />
</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

> **开发者预览版。** 当前支持从源码安装，并有完整的无密钥集成测试覆盖。npm/DSH bundle 正式发布流程已预留，但尚未发布。

AutoReportDSH 将 [AutoReportCLI](../autoreportcli) 的报告领域工作流迁移为 DeepSeek Harness（`dsh`）插件。DSH 负责通用运行时：agent loop、持续子会话、持久化、上下文压缩、模型路由、工具管线、子进程生命周期、审批、沙箱和 Web UI。AutoReportDSH 只负责报告领域语义：固定角色、委派状态、角色可写根目录、报告资源、编译 skill 和产物追踪。

完整架构和实现记录见 [PLAN.md](PLAN.md)。

## 功能概览

选择可选的 **`autoreport-main`** agent preset 后，会启用一个固定的五角色团队：

| 角色 | 职责 | 可写目录 |
|---|---|---|
| MAIN | 审计实验范围、跟踪依赖、委派任务、面向用户汇报 | `Outline/` |
| THEORY | 理论推导、假设与可复用公式 | `Theory/` |
| DATA_ANALYSIS | 处理原始测量数据与定量结果 | `Data/Processed/` |
| PLOTTING | 绘图脚本与图像 | `Plots/` |
| REPORT | LaTeX/Typst 源码与报告编译 | `Report/` |

模型使用 DSH 原生的 `read` / `write` / `edit` / `bash` / `skill`（搜索走 bash 中的 `rg`/`find`）。MAIN 只额外看到很小的 AutoReport 领域接口：

```text
send_to_agent     向固定角色委派任务，并持久化任务/版本状态
ask_user_question DSH 原生结构化提问，用于需求缺口
```

specialist 是 DSH continuable child session。它们会保留角色上下文，能够接收后续任务，并通过 `report_workflow` 返回结构化结果。用户直接与 specialist 对话时，那是普通对话；没有活跃 workflow delegation 上下文时，不会自动创建或完成任务。

AutoReport 专属 skill 按角色隔离：MAIN 有 `pdf-reference-reader`（MinerU / mineru-open-api），把 References 中的 PDF 抽到 `Outline/.cache/mineru/`；REPORT 通过渐进披露获得 `experiment-report-writer` 和当前语言的编译 skill（`latex-compile` 或 `typst-compile`）；THEORY、DATA_ANALYSIS、PLOTTING 不获得这些领域 skill。实验目录 `References/skills` 是按 cwd 发现的 DSH skill 根。DSH 的用户/项目 skill 仍遵循原本的 DSH 可见性。

## 与普通 DSH 共存

安装 overlay 不会把所有 DSH session 变成 AutoReport：

```text
standard           普通 DSH 行为
autoreport-main    AutoReport 物理实验报告工作流
```

只有有效 preset 为 `autoreport-main` 的顶层 session 才会进入 AutoReport runtime。普通 session 保留原有 shell、文件权限、子 agent report 工具和工作目录行为；这一共存约束已有集成测试。

## 安装

**现在：** 从源码安装（本节）。这是当前唯一支持的方式。

**以后：** 包发布到 npm 后，用 `dsh plugin add` 安装。命令见 [计划中的 npm / DSH bundle 发布方式](#计划中的-npm--dsh-bundle-发布方式)，**现在还不能用**。

## 从源码运行

两个仓库必须是相邻目录：开发版 `package.json` 用 `link:` 指向本地 harness checkout。

### 前置条件

- Node.js `22.19+` 或 `24+`
- 启用 Corepack 的 pnpm
- 本地 DeepSeek Harness checkout，版本为 [docs/dependencies.md](docs/dependencies.md) 中的 pin，并已打上 `patches/` 里的两份补丁
- DSH 原生 bash 与 workspace-write 沙箱（macOS Seatbelt、Linux bwrap/Landlock、Windows ACL）

### 1. 将两个仓库克隆为相邻目录

```sh
cd /path/to/your/development-directory

git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
git clone https://github.com/xjsongphy/AutoReportDSH.git AutoReportDSH
```

### 2. 给 DeepSeek Harness 打补丁并构建

在 DSH 自身发布 `Session.append(..., { ignorable: true })` 和逐会话 `sandbox/workspace-root` 之前，打上与 CI 相同的补丁（见 [docs/dependencies.md](docs/dependencies.md)）：

```sh
cd deepseek-harness
git checkout <docs/dependencies.md 中的 DSH_REF>
git apply ../AutoReportDSH/patches/deepseek-harness-ignorable-append.patch
git apply ../AutoReportDSH/patches/deepseek-harness-sandbox-workspace-root.patch
corepack enable
pnpm install
pnpm run build
```

PATH 上已有的 `@deepseek-ai/dsh` 全局 CLI **不能**代替这份打过补丁的 checkout，直到上述 API 进入已发布的 DSH 版本。

### 3. 安装、测试并构建 AutoReportDSH

```sh
cd ../AutoReportDSH

pnpm install
pnpm test
pnpm run build
```

无密钥测试会覆盖 workflow 持久化、preset 成员判定、角色可写根目录、报告资源、产物 manifest 和真实 Loader 启动。

### 刷新外部维护的 skill

运行时不会拉取资源。`pnpm run sync:resources` 只下载 `scripts/sync-resources.ts` 里 `MANAGED_RESOURCES` 列出的文件。该列表目前为空；捆绑 skill 在本仓库的 `resources/skills/`。

### 4. 安装 AutoReport preset

```sh
pnpm run install:preset
```

该命令会写入渲染后的 user preset：

```text
$DSH_HOME/.agent-presets/autoreport-main/   # 默认 home 是 ~/.dsh
```

把本包装到 `$DSH_HOME/profiles/node_modules/autoreportdsh`（供 Web 加载设置卡片），并在本仓库生成 `cordis.overlay.generated.yml`。安装器会覆盖 AutoReport 自己管理的 preset 文件，并保留该目录下无关的用户文件。若要彻底替换过期安装，先删除 `$DSH_HOME/.agent-presets/autoreport-main/` 再重跑。

使用隔离的 harness home：

```sh
DSH_HOME=/tmp/autoreport-dsh-home \
  pnpm run install:preset -- --home "$DSH_HOME"
```

直接运行 `dsh web` **不会**加载 AutoReport。overlay 不在 stock 的 web/headless profile 里，每次启动都要带 `--patch`。

### 5. 使用 overlay 启动本地 harness

启动**打过补丁的 sibling** harness（在上述两个 API 进入 DSH 发布版之前必须如此）：

```sh
cd ../deepseek-harness

pnpm dsh web \
  --port 3081 \
  --patch ../AutoReportDSH/cordis.overlay.generated.yml
```

访问 `http://127.0.0.1:3081`，新建 session 后选择 **`autoreport-main`**。报告工作流默认值在 **设置 → 插件 → 插件配置 → AutoReport**。若已有 DSH Web 服务占用默认的 `3080` 端口，请使用其他端口。

若 PATH 上已有全局 `dsh`（`npm i -g @deepseek-ai/dsh`），同一 `--patch` 只有在该 CLI 已包含上述两个 API 时才能用。在此之前请用 sibling checkout 里的 `pnpm dsh`，不要用全局二进制：

```sh
dsh web --port 3081 --patch /absolute/path/to/AutoReportDSH/cordis.overlay.generated.yml
```

单次 headless 运行：

```sh
pnpm dsh headless \
  --patch ../AutoReportDSH/cordis.overlay.generated.yml \
  "为这个实验工作目录创建报告大纲"
```

## 第一次报告工作流

选择 `autoreport-main` 后，可显式初始化工作目录；或者由 MAIN 的首个 workflow turn 自动、幂等地初始化：

```text
/report-init
/report-init --language latex
/report-init --language typst
```

`/report-init` 会创建所需目录并仅补齐缺失资源，绝不覆盖用户文件。LaTeX 与 Typst 文件可以共存，实际活动语言由 project setting 决定。

```text
Data/
├── Processed/
References/
Theory/
Plots/
├── Fig/
└── Scripts/
Report/
Outline/
```

随后可以直接让 MAIN 开始：

```text
审阅实验文件，创建报告任务，并产出第一版报告草稿。
```

MAIN 通过 `send_to_agent` 有界地委派工作；specialist 读取共享工作目录，并把持久化结果返回 MAIN。

## 配置

DSH 负责所有模型/provider 和凭证配置；AutoReportDSH 只使用 DSH 中已配置的模型路由，不维护自己的 provider 系统。

AutoReportDSH 只管理报告工作流配置。新工作流按以下优先级冻结设置：

```text
项目设置            <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH 用户设置        namespace: autoreport
        ↓
Cordis composition 默认值
        ↓
schema 默认值
```

解析后的值会写入 durable `autoreport/workflow` event 的 `WorkflowSettingsSnapshot`。之后修改设置，不会改变正在执行的报告。resolver 保留了内部 workflow override seam，供未来的结构化 command 使用；v1 故意不提供用户入口。

当前 composition 默认值：

```text
defaultReportLanguage   latex
specialistModel         继承 MAIN（可选的 shared DSH route 选择）
delegationWaitTimeoutMs 600000
pythonExecutable        可选，specialist bash 使用的解释器
```

`autoreport` 用户设置 namespace 已通过 `@deepseek-ai/dsh-settings` 注册并持久化、校验 `defaultReportLanguage`、`specialistModel`、`delegationWaitTimeoutMs` 和可选的 `pythonExecutable`。浏览器设置卡片在 **设置 → 插件 → 插件配置**。修改这些值不会改变已经在跑的报告。配置了 `specialistModel.reasoningEffort` 时，会通过 DSH 的 agent-scoped model-selection seam 真正生效，而非只记录快照。

## 安全模型

角色边界由运行时强制执行，而不只是 persona 中的文字约束：

- 每个角色的导航 cwd 都是实验根目录。
- DSH `workspace-write` 沙箱把每个角色钉在各自的可写根目录（`Outline/`、`Theory/`、`Data/Processed/`、`Plots/`、`Report/`）。
- 五个角色都使用 DSH 原生 `bash`。网络允许访问；可写根目录隔离与网络策略是两件事。
- AutoReport session 不能通过 `sandbox_permissions` 扩大写权限。
- MAIN 可以用 bash 和 `pdf-reference-reader` skill 解析 PDF，但不能写到 `Outline/` 以外。
- specialist 通过 bash 与 skill 编译、运行 Python，不再使用专用 model tool。
- 用户直接与 specialist 对话时，角色文件权限不变。

## 测试

```sh
pnpm test
pnpm run build
```

真实 provider smoke 是显式 opt-in，并直接使用 DSH 当前已配置的默认模型路由：

```sh
export AUTOREPORT_LIVE_TEST=1
export AUTOREPORT_E2E_DSH_HOME="/path/to/configured/dsh-home"
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

见 [docs/live-provider-testing.md](docs/live-provider-testing.md)。该测试不声明 provider、模型、endpoint 或 API key；由 DSH 按所选 deployment profile 使用实际配置的 route。

### GitHub Actions CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 PR 和 `main` push 时分别于 Linux、macOS、Windows 运行。此开发预览包故意使用 sibling Harness 的 `link:` 依赖，因此 CI 会 checkout [docs/dependencies.md](docs/dependencies.md) 固定的 Harness、打上 `patches/` 中的两份补丁、先构建 Harness，再执行 immutable install、keyless tests、typecheck 和 build。真实 API 测试仍为 opt-in；该 workflow 不接收凭证。

## 计划中的 npm / DSH bundle 发布方式

**现在不要执行这些命令。** AutoReportDSH 尚未发布到 npm，也没有正式的 DSH bundle，因此 `dsh plugin add` 装不上。

等包发布**并且**某个 DSH 发布版包含所需的 append 与 sandbox API 之后，预期的用户安装方式是：

```sh
# 把已发布 bundle 装进 web profile（npm 包名以发布时为准）。
dsh plugin --profile web add @xjsongphy/autoreportdsh

# 从该 profile 里已安装的包生成 user preset。
npx @xjsongphy/autoreportdsh setup --profile web

# 正常启动 DSH；需要报告时选择 autoreport-main。
# overlay 进入 profile 层之后不再需要 --patch。
dsh web
```

在此之前请留在 [从源码运行](#从源码运行)：sibling checkout、补丁、`pnpm run build`、`pnpm run install:preset`，以及 `pnpm dsh … --patch ./cordis.overlay.generated.yml`。

正式包将包含预构建 `dist/`、DSH bundle manifest、host/router patch 和 setup executable；会改用带版本范围的 DSH peer dependencies，而不是当前源码开发时的本地 `link:` 依赖。也可能支持：

```sh
dsh plugin --profile web add github:...
```

Git 安装只会下载源代码，pnpm 需要用户明确允许 `prepare` build script；普通用户安装优先使用 npm 预构建包。

## 仓库结构

```text
assets/title.svg            README 标题图
cordis.template.yml         生成 host/router overlay 的模板
presets/autoreport-main/    user preset 模板
resources/                  报告资源和 preset-scoped skills
scripts/install-user-preset.ts
src/
├── host.ts                 host runtime、成员判定、guard、/report-init
├── preset.ts               单一 preset-plane AutoReport contribution
├── client/                 Web 设置卡片（插件配置 tab）
├── runtime.ts              workflow state、waiters、artifacts、manifests、settings snapshot
├── workflow/               events、projections、registry、waiters、report observer
├── tools/                  send_to_agent、report_workflow
├── policy/                 role guard 与按角色的 DSH sandbox 根目录
├── python-env.ts           DSH_AUTOREPORT_PYTHON shell-env 事实
├── workspace/              目录、资源、命令和 skill loader
├── artifacts/              过滤、观察和外部 manifest projection
└── settings.ts             项目/用户/默认设置解析
docs/                       dependency 与 live-provider 测试说明
tests/                      unit、integration、boot、可选真实 API 测试
```

## 当前限制

- Windows live bash 禁写测试走 DSH 的 windows-acl runner。GitHub `windows-latest` 在 runner 或 Git Bash 不可用时会失败，而不是跳过。
- MinerU 由 MAIN 通过 bash 与 `pdf-reference-reader` skill 调用（输出 `Outline/.cache/mineru/`），没有单独的 MinerU model tool。
- artifact manifest 由运行时生成，agent 不能添加自由文本备注。
- 任务生命周期已内化：MAIN 通过 `send_to_agent` 委派（省略 `task_id` 时自动创建任务）；specialist 通过 `report_workflow` 结束，report observer 负责 settle durable 状态。
- role guard 仍对 write/edit 路径做 defense in depth；preset 不挂载 `delete` 或 `apply_patch`。

## 许可证

npm 发布前会补充仓库许可证和第三方资源声明。当前请查看本仓库记录的资源来源及上述上游项目。
