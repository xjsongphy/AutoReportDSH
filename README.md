<p align="center">
  <img src="assets/title.svg" alt="AutoReportDSH — Physics experiment reports on DeepSeek Harness" width="100%" />
</p>

<p align="center">
  A fixed-team physics-experiment report workflow for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-3f7ecb?style=flat-square" alt="Supported platforms: macOS and Linux" />
  <img src="https://img.shields.io/badge/runtime-Node%2022.19%2B-339933?style=flat-square" alt="Node.js 22.19 or later" />
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-3366cc?style=flat-square" alt="DeepSeek Harness plugin" />
  <img src="https://img.shields.io/badge/report-LaTeX%20%7C%20Typst-7560c8?style=flat-square" alt="LaTeX and Typst reports" />
  <img src="https://img.shields.io/badge/status-developer%20preview-f2a900?style=flat-square" alt="Developer preview" />
</p>

<p align="center">
  English | <a href="README.zh.md">中文</a>
</p>

> **Developer preview.** AutoReportDSH is source-installable and fully covered by keyless integration tests. The npm/DSH-bundle release flow described below is planned but **not published yet**.

AutoReportDSH migrates the report-domain behavior of [AutoReportCLI](../autoreportcli) into a DeepSeek Harness (`dsh`) plugin. DSH owns the generic runtime—agent loop, sessions, compaction, providers, tools, subprocess lifecycle, approvals, sandbox, and UI. AutoReportDSH owns the report workflow—fixed roles, durable delegation state, role writable roots, resources, compilation skills, and artifacts.

The detailed design and implementation record live in [PLAN.md](PLAN.md).

## What it does

Selecting the opt-in **`autoreport-main`** agent preset enables one fixed team:

| Role | Responsibility | Writable location |
|---|---|---|
| MAIN | Scope audit, dependency tracking, delegation, user-facing progress | `Outline/` |
| THEORY | Derivations, assumptions, reusable formulas | `Theory/` |
| DATA_ANALYSIS | Process raw measurements and quantitative results | `Data/Processed/` |
| PLOTTING | Plot scripts and figures | `Plots/` |
| REPORT | LaTeX/Typst sources and report compilation | `Report/` |

The model uses DSH-native `read` / `write` / `edit` / `bash` / `skill` primitives (search via `rg`/`find` in bash). AutoReport-specific MAIN tools are deliberately small:

```text
send_to_agent     fixed-role delegation with durable task/revision tracking
ask_user_question DSH-native structured questions for requirement gaps
```

Specialist children are DSH continuable sessions. They keep role context across follow-ups and report structured outcomes through `report_workflow`. A direct human conversation with a specialist remains ordinary conversation; it does not create or complete a workflow task without an active delegation context.

AutoReport-owned skills are role-scoped: MAIN receives `pdf-reference-reader` (MinerU / mineru-open-api) for References PDF extraction into `Outline/.cache/mineru/`; REPORT receives `experiment-report-writer` plus the active language compile skill (`latex-compile` or `typst-compile`) through progressive disclosure; THEORY, DATA_ANALYSIS, and PLOTTING receive none of these domain skills. Experiment `References/skills` is a cwd-sensitive DSH skill root. DSH user/project skills retain their normal DSH visibility.

## Coexistence with normal DSH

Installing the overlay does **not** convert every DSH session into AutoReport:

```text
standard           normal DSH behavior
autoreport-main    AutoReport physics-report workflow
```

Only a top-level session whose effective preset is `autoreport-main` enters the AutoReport runtime. Ordinary sessions retain their stock shell, filesystem behavior, child-report tool, and workspace. This is covered by the integration suite.

## Run from source

This is the currently supported installation method. The two repositories must be sibling directories because the development package links the local harness checkout.

### Prerequisites

- Node.js `22.19+` or `24+`
- Corepack-enabled pnpm
- A local DeepSeek Harness checkout compatible with the version pinned in [docs/dependencies.md](docs/dependencies.md)
- DSH-native bash and workspace-write sandbox (macOS Seatbelt, Linux bwrap/Landlock, Windows ACL)

### 1. Check out and build DeepSeek Harness

```sh
cd /path/to/your/development-directory

git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
# Clone or enter this repository as the sibling directory AutoReportDSH.

cd deepseek-harness
corepack enable
pnpm install
pnpm run build
```

