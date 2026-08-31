# AutoReportDSH：DSH Web 实测与可观测性指南

本文记录将 `AutoReportDSH` 接入本地 DeepSeek Harness（DSH）时，如何配置模型、观察工作流，以及验证最终实验报告。示例工作区为 `~/Develop/CV`，报告语言为 Typst。

## 1. 已核实的运行架构

- DSH 管理 provider、模型、凭据、会话、子会话、Web UI、工具执行和日志持久化。
- AutoReportDSH 仅管理报告工作流：MAIN 与 THEORY、DATA_ANALYSIS、PLOTTING、REPORT 四个固定 subagents、目录权限、任务/委派状态、报告资源和产物 manifest。
- MAIN 的模型由 DSH 的 `agent-default-model` 决定；每个 subagent 可继承 MAIN，或由 AutoReport 项目设置的 `specialistModel` 独立指定。此次测试将两者均固定为 `openai-codex / gpt-5.6-luna`。
- 专项目录外的设置文件为：`$DSH_HOME/autoreport/<workspace-id>/project.json`。`workspace-id` 是工作区绝对路径 SHA-256 的前 16 位，避免把配置或机密写进实验目录。
- 工作流建立时会冻结模型和语言等设置快照；随后修改默认设置不会改变该工作流。

## 2. 本次模型配置

目标路由为：

```yaml
agent-default-model:
  provider: openai-codex
  model: gpt-5.6-luna
  reasoningEffort: xhigh
```

对应的 DSH `autoreport` 用户设置为：

```json
{
  "defaultReportLanguage": "typst",
  "specialistModel": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "reasoningEffort": "xhigh"
  }
}
```

凭据由已有的 DSH `openai-codex` OAuth credential store 提供；测试脚本不会读取、复制、导出或写入 token。

## 3. 启动与工作区初始化

先写入 CV 的外部项目设置、构建并安装 preset。此流程使用已有 DSH OAuth 凭据；不复制、导出或写入任何 token：

```sh
cd ~/Develop/AutoReportDSH
./.autoreportdsh-local/prepare-cv-test.sh
```

从 sibling harness checkout 启动 Web（`--no-open` 适用于自动化和人工检查）：

```sh
./.autoreportdsh-local/start-cv-web.sh
```

打开 `http://127.0.0.1:3081`，创建 session 时选择 `autoreport`，工作目录选择 `~/Develop/CV`。首个报告工作流 turn 会自动、幂等地完成初始化；需要单独检查时也可运行：

```text
/report-init --language typst
```

初始化只创建缺失目录和资源；已存在的 `Report/main.typ`、`Report/mplts.typ` 等文件不会覆盖。API 测试脚本不再先队列该命令，以免将 slash-command turn 与后续报告 turn 混淆。

## 4. 在页面中观察什么

- **Chat**：用户消息、MAIN 回复、所有 tool call/result。`send_to_agent` 是 MAIN 对固定角色的委派；`report_workflow` 是 subagent 返回的结构化完成/阻塞结果。
- **Trajectory 标签页**：逐 turn/step 的事件账本；可检查请求路由、输入/输出、时长、token usage、工具调用和结果。这是检查 agent 工作轨迹的首选页面。
- **模型选择器**：确认 MAIN 路由为 `openai-codex / gpt-5.6-luna`。已开始的 session 保留其已记录的路由。
- **子 agent 面包屑/会话**：subagent 是持久的 continuable child sessions；可查看各角色对话。它们保持角色权限，不能获得 MAIN 的任意写入权。
- **工具卡片**：检查 `bash`、`send_to_agent`、`report_workflow` 的参数与结果。REPORT 通过 bash 按 `latex-compile` / `typst-compile` skill 编译。
- **报告任务状态**：`autoreport/*` 事件与 `send_to_agent` / `report_workflow` 结果给出 task、revision、waiting/completed/blocked/timeout 状态；不要以 UI todo 取代该工作流状态。

## 5. 持久化日志、产物和最终报告

DSH session 是追加事件日志。每条 MAIN/child session 都记录：

- `request/header` 与 `request/context`：实际 provider/model 和请求工具集合；
- `assistant/message`：对话内容和可用 token usage；
- `tool/call` / `tool/result`：工具参数、结果及错误；
- `user/message`：用户输入、subagent `report_workflow`（`source.kind = subagent-report`）、以及 turn-stopping 二次启动（`source.plugin = autoreportdsh/turn-guard`，`summary` 为用户可读的 AutoReport resumed 文案）；
- `autoreport/workflow`、`autoreport/task`、`autoreport/delegation`、`autoreport/role-binding`、`autoreport/artifact`、`autoreport/file-note`、`autoreport/role-note`：AutoReport 的 durable 状态。

