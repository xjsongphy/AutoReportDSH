# AutoReportDSH：DSH Web 实测与可观测性指南

本文记录将 `AutoReportDSH` 接入本地 DeepSeek Harness（DSH）时，如何配置模型、观察工作流，以及验证最终实验报告。示例工作区为 `~/Develop/CV`，报告语言为 Typst。

## 1. 已核实的运行架构

- DSH 管理 provider、模型、凭据、会话、子会话、Web UI、工具执行和日志持久化。
- AutoReportDSH 仅管理报告工作流：MAIN 与 THEORY、DATA_ANALYSIS、PLOTTING、REPORT 四个固定 specialist、目录权限、任务/委派状态、报告资源和产物 manifest。
- MAIN 的模型由 DSH 的 `agent-default-model` 决定；每个 specialist 可继承 MAIN，或由 AutoReport 项目设置的 `specialistModel` 另行指定。
- 专项目录外的设置文件为：`$DSH_HOME/autoreport/<workspace-id>/project.json`。`workspace-id` 是工作区绝对路径 SHA-256 的前 16 位，避免把配置或机密写进实验目录。
- 工作流建立时会冻结模型和语言等设置快照；随后修改默认设置不会改变该工作流。

## 2. 本次模型配置

目标路由为：

```yaml
llm-pi-ai:
  providers:
    xmsxb:
      apiKeyEnv: XMSXB_API_KEY
      displayName: 灵妙AI聚合网关
      api: openai-responses
      baseURL: https://zyapi.xmsxb.com/v1
      reasoning: high
      models:
        - id: gpt-5.6-terra
          name: gpt-5.6-terra
          contextWindow: 1050000
          maxTokens: 128000
          input: [text, image]
          reasoningEfforts:
            high: high
agent-default-model:
  provider: xmsxb
  model: gpt-5.6-terra
```

对应的 DSH `autoreport` 用户设置为：

```json
{
  "defaultReportLanguage": "typst",
  "specialistModel": {
    "provider": "xmsxb",
    "model": "gpt-5.6-terra",
    "reasoningEffort": "high"
  }
}
```

`XMSXB_API_KEY` 只能通过 DSH Credentials UI 或启动进程环境提供，绝不写入本仓库、实验目录、日志或本文档。

## 3. 启动与工作区初始化

先构建并安装 preset：

```sh
cd ~/Develop/AutoReportDSH
pnpm run build
DSH_HOME=/tmp/autoreportdsh-cv-home pnpm run install:preset -- --home /tmp/autoreportdsh-cv-home
```

从 sibling harness checkout 启动 Web（`--no-open` 适用于由操作者自行打开页面的测试）：

```sh
cd ~/Develop/deepseek-harness
DSH_HOME=/tmp/autoreportdsh-cv-home \
XMSXB_API_KEY="${XMSXB_API_KEY}" \
pnpm dsh web --patch ../AutoReportDSH/cordis.overlay.generated.yml --port 3081 --no-open
```

打开 `http://127.0.0.1:3081`，创建 session 时选择 `autoreport-main`，工作目录选择 `~/Develop/CV`。第一条请求前可运行：

```text
/report-init --language typst
```

初始化只创建缺失目录和资源；已存在的 `Report/main.typ`、`Report/mplts.typ` 等文件不会覆盖。

## 4. 在页面中观察什么

- **Chat**：用户消息、MAIN 回复、所有 tool call/result。`send_to_agent` 是 MAIN 对固定角色的委派；`report_workflow` 是 specialist 返回的结构化完成/阻塞结果。
- **Trajectory 标签页**：逐 turn/step 的事件账本；可检查请求路由、输入/输出、时长、token usage、工具调用和结果。这是检查 agent 工作轨迹的首选页面。
- **模型选择器**：确认 MAIN 路由为 `xmsxb / gpt-5.6-terra`。已开始的 session 保留其已记录的路由。
- **子 agent 面包屑/会话**：specialist 是持久的 continuable child sessions；可查看各角色对话。它们保持角色权限，不能获得 MAIN 的任意写入权。
- **工具卡片**：检查 `report_exec`、`compile_report`、`send_to_agent`、`report_workflow` 的参数与结果。REPORT 独占 `compile_report`。
- **报告任务状态**：`report_task` 的工具结果和 `autoreport/*` 事件给出 task、revision、waiting/completed/blocked/timeout 状态；不要以 UI todo 取代该工作流状态。

## 5. 持久化日志、产物和最终报告

DSH session 是追加事件日志。每条 MAIN/child session 都记录：

- `request/header` 与 `request/context`：实际 provider/model 和请求工具集合；
- `assistant/message`：对话内容和可用 token usage；
- `tool/call` / `tool/result`：工具参数、结果及错误；
- `autoreport/workflow`、`autoreport/task`、`autoreport/delegation`、`autoreport/role-binding`、`autoreport/artifact`：AutoReport 的 durable 状态。

Web 的历史页、Chat 与 Trajectory 都从这些事件投影。会话导出功能可导出原始 session log，适合离线审计。

AutoReport 产物 manifest 不写入实验目录，而在：

```text
$DSH_HOME/autoreport/<workspace-id>/manifests/
```

它列出每个目录中的 agent 产物、producer role、来源工具、任务 id 和 delegation revision。最终交付仍在工作区：

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

1. MAIN 和 child 的 `request/context` 都为 `xmsxb / gpt-5.6-terra`；
2. 四个 specialist 都有可追踪的 delegation revision 与结构化 `report_workflow` 结论；
3. 每个角色只写自己的目录；
4. `Report/main.pdf` 存在且 Typst 编译无失败；
5. external manifest 与最终文件对应，且对话/Trajectory 中无未处理 blocker。

## 7. OpenCLI 浏览器可见性结论

已执行 `opencli doctor -v`。本机 OpenCLI daemon 正常，但 Chrome Browser Bridge extension 未连接，因此当前 **不能** 用 OpenCLI 读取 DSH 页面状态、DOM、网络、截图或驱动页面。

满足下列条件后，OpenCLI 可用于只读检查和截图：

```sh
opencli doctor
opencli browser autoreport bind
opencli browser autoreport state
opencli browser autoreport screenshot /tmp/autoreportdsh.png
```

在 doctor 变绿前，应直接使用浏览器页面和 DSH 的 session 日志/manifest；不要声称已经通过 OpenCLI 查看了页面或截图。

## 8. 已知限制

- DSH Web 启动命令来自 harness checkout：`pnpm dsh ...`，系统 PATH 中无需存在独立 `dsh` 二进制。
- AutoReport specialist 默认禁止网络；MAIN 的 provider 请求仍由 DSH host 发出。
- Windows 的 specialist 隔离故意 fail closed；本次 macOS 测试不受此限制。
- AutoReport 当前支持 MAIN 与 specialist 两级**独立模型路由选择**；specialist 的 `reasoningEffort` 通过 DSH agent-scoped model-selection seam 写入实际 child 请求并记录在 request header。
