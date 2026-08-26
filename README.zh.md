<p align="center">
  <img src="assets/title.svg" alt="AutoReportDSH — 在 DeepSeek Harness 上生成物理实验报告" width="100%" />
</p>

<p align="center">
  面向物理实验报告的固定角色工作流，构建于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>。
</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

> **开发者预览版。** 当前支持从源码安装，并有完整的无密钥集成测试覆盖。npm/DSH bundle 正式发布流程已预留，但尚未发布。

AutoReportDSH 将 [AutoReportCLI](../autoreportcli) 的报告领域工作流迁移为 DeepSeek Harness（`dsh`）插件。DSH 负责通用运行时：agent loop、持续子会话、持久化、上下文压缩、模型路由、工具管线、子进程生命周期、审批和 Web UI。AutoReportDSH 只负责报告领域语义：固定角色、委派状态、角色权限、离线执行、报告资源、编译和产物追踪。

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

模型使用 DSH 原生的文件、搜索、技能、压缩和用户提问能力。MAIN 只额外看到很小的 AutoReport 领域接口：

```text
send_to_agent     向固定角色委派任务，并持久化任务/版本状态
report_task       当前工作流的状态与清单管理
```

specialist 是 DSH continuable child session。它们会保留角色上下文，能够接收后续任务，并通过 `report_workflow` 返回结构化结果。用户直接与 specialist 对话时，那是普通对话；没有活跃 workflow delegation 上下文时，不会自动创建或完成任务。

## 与普通 DSH 共存

安装 overlay 不会把所有 DSH session 变成 AutoReport：

```text
standard           普通 DSH 行为
autoreport-main    AutoReport 物理实验报告工作流
```

只有有效 preset 为 `autoreport-main` 的顶层 session 才会进入 AutoReport runtime。普通 session 保留原有 shell、文件权限、子 agent report 工具和工作目录行为；这一共存约束已有集成测试。

## 从源码运行

这是当前支持的安装方式。两个仓库需要是相邻目录，因为开发版依赖本地 `deepseek-harness` checkout。

### 前置条件

- Node.js `22.19+` 或 `24+`
- 启用 Corepack 的 pnpm
- 本地 DeepSeek Harness checkout，且版本与 [docs/dependencies.md](docs/dependencies.md) 中记录的版本兼容
- specialist 进程执行支持 macOS 或 Linux
  - macOS 使用 Seatbelt 网络拒绝配置。
  - Linux 使用带网络 namespace 的 Bubblewrap。
  - Windows 在验证等价网络隔离前故意不支持。

### 1. 获取并构建 DeepSeek Harness

```sh
cd /path/to/your/development-directory

git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
# 将本仓库克隆或放置为相邻目录 AutoReportDSH。

cd deepseek-harness
corepack enable
pnpm install
pnpm run build
```

> AutoReportDSH 目前需要 DSH 的 `Session.append(type, data, { ignorable: true })` 写入 API。正式发布前请使用 [docs/dependencies.md](docs/dependencies.md) 说明的兼容本地 checkout；发布版会将其约束到相应的 DSH 版本范围。

### 2. 安装、测试并构建 AutoReportDSH

```sh
cd ../AutoReportDSH

pnpm install
pnpm test
pnpm run build
```

无密钥测试会覆盖 workflow 持久化、preset 成员判定、角色目录边界、网络隔离、报告资源、产物 manifest 和真实 Loader 启动。

### 3. 安装 AutoReport preset

```sh
pnpm run install:preset
```

该命令会写入渲染后的 user preset：

```text
$DSH_HOME/.agent-presets/autoreport-main/
```

并在本仓库生成 `cordis.overlay.generated.yml`。命令可重复运行：会更新 AutoReport 自己管理的 preset 文件，并保留 user preset 目录下无关的用户文件。

使用隔离的 harness home：

```sh
DSH_HOME=/tmp/autoreport-dsh-home \
  pnpm run install:preset -- --home "$DSH_HOME"
```

### 4. 使用 overlay 启动本地 harness