不要另写一套 debug log。导出或打开原始 session 文件即可定位委派、报告、产物和为何 turn 被再次拉起。

Web 的历史页、Chat 与 Trajectory 都从这些事件投影。会话导出功能可导出原始 session log，适合离线审计。

Agent-facing manifest 由 session 中的 artifact、file-note 和 role-note 事件即时投影，不另写旁路 JSON；它保留原始 AutoReport 的 `agent_type`、`files`、`description_updated_at`、`file_updated_at` 和 role-level `notes` 字段，时间以 ISO 8601 UTC 字符串呈现。最终交付仍在工作区：

```text
~/Develop/CV/Report/main.typ
~/Develop/CV/Report/main.pdf
```

以及其所依赖的 `Theory/`、`Data/Processed/`、`Plots/Fig/` 内容。

## 6. 验收提示词与检查点

可向 MAIN 发送：

```text
审阅 ~/Develop/CV 的实验文件，使用 Typst 生成完整实验报告。先创建工作流任务，再按依赖委派 THEORY、DATA_ANALYSIS、PLOTTING 和 REPORT；使用现有 Report 模板；最终编译并报告所有产物和任何 blocker。
```

验收时检查：

1. MAIN 和 child 的 `request/context` 都为 `openai-codex / gpt-5.6-luna`；
2. 四个 subagent 都有可追踪的 delegation revision 与结构化 `report_workflow` 结论；
3. 每个角色只写自己的目录；
4. `Report/main.pdf` 存在且 Typst 编译无失败；
5. 各 subagent 的 `manifest` 与最终文件对应，且对话/Trajectory 中无未处理 blocker。

## 7. OpenCLI 浏览器可见性结论

已执行 `opencli doctor`。本机 daemon 与 Chrome Browser Bridge extension 均已连接，因此 **可以** 用 OpenCLI 读取 DSH 页面状态、DOM、网络与截图；完整测试前必须对运行中的 `http://127.0.0.1:3081` 再做一次实际检查。可使用：

```sh
opencli doctor
opencli browser autoreport bind
opencli browser autoreport state
opencli browser autoreport screenshot /tmp/autoreportdsh.png
```

自动化检查应将截图写入 `/tmp/`，并以 DSH 的 session log、导出 ZIP 与 `manifest` 工具结果作为可审计的权威记录；OpenCLI 页面快照仅用于验证 UI 投影。

## 8. 本次实测结果（2026-08-27）

- `pnpm test` 通过：33 个 test files、190 个 tests；唯一跳过项是未配置 `OPENROUTER_API_KEY` 的显式 opt-in e2e。
- OpenCLI `doctor` 为绿色，实际打开 `http://127.0.0.1:3081` 后成功读取 DOM 状态并写出截图至 `/tmp/autoreportdsh-cv-before-final.png`。因此本机确实能查看 DSH 页面状态和截图。
- MAIN 实际 `request/header` 为 `openai-codex / gpt-5.6-luna / xhigh`。THEORY child 实际请求为同一 provider/model，证明 MAIN 与 subagent 的 provider/model 双层路由可用。
- 完整流水线**未验收通过**：THEORY 开始后，Codex OAuth 返回 `The usage limit has been reached`；`Report/main.pdf` 未生成，PLOTTING、REPORT 与 manifest 也未完成。不可把这次运行称为报告生成成功。
- 测试中发现并修复两个本地运行时问题：child setup 中访问未注入的 `skills` 服务，以及 `send_to_agent(wait: true)` 忽略已持久化 inbox report、导致等待超时。对应回归测试已加入。
- API 测试脚本现在遇到非 `completed` 的 `turn/end` 会以非零状态失败，避免 quota 或 transport 错误被误报为成功。

## 9. 已知限制

- DSH Web 启动命令来自 harness checkout：`pnpm dsh ...`，系统 PATH 中无需存在独立 `dsh` 二进制。
- AutoReport subagent 默认禁止网络；MAIN 的 provider 请求仍由 DSH host 发出。因此 MinerU 的联网提取在本次 THEORY 任务中被正确拒绝，child 改用项目已有的本地提取留档并记录该限制。
- 角色写权限由 DSH sandbox 的 per-role writable root 强制；本次 macOS 测试应确认 bash 不能跨角色写。
- AutoReport 支持 MAIN 与 subagent 两级**provider/model 独立路由**：MAIN 使用 DSH 的 session model，`specialistModel` 可为四个 subagent 指定另一条固定 route，或省略/设为 `{ "inheritMain": true }` 继承 MAIN。实测中 `specialistModel.reasoningEffort: xhigh` 没有写入 child 的首个 `request/header`（记录为 `medium`）；这是 Web model-selection hook 的顺序缺陷，尚未修复，不能宣称 subagent effort 已生效。