> AutoReportDSH currently requires the DSH `Session.append(type, data, { ignorable: true })` writer API. Use the compatible local checkout described in [docs/dependencies.md](docs/dependencies.md) until that API is included in the DSH release range used by the published plugin.

### 2. Install, test, and build AutoReportDSH

```sh
cd ../AutoReportDSH

pnpm install
pnpm test
pnpm run build
```

The keyless suite validates workflow persistence, preset membership, role writable roots, report resources, artifact manifests, and real Loader boot behavior.

### Refresh externally maintained skills

Runtime sessions never fetch resources. To refresh the externally maintained MinerU skill explicitly, run:

```sh
pnpm run sync:resources
```

The script queries the upstream Git tree and records commit/blob state in `resources/.sync-state.json`. It downloads only a managed file whose blob changed (or whose local copy is missing); unchanged files are not fetched again. The current managed set is `xjsongphy/skills:mineru/SKILL.md` → `resources/skills/mineru.md`.

### 3. Install the AutoReport preset

```sh
pnpm run install:preset
```

This writes the rendered user preset to:

```text
$DSH_HOME/.agent-presets/autoreport-main/
```

links the package at `$DSH_HOME/profiles/node_modules/autoreportdsh` so the web client can load the settings card, and writes `cordis.overlay.generated.yml` in this repository. The installer is idempotent: it updates AutoReport-owned preset files and keeps unrelated files under the user preset directory.

For an isolated harness home:

```sh
DSH_HOME=/tmp/autoreport-dsh-home \
  pnpm run install:preset -- --home "$DSH_HOME"
```

### 4. Start the local harness with the overlay

```sh
cd ../deepseek-harness

pnpm dsh web \
  --port 3081 \
  --patch ../AutoReportDSH/cordis.overlay.generated.yml
```

Open `http://127.0.0.1:3081`, create a session, and select **`autoreport-main`**. Report-workflow defaults are under **Settings → Plugins → Plugin configuration → AutoReport**. Use another port when an existing DSH Web server already occupies the default `3080`.

For a one-shot harness profile:

```sh
pnpm dsh headless \
  --patch ../AutoReportDSH/cordis.overlay.generated.yml \
  "Create an outline for this experiment workspace"
```

## First report workflow

After selecting `autoreport-main`, initialize the workspace explicitly or let the first admitted MAIN workflow turn initialize it idempotently:

```text
/report-init
/report-init --language latex
/report-init --language typst
```

`/report-init` creates the required directories and materializes only missing resources. It never overwrites user files. LaTeX and Typst sources may coexist; the project setting chooses the active report language.

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

A typical MAIN request is then simply:

```text
Review the experiment files, create the report tasks, and produce a first report draft.
```

MAIN delegates bounded work through `send_to_agent`; specialists read the shared workspace and report their durable outcome back to MAIN.

## Configuration

DSH owns all model/provider and credential configuration; AutoReportDSH only uses the model routes configured in DSH and does not maintain its own provider system.

AutoReportDSH owns report-workflow settings. A new workflow snapshots its values in this order:

```text
project settings     <dshHome>/autoreport/<workspaceId>/project.json
        ↓
DSH user settings    namespace: autoreport
        ↓
composition defaults
        ↓
schema defaults
```

The resolved snapshot is committed to the durable `autoreport/workflow` event. Changing settings later does not change an in-flight report. The resolver retains an internal workflow-override seam for future structured commands, but v1 intentionally has no user-facing override.

Current composition defaults include:

```text
defaultReportLanguage   latex
specialistModel         inherit Main (optional shared DSH route selection)
delegationWaitTimeoutMs 600000
pythonExecutable        optional interpreter for specialist bash
```

The `autoreport` user-settings namespace is registered through `@deepseek-ai/dsh-settings`; it persists and validates `defaultReportLanguage`, `specialistModel`, `delegationWaitTimeoutMs`, and optional `pythonExecutable`. The web settings card lives under **Settings → Plugins → Plugin configuration**. Changing those values does not alter a report that is already running. `specialistModel.reasoningEffort`, when present, is applied through DSH's agent-scoped model-selection seam rather than merely recorded.

## Security model

Role boundaries are runtime-enforced, not persona-only guidance:

