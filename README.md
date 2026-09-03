<div align="center">

<img src="assets/title.svg" alt="AutoReportDSH" width="100%" />

### A fixed-team physics-experiment report workflow for DeepSeek Harness

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#)
[![Node](https://img.shields.io/badge/node-22.19%2B-339933.svg)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-3366cc.svg)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.zh.md)

</div>

An automated physics-experiment report writing system built on multi-agent
collaboration, running as a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
plugin. You provide the measured data and reference material; a fixed five-role
team — Main, Theory, Data Analysis, Plotting, Report — derives the theory,
analyzes the data, draws the figures, and compiles the LaTeX or Typst report.
The workflow ports the report pipeline of
[AutoReportCLI](https://github.com/xjsongphy/AutoreportCLI) onto DSH.

## Features

### Core capabilities
- **Multi-agent collaboration** — Main plans and coordinates; Theory, Data Analysis, Plotting, and Report carry out the specialized work
- **Directory permission isolation** — every role is pinned to its own writable root by DSH's `workspace-write` sandbox (table below)
- **LaTeX and Typst reports** — per-project language with bundled templates, themes, bibliography assets, and compile skills; Python for data processing and plotting
- **Your DSH providers** — model routes and credentials come from DSH's own configuration
- **Kept-current resources** — templates, themes, and skills refresh from their remotes each time the plugin starts; `pnpm run sync:resources` triggers the same refresh by hand
- **Everything bundled** — personas, templates, and skills ship with the plugin, so a fresh workspace runs immediately

### Workflow
- **Auto-initialized workspace** — Main's first turn initializes the workspace once; `/init` is available for explicit repair or language selection
- **Task and artifact tracking** — Main delegates through `send_to_agent`; specialists describe their outputs in a shared `manifest`, so the next role finds them without being told; each task ends with a declared completion
- **Continuable specialists** — every specialist keeps its role context across follow-up tasks; chatting with one directly stays an ordinary conversation
- **Stock DSH elsewhere** — a session started without the `autoreport` preset behaves exactly like DSH without this plugin

## Quick Start

**Prerequisites:** Node 22.19+. DSH itself is fetched on demand through
`npx @deepseek-ai/dsh`.

### Install from npm

**Install the plugin** — downloads the published package and registers it, with
its `autoreport` preset, in DSH's `web` profile:

```bash
npx @deepseek-ai/dsh plugin --profile web add autoreportdsh
```

**Start DSH** — the Web UI opens at `http://127.0.0.1:3080`:

```bash
npx @deepseek-ai/dsh web
```

**Upgrade an existing installation:**

```bash
npx @deepseek-ai/dsh plugin --profile web update autoreportdsh
```

### Install from source

**Build and install** — builds this checkout, installs the `autoreport` preset
into your DSH home, and registers the plugin in DSH's `web` profile. It uses the
`dsh` on your `PATH`, never modifies DSH itself, and asks before replacing an
existing install:

```bash
pnpm run install:source
```

Pass `--yes` to replace without asking, for non-interactive use:

```bash
pnpm run install:source -- --yes
```

**Start the Web UI** — launches `dsh web` against the installed profile, same
UI, same default address:

```bash
pnpm run start:source
```

**If `dsh` is not on your `PATH` or has a different name**, point both scripts
at it:

```bash
AUTOREPORT_DSH_COMMAND="/path/to/dsh" pnpm run install:source
AUTOREPORT_DSH_COMMAND="/path/to/dsh" pnpm run start:source
```

### Run your first report

1. Open `http://127.0.0.1:3080`, start a session with the **`autoreport`**
   preset, and choose your experiment folder.
2. Run `/init` or describe the experiment in your first message — the first
   turn initializes the standard layout and leaves existing files alone.
   `/init --language typst` selects Typst; LaTeX and Typst files may
   coexist, and the project setting decides the active language.
3. Add measured data and reference material to the folder, then ask Main to
   write the report; the compiled PDF lands in `Report/`.

## Configuration

Providers, credentials, and the Main model route belong to DSH. The plugin reads
its report settings in this order and freezes the result when a workflow starts,
so later changes leave a running report untouched:

```text
project settings     <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH user settings    namespace: autoreport
        ↓
composition defaults
        ↓
schema defaults
```

- **Settings card** — report language, delegation idle timeout, delegation maximum
  wait, and Python interpreter live under **Settings → Plugins → Plugin configuration**.
- **Subagent model** — new specialists inherit Main's model unless
  `specialistModel` is set in cordis or project settings; switch a running
  specialist's model from the conversation window.
- **Python** — pick one of three: a managed environment that the plugin creates
  with `uv` under `$DSH_HOME/autoreport/venv` only when you select it (numpy,
  scipy, pandas, and matplotlib included; delete the directory to reclaim the
  disk), an interpreter already on your machine (conda, virtualenv, pyenv, or
  `PATH`, including `~/.autoreport/venv` when present; packages are not
  auto-installed), or any custom path. Agent shells receive the selection as
  `DSH_AUTOREPORT_PYTHON`; the managed environment is also put on `PATH`, so a
  bare `python3` resolves to it.

## Workspace Layout

The experiment folder keeps everything a report needs:

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

### Role permissions

| Role | Writes | Reads |
|---|---|---|
| Main | `Outline/` | the whole workspace |
| Theory | `Theory/` | the whole workspace |
| Data Analysis | `Data/Processed/` | the whole workspace |
| Plotting | `Plots/` | the whole workspace |
| Report | `Report/` | the whole workspace |

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

| Command | What it does |
|---|---|
| `pnpm test` | runs the unit, integration, client, and eval suites with Vitest |
| `pnpm run typecheck` | typechecks the host and client code without emitting files |
| `pnpm run build` | cleans `dist/`, compiles TypeScript, copies resources, and builds the web client |
| `pnpm run sync:resources` | refreshes managed resources into `$DSH_HOME/autoreport/resources` without starting DSH |
| `pnpm run install:preset` | materializes the `autoreport` user preset and its overlay in the DSH home (the source installer runs it for you) |
| `pnpm run prepare:npm` | builds and assembles the publishable npm bundle under `dist/npm` |

`tests/eval/workflow-eval.test.ts` asserts the assembled workflow traces: the full
LaTeX and Typst pipelines, recovery from a blocked delegation, a specialist that
forgets to declare completion, cold rebinding, artifact `modified` events, the
Python snapshot, and LaTeX/Typst coexistence. The live-provider smoke test runs
against a real DSH installation and is opt-in: set `AUTOREPORT_LIVE_TEST=1`, point
`AUTOREPORT_E2E_DSH_HOME` at a DSH home that already has providers configured, and
run

```bash
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

The test reads the providers from that DSH home and declares none of its own. See
[docs/live-provider-testing.md](docs/live-provider-testing.md).

CI (`.github/workflows/ci.yml`) runs on Linux, macOS, and Windows against the
pinned DSH compatibility checkout. It applies the temporary patches, then runs
install, keyless tests, typecheck, and build. See
[docs/dependencies.md](docs/dependencies.md) for the dependency pin.

Design and implementation notes: **[PLAN.md](PLAN.md)**.

## Credits

- [AutoReport](https://github.com/xjsongphy/AutoReport) — the desktop app this workflow derives from
- [AutoReportCLI](https://github.com/xjsongphy/AutoreportCLI) — the terminal workflow ported here
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — runtime, sessions, and sandbox