```sh
cd ../deepseek-harness

pnpm dsh web \
  --port 3081 \
  --patch ../AutoReportDSH/cordis.overlay.generated.yml
```

访问 `http://127.0.0.1:3081`，新建 session 后选择 **`autoreport-main`**。若已有 DSH Web 服务占用默认的 `3080` 端口，请使用其他端口。

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

AutoReportDSH 只管理报告工作流配置。每个字段按以下优先级解析一次：

```text
显式 workflow override
        ↓
项目设置            <dshHome>/autoreport/<workspaceId>/project.json
        ↓
AutoReport 用户设置
        ↓
Cordis composition 默认值
        ↓
schema 默认值
```

解析后的值会写入 durable `autoreport/workflow` event 的 `WorkflowSettingsSnapshot`。之后修改默认设置，不会改变正在执行的报告。

当前 composition 默认值：

```text
defaultReportLanguage   latex
defaultLatexEngine      latexmk
specialistModel         继承 MAIN（仅可选 DSH route 选择策略）
defaultPythonEnv        环境 PATH
executionTimeoutMs      600000
```

可选的 AutoReport Web 设置卡与用户 namespace 集成，等待 `@deepseek-ai/dsh-settings` 能作为 out-of-tree dependency 使用后再加入。项目设置和 composition 默认值已可用。

## 安全模型

角色边界由运行时强制执行，而不只是 persona 中的文字约束：

- 每个角色只能写入固定的可写根目录。
- `autoreport-main` 不挂载通用 shell 工具。
- specialist 命令通过 `report_exec` 执行：显式 argv、DSH 子进程生命周期管理、角色目录隔离。
- specialist 默认拒绝网络访问。
- `compile_report` 只对 REPORT 开放。
- 用户直接与 specialist 对话时，角色文件权限不变。

## 测试

```sh
pnpm test
pnpm run build
```

OpenRouter 真实 API 测试是显式 opt-in：

```sh
export OPENROUTER_API_KEY=...
pnpm vitest run tests/e2e/openrouter.e2e.test.ts
```

`stealth/ox-alpha` 的 Anthropic-compatible route 见 [docs/openrouter-testing.md](docs/openrouter-testing.md)。真实 e2e 在失败时会保留经过脱敏的 DSH retry 诊断；不会把凭证写入仓库或测试产物。

## 计划中的 npm / DSH bundle 发布方式

以下是**正式发布后**的预期流程，目前不要执行。只有当 AutoReportDSH 发布为 npm DSH bundle，且所需 DSH append API 已进入发布版本范围后，这些命令才可用：

```sh
# 计划中：将已发布 bundle 安装到 web profile。
npx @deepseek-ai/dsh plugin --profile web add @xjsongphy/autoreportdsh

# 计划中：从 profile 中安装的包生成 user preset。
npx @xjsongphy/autoreportdsh setup --profile web

# 正常启动 DSH；需要报告时选择 autoreport-main。
npx @deepseek-ai/dsh web
```

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
├── runtime.ts              workflow state、waiters、artifacts、manifests、settings snapshot
├── workflow/               events、projections、registry、waiters、report observer
├── tools/                  delegation、报告返回、角色执行、编译
├── policy/                 tool guard 与 Seatbelt/Bubblewrap 隔离
├── workspace/              目录、资源、命令和 skill loader
├── artifacts/              过滤、观察和外部 manifest projection
└── settings.ts             项目/用户/默认设置解析
docs/                       dependency 与 OpenRouter 测试说明
tests/                      unit、integration、boot、可选真实 API 测试
```

## 当前限制

- Windows specialist 执行会 fail closed，直到验证等价网络隔离。
- MinerU/联网文档提取不属于 v1 的离线执行策略。
- artifact manifest 由运行时生成，agent 不能添加自由文本备注。
- 当前保留 `report_task` 以维持现有 workflow 合约；后续会依据真实 trace，将更多任务生命周期记账收敛到 `send_to_agent` 与 report observer 内部。

## 许可证

npm 发布前会补充仓库许可证和第三方资源声明。当前请查看本仓库记录的资源来源及上述上游项目。