- Every role keeps the experiment root as its navigation cwd.
- DSH `workspace-write` sandbox pins each role to its writable root (`Outline/`, `Theory/`, `Data/Processed/`, `Plots/`, `Report/`).
- All five roles use DSH-native `bash`. Network access is allowed; writable-root isolation is independent of network policy.
- AutoReport sessions cannot escalate via `sandbox_permissions`.
- MAIN may inspect PDFs (MinerU via the `pdf-reference-reader` skill and bash) but cannot write outside `Outline/`.
- Specialists compile and run Python through bash and skills, not dedicated model tools.
- A specialist's direct human follow-up has the same file permissions as its workflow task.

## Tests

```sh
pnpm test
pnpm run build
```

The live-provider smoke is intentionally opt-in and uses the default model route already configured in DSH:

```sh
export AUTOREPORT_LIVE_TEST=1
export AUTOREPORT_E2E_DSH_HOME="/path/to/configured/dsh-home"
pnpm vitest run tests/e2e/configured-route.e2e.test.ts
```

See [docs/live-provider-testing.md](docs/live-provider-testing.md). The test never declares a provider, model, endpoint, or API key; DSH selects the same route as the chosen deployment profile.

### GitHub Actions CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pull requests and `main` pushes on Linux and macOS. Because this preview package intentionally links a sibling Harness checkout, CI checks out the exact Harness pin from [docs/dependencies.md](docs/dependencies.md), builds it, then runs immutable install, keyless tests, typecheck, and build. The real API test remains opt-in and receives no credential in this workflow.

## Planned npm / DSH bundle release

The following commands are the intended **future** release workflow. They are not available until AutoReportDSH is published as an npm DSH bundle and its required DSH append API is released:

```sh
# Planned: install the published bundle into the normal web profile.
npx @deepseek-ai/dsh plugin --profile web add @xjsongphy/autoreportdsh

# Planned: render the user preset from the package installed in that profile.
npx @xjsongphy/autoreportdsh setup --profile web

# Start DSH normally; choose autoreport-main when needed.
npx @deepseek-ai/dsh web
```

The published package will ship prebuilt `dist/` files, a DSH bundle manifest, host/router patch rows, and a setup executable. It will use versioned DSH peer dependencies rather than the local `link:` dependencies used during source development. Git installation may also be supported through `dsh plugin add github:…`, subject to pnpm's explicit build-script allowlist.

## Repository layout

```text
assets/title.svg            README title banner
cordis.template.yml         source for the generated host/router overlay
presets/autoreport-main/    rendered user-preset template
resources/                  bundled report assets and preset-scoped skills
scripts/install-user-preset.ts
src/
├── host.ts                 host runtime, membership gate, guard, /report-init
├── preset.ts               one preset-plane AutoReport contribution
├── client/                 web settings card (Plugins → Plugin configuration)
├── runtime.ts              workflow state, artifacts, manifests, settings snapshot
├── workflow/               events, projections, registry, waiters, report observer
├── tools/                  send_to_agent, report_workflow
├── policy/                 role guard and per-role DSH sandbox roots
├── python-env.ts           DSH_AUTOREPORT_PYTHON shell-env facts
├── workspace/              directories, resources, command, skill loader
├── artifacts/              filtering, observation, external manifest projection
└── settings.ts             project/user/default settings resolution
docs/                       dependency and live-provider test notes
tests/                      unit, integration, boot, and opt-in real-API tests
```

## Current limitations

- Windows live bash confinement uses DSH's windows-acl runner. GitHub `windows-latest` fails the job when that runner or Git Bash is unavailable.
- MinerU runs through MAIN bash and the `pdf-reference-reader` skill (`Outline/.cache/mineru/`); there is no dedicated MinerU model tool.
- Artifact manifests are runtime-generated; agents cannot add free-form manifest notes.
- Task lifecycle is internal: MAIN dispatches with `send_to_agent` (auto-creating tasks when `task_id` is omitted); specialists finish through `report_workflow` and the report observer settles durable state.
- The role guard still checks write/edit paths as defense in depth; `delete` and `apply_patch` are not mounted by this preset.

## License

The repository license and third-party asset notices will be included before the npm release. Until then, inspect the copied asset provenance in this repository and the upstream projects cited above.
