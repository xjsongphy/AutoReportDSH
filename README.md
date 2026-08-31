<div align="center">

<img src="assets/title.svg" alt="AutoReportDSH" width="100%" />

### A fixed-team physics-experiment report workflow for DeepSeek Harness

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#)
[![Node](https://img.shields.io/badge/node-22.19%2B-339933.svg)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-3366cc.svg)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.zh.md)

</div>

A **fixed-team report workflow** for automatically writing physics-experiment
reports in LaTeX or Typst on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It migrates the report-domain behavior of [AutoReportCLI](../autoreportcli) into a
`dsh` plugin — no second harness, no provider layer, no extra agent loop.
DSH is the runtime; the experiment folder is the project; select **`autoreport`**
to enter the workflow.

Developer preview: install from source. An npm / `dsh plugin add` release is
planned but **not published**.

## Overview

AutoReportDSH keeps AutoReportCLI’s five-role report pipeline, but runs it
inside DSH. You open an experiment folder, choose the `autoreport` preset, and
coordinate Main, Theory, Data Analysis, Plotting, and Report through ordinary
DSH sessions. Stock `standard` sessions stay stock DSH.

## Features

### Core capabilities
- **Multi-agent collaboration** — Main, Theory, Data Analysis, Plotting, and Report share one experiment, with separate responsibilities and write boundaries
- **Project-oriented workspace** — the current folder is the experiment; `/report-init` or the first MAIN turn creates the standard layout without overwriting user files
- **LaTeX and Typst reports** — language selection, bundled templates/themes, bibliography assets, compile skills, and Python-based analysis and plotting
- **DSH providers** — uses the model routes already configured in DSH; AutoReportDSH does not ship its own credentials or provider list
- **Resource synchronization** — on plugin start, listed remotes refresh into `$DSH_HOME/autoreport/resources`; `pnpm run sync:resources` does the same without booting DSH
- **Task and artifact tracking** — `send_to_agent` records durable tasks and revisions; artifact events record observed changes; agents use `manifest` for cross-agent file descriptions and role notes, then finish with `report_workflow`
- **Safe execution** — DSH `workspace-write` pins each role to its writable root; AutoReport sessions cannot escalate via `sandbox_permissions`; network is allowed
- **Built-in defaults** — bundled personas, templates, and skills so a fresh workspace can run immediately

### Workflow
- **Opt-in preset** — only a top-level `autoreport` session joins the runtime; overlay load does not change ordinary DSH sessions
- **Small model surface** — MAIN adds `send_to_agent` and `manifest` (plus DSH `ask_user_question`); subagents add `manifest` and `report_workflow`; everything else is DSH `read` / `write` / `edit` / `bash` / `skill`
- **Continuable subagents** — children keep role context across follow-ups; a direct human chat with a subagent is ordinary conversation, not a workflow task
- **Role-scoped skills** — MAIN gets `pdf-reference-reader`; REPORT gets `experiment-report-writer` plus `latex-compile` or `typst-compile`; experiment `References/skills` is a cwd-sensitive DSH skill root
- **Settings and live model** — language, wait timeout, and Python live under **Settings → Plugins → Plugin configuration**; switch a running subagent’s model in the conversation window
- **Python environments** — AutoReport-managed venv created with `uv` only when you select it (`$DSH_HOME/autoreport/venv`, numpy/scipy/pandas/matplotlib); a detected local interpreter; or a custom path. Unused managed env occupies no disk; delete that directory to reclaim space. Owned bash sees `DSH_AUTOREPORT_PYTHON` and a PATH prefix so bare `python3` hits that interpreter

## Quick Start

**Prerequisites:** Node.js 22.19+ or 24+, Corepack pnpm, and a sibling
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout at
the pin in [docs/dependencies.md](docs/dependencies.md). Until DSH ships
`Session.append(..., { ignorable: true })` and per-session
`sandbox/workspace-root`, apply the two patches in `patches/` (the same ones CI
uses). A global `dsh` on PATH is not a substitute for that patched checkout.

```bash
cd /path/to/your/development-directory
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
git clone https://github.com/xjsongphy/AutoReportDSH.git AutoReportDSH

cd deepseek-harness
git checkout <DSH_REF from docs/dependencies.md>
git apply ../AutoReportDSH/patches/deepseek-harness-ignorable-append.patch
git apply ../AutoReportDSH/patches/deepseek-harness-sandbox-workspace-root.patch
corepack enable && pnpm install && pnpm run build

cd ../AutoReportDSH
pnpm install && pnpm test && pnpm run build
pnpm run install:preset
```

`pnpm run install:preset` writes `$DSH_HOME/.agent-presets/autoreport/`, links
the package for the web settings card, and generates
`cordis.overlay.generated.yml`. Plain `dsh web` does not load AutoReport; pass
`--patch` every boot until a published profile owns the overlay.

```bash
cd ../deepseek-harness
pnpm dsh web --port 3081 --patch ../AutoReportDSH/cordis.overlay.generated.yml
```

Open `http://127.0.0.1:3081`, create a session, select **`autoreport`**, and
point it at an experiment folder. Use another port if `3080` is already taken.

```bash
pnpm dsh headless \
  --patch ../AutoReportDSH/cordis.overlay.generated.yml \
  "Create an outline for this experiment workspace"
```

For an isolated DSH home: `DSH_HOME=/tmp/autoreport-dsh-home pnpm run install:preset -- --home "$DSH_HOME"`.

## Configuration

DSH owns providers, credentials, and the Main model route. AutoReportDSH only
snapshots report-workflow policy when a workflow starts:

```text
project settings     <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH user settings    namespace: autoreport
        ↓
composition defaults
        ↓
schema defaults
```

Changing settings later does not alter an in-flight report.

- **Settings card** — `defaultReportLanguage`, `delegationWaitTimeoutMs`, and `pythonExecutable` under **Settings → Plugins → Plugin configuration**
- **Subagent model** — new subagents inherit Main unless `specialistModel` is set in cordis or project settings; switch a running subagent from the conversation window (`session.models` / `selectModel`)
- **Python** — managed (`__managed__` → `$DSH_HOME/autoreport/venv`, created on save with `uv venv` then `uv pip install numpy scipy pandas matplotlib`; not created until selected; delete the directory to reclaim space), local (conda / virtualenv / pyenv / PATH, including `~/.autoreport/venv` if present; packages are not auto-installed), or a custom absolute path
- **`/report-init [--language latex|typst]`** — idempotent workspace init; LaTeX and Typst files may coexist; the project setting chooses the active language. The command is host-global; non-AutoReport sessions are rejected before any file change

## Workspace Layout

```text
.
├── Data/            raw data (Data/Raw) and processed results (Data/Processed)
├── References/      papers, images, templates, custom skills
├── Theory/          theory agent output
├── Plots/           figures (Plots/Fig) and scripts (Plots/Scripts)
├── Report/          active LaTeX/Typst sources and compiled PDF
└── Outline/         main-agent planning output
```

Program state stays out of the experiment folder (`$DSH_HOME` defaults to `~/.dsh`):

```text
$DSH_HOME/
├── .agent-presets/autoreport/     installed user preset
├── profiles/node_modules/autoreportdsh
└── autoreport/
    ├── resources/                 synced templates, themes, skills
    ├── venv/                      AutoReport-managed Python (optional)
    └── <workspaceId>/
        ├── project.json           language, python, subagent route
```

## Development

```text
AutoReportDSH/
├── cordis.template.yml    host + report-router overlay
├── patches/               sibling Harness API patches
├── presets/autoreport/    user preset (id = directory name)
├── resources/             bundled personas, skills, LaTeX templates
├── scripts/               preset install, resource sync, client build
├── src/
│   ├── host.ts · preset.ts · runtime.ts · client/
│   ├── workflow/ · tools/ · policy/ · workspace/ · artifacts/
│   └── python-detect.ts · python-env.ts · settings.ts
└── tests/                 unit, integration, client/, eval/, e2e/
```

```bash
pnpm test
pnpm run build
```

`tests/eval/workflow-eval.test.ts` covers the assembled workflow traces (LaTeX/Typst
pipelines, blocked recovery, forgotten `report_workflow`, cold rebind, artifact
`modified`, Python snapshot, coexistence). The live-provider smoke is opt-in:

```bash
export AUTOREPORT_LIVE_TEST=1
export AUTOREPORT_E2E_DSH_HOME="/path/to/configured/dsh-home"
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

See [docs/live-provider-testing.md](docs/live-provider-testing.md). The test
never declares a provider or API key.

CI (`.github/workflows/ci.yml`) runs on Linux, macOS, and Windows: checkout the
Harness pin, apply `patches/`, then install, keyless tests, typecheck, and
build. Live role-writable-root bash (allowed path succeeds, sibling role path
denied) runs on Linux and macOS. Windows CI checks that DSH’s ACL runner is
usable; it does not yet drive an AutoReport role through the Windows shell.

Design and implementation notes: **[PLAN.md](PLAN.md)**. Dependency pin:
**[docs/dependencies.md](docs/dependencies.md)**.
