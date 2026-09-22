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
- **Deterministic bundled resources** — templates, themes, skills, and their reference documents are committed in `resources/` and read from there; a session never fetches or replaces a prompt over the network
- **Everything bundled** — personas, templates, and skills ship with the plugin, so a fresh workspace runs immediately

### Workflow
- **Auto-initialized workspace** — Main's first turn initializes the workspace once; `/init` is available for explicit repair or language selection
- **Task and artifact tracking** — Main delegates through `send_to_agent` and maintains durable checklist/status state with `workflow_task`; specialists describe outputs in a shared `manifest`, so the next role finds them without being told
- **Continuable specialists** — every specialist keeps its role context across follow-up tasks; chatting with one directly stays an ordinary conversation
- **Stock DSH elsewhere** — a session started without the `autoreport` preset behaves exactly like DSH without this plugin

## Quick Start

**Prerequisites:** Node 22.19+. DSH itself is fetched on demand through
`npx @deepseek-ai/dsh`.

### Install from npm

**Install the plugin** — downloads the published package and registers it, with
its `autoreport` preset, in DSH's `web` profile:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-autoreport
```

**Start DSH** — the Web UI opens at `http://127.0.0.1:3080`:

```bash
npx @deepseek-ai/dsh web
```

**Upgrade an existing installation:**

```bash
npx @deepseek-ai/dsh plugin --profile web update dsh-autoreport
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
   `/init typst` (or `--language typst`) selects Typst for that workspace and
   switches its templates: an unmodified template of the previous language is
   removed, an edited one is kept, and an existing file is never overwritten.
   Pick each workspace's language under **Plugins → Installed → dsh-autoreport**,
   where both languages list their projects and one control moves a project
   between them.
3. Add measured data and reference material to the folder, then ask Main to
   write the report; the compiled PDF lands in `Report/`.

## Configuration

Providers, credentials, and the Main model route belong to DSH. The plugin reads
its report settings in this order and freezes the result when a workflow starts,
so later changes leave a running report untouched:

```text
workspace language   DSH user settings, namespace autoreport,
                     keyed by workspace root  (authoritative)
        ↓
legacy project settings  <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH user settings    namespace: autoreport (defaults, waits, Python)
        ↓
composition defaults
        ↓
schema defaults
```

- **Settings page** — report language, delegation idle timeout, delegation maximum
  wait, and Python interpreter live on the plugin's own page under
  **Plugins → Installed → dsh-autoreport**. The same page lists each language's
  projects, with one control that moves a project to the other language and
  switches its templates.
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
├── profiles/node_modules/dsh-autoreport
└── autoreport/
    ├── venv/                      AutoReport-managed Python (optional)
    └── <workspaceId>/
        ├── project.json           language, python, subagent route
        └── workflow/<session id>/ session.jsonl — the durable workflow log
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
├── presets/autoreport/    user preset (id = directory name)
├── resources/             bundled personas, guidance, skills, templates
├── scripts/               preset install, resource copy, client build
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
| `pnpm run install:preset` | materializes the `autoreport` user preset and its overlay in the DSH home (the source installer runs it for you) |
| `pnpm run prepare:npm` | builds and assembles the publishable npm bundle under `dist/npm` |

`tests/eval/workflow-eval.test.ts` asserts the assembled workflow traces: the full
LaTeX and Typst pipelines, recovery from a blocked delegation, a specialist that
forgets to declare completion, cold rebinding, artifact `modified` events, the
Python snapshot, and both report languages. The live-provider smoke test runs
against a real DSH installation and is opt-in: set `AUTOREPORT_LIVE_TEST=1`, point
`AUTOREPORT_E2E_DSH_HOME` at a DSH home that already has providers configured, and
run

```bash
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

The test reads the providers from that DSH home and declares none of its own. See
[docs/live-provider-testing.md](docs/live-provider-testing.md).

CI (`.github/workflows/ci.yml`) runs on Linux, macOS, and Windows against the
pinned DSH release, then runs install, keyless tests, typecheck, and build. No
DSH source patch is applied, in CI or at install: the plugin wraps the running
sandbox policy in process instead. See
[docs/dependencies.md](docs/dependencies.md) for the pin and the compatibility
seams.

Design record, including the rejected alternatives and the risk list:
**[PLAN.md](PLAN.md)** — rev 5, amended rev 8, and it says itself which sections
are historical. For what the plugin does **now**, plus the current gates and what
is deliberately still open: **[docs/own-features.md](docs/own-features.md)**.

## Credits

### Projects this workflow derives from

- [AutoReport](https://github.com/xjsongphy/AutoReport) — the desktop app this workflow derives from
- [AutoReportCLI](https://github.com/xjsongphy/AutoreportCLI) — the terminal workflow ported here
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — runtime, sessions, and sandbox

### Vendored documents

Templates, themes, skill documents, and language guidance are committed under
`resources/` and read from there; nothing is fetched or replaced at runtime. So
the attribution lives here rather than in a sync table, and each upstream's own
license file travels with its copy.

| Upstream | License | Contributes |
| --- | --- | --- |
| [lucifer1004/claude-skill-typst](https://github.com/lucifer1004/claude-skill-typst) | MIT | the `typst` skill and its four reference documents (`resources/typst/skills/typst/`) |
| [xjsongphy/pkumpl-typst](https://github.com/xjsongphy/pkumpl-typst) | CC BY-SA 4.0 | the Typst theme, template, and bibliography assets (`resources/typst/`) |
| [CastleStar14654/PKUMpLtX](https://github.com/CastleStar14654/PKUMpLtX) | CC BY-SA 4.0 | `mpltx.cls`, the PKU Modern Physics Laboratory LaTeX class built on `revtex4-2`, which the Typst theme ports |
| [xjsongphy/skills](https://github.com/xjsongphy/skills) | none declared | the `latex-compile` skill, and the `experiment-report-writer` projection whose upstream commit and per-module blob hashes are recorded in its `provenance.json` |
| [citation-style-language/styles](https://github.com/citation-style-language/styles) | CC BY-SA 3.0 | `american-physics-society.csl`, authored by Richard Karnesky |

Where a license file exists upstream, it is committed beside the copy, so the
notice is co-located with the thing it covers. `xjsongphy/skills` declares no
license, so its two vendored documents carry none.

Referenced at runtime rather than vendored:

- [MinerU](https://github.com/opendatalab/MinerU) — the `mineru-open-api` CLI that `pdf-reference-reader` drives to extract `References/` PDFs into `Outline/.cache/mineru/`

## License

[MIT](LICENSE) for this project's own code — the host wiring, tools, policies,
workflow runtime, and tests.

Vendored documents are **not** relicensed by that grant; each keeps its own
license, named in [Credits](#credits) and, where upstream provides one, text
committed beside the copy:

- the rest of `resources/typst/` — CC BY-SA 4.0 ([`LICENSE`](resources/typst/LICENSE)), from `pkumpl-typst`
- `resources/typst/skills/typst/` — MIT ([`LICENSE`](resources/typst/skills/typst/LICENSE)), from `claude-skill-typst`
- `resources/latex/themes/` — CC BY-SA 4.0 ([`LICENSE`](resources/latex/themes/LICENSE)), `mpltx.cls` from PKUMpLtX
- `resources/typst/templates/american-physics-society.csl` — CC BY-SA 3.0, stated in its own `<rights>` element
- `resources/skills/` — vendored from `xjsongphy/skills`, which declares no license

The CC BY-SA documents are share-alike: this repository redistributes them, and
the local edits they carry (retargeted cross-references, removed dead links, a
trimmed index) remain under the same license as the originals.
