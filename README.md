# AutoReportDSH

Physics-experiment report workflow (AutoReportCLI) as a **DeepSeek Harness (`dsh`) plugin**.

DeepSeek Harness owns runtime mechanics — agent loops, continuable child sessions,
persistence, compaction, provider routing, tool pipeline, subprocess lifecycle. AutoReportDSH
owns report semantics and policy — fixed roles, role binding, task/delegation state, structured
child reports, role authorization, execution isolation, workspace initialization, artifact
semantics, manifest projection, templates, compilation, domain skills. The full architecture
lives in [PLAN.md](PLAN.md).

## Status: integration-e2e (final phase)

All PLAN.md §4 phases are implemented and merged: workflow state machine,
role registry + waiters, `send_to_agent` / `report_workflow` / `report_task`,
the global report router replacing the stock child-report setup, the role
mutation guard with seatbelt/bwrap isolation, `report_exec` / `compile_report`,
workspace init + `/report-init` + bundled assets, settings layering with
durable snapshots, personas + the Main preset, artifact observation with
external manifest projection, assembled keyless integration smokes, an
installer boot smoke, and a self-skipping OpenRouter real-API e2e.

## Quickstart

Prerequisites: Node 22.19+/24+, Corepack-enabled pnpm (`corepack enable`), and a local
checkout of `deepseek-harness` as a sibling directory (`../deepseek-harness`), built once
(`cd ../deepseek-harness && pnpm install && pnpm run build`). Windows is **unsupported**:
specialist process execution fails closed until network-denial isolation is verified there
(PLAN.md §2.9).

```sh
pnpm install                 # links harness packages from ../deepseek-harness
pnpm test                    # vitest unit tests + keyless integration smokes (e2e self-skips)
pnpm run build               # tsc -> dist/ (required by the installer)
pnpm install:preset          # preset -> $DSH_HOME/.agent-presets/autoreport-main
                             # + renders ./cordis.overlay.generated.yml

# from the deepseek-harness checkout — pick one profile:
pnpm dsh web --patch /path/to/AutoReportDSH/cordis.overlay.generated.yml
pnpm dsh headless --patch /path/to/AutoReportDSH/cordis.overlay.generated.yml
```

Then select the **`autoreport-main`** preset for your session (preset picker in web;
`--profile`/preset flags for headless). The overlay replaces DSH's stock child-report row
with the AutoReport router, so specialists report through `report_workflow` while ordinary
DSH children keep stock reporting. The first admitted Main turn initializes the experiment
workspace idempotently; `/report-init [--language latex|typst]` is the explicit repair path.

For provider setup against OpenRouter (`stealth/ox-alpha`), see
[docs/openrouter-testing.md](docs/openrouter-testing.md); the automated e2e lives at
`tests/e2e/openrouter.e2e.test.ts` and self-skips unless `OPENROUTER_API_KEY` is set.

`install:preset` accepts `--home <path>` (harness home override), `--repo-root <path>`, and
`--entry <path>` for testing. It never deletes foreign files under the preset root and fails
loud if the built entry is missing.

## Configuration

AutoReportDSH owns ONLY report-workflow policy. DeepSeek Harness keeps providers,
credentials, Main model selection, compaction, approvals, sandbox/shell, session lifecycle,
and UI preferences. Policy layers resolve per field, highest first
(PLAN.md §2.14):

```text
explicit workflow override
        ↓
project settings        <dshHome>/autoreport/<workspaceId>/project.json  (external,
                          never inside the experiment workspace; `<workspaceId>`
                          is a sha256-derived key of the absolute workspace root)
        ↓
AutoReport user settings (settings namespace 'autoreport')
        ↓
Cordis composition Config (plugin defaults)
        ↓
schema defaults         latex / latexmk / inherit-Main / ambient PATH / 600000 ms
```

Plugin `Config` fields are DEFAULTS, not live workflow inputs:
`defaultReportLanguage`, `defaultLatexEngine`, `specialistModel`
(`{ provider, model, reasoningEffort? }`; absent inherits the Main route),
`defaultPythonEnv`, plus `executionTimeoutMs` and `workspaceRoot`. When a
workflow starts, `resolveWorkflowSettings()` freezes the effective values into a
`WorkflowSettingsSnapshot` committed once on the durable `autoreport/workflow`
event; execution reads that snapshot, so later settings changes never mutate an
in-flight report.

Project settings (`project.json`) are validated JSON written atomically
(temp file + rename) and keyed by workspace id. `/report-init --language
latex|typst` records the explicit language there and materializes only the
missing resources for that backend — it never deletes the other backend's
files, so `Report/main.tex` and `Report/main.typ` may coexist while
`reportLanguage` stays authoritative.

The user layer rides DSH's settings service (namespace `'autoreport'`). This is the one
**deferred** piece: it needs `@deepseek-ai/dsh-settings` to be linked as an out-of-tree
dependency (the in-tree registration API exists — `installSettingsSection` — but the package
is not yet exposed to this plugin). Until then the user layer is absent; project settings,
composition defaults, and schema defaults already resolve normally.

## Repo layout

```text
package.json               link: dependencies into the local harness checkout
cordis.template.yml        patch-overlay source (renders cordis.overlay.generated.yml)
presets/autoreport-main/   Main agent-preset composition (rendered by the installer)
scripts/install-user-preset.ts
src/index.ts               host-plane plugin entry (host + router rows in the overlay)
src/host.ts                host-plane apply(): runtime service, role guard, /report-init,
                           artifact observation, manifest projection
src/runtime.ts             AutoReportWorkflowRuntime service (state, waiters, artifacts)
src/workflow/              events/projections, role registry, waiters, report observer
src/tools/                 send_to_agent, report_task, report router, report_workflow,
                           report_exec, compile_report
src/policy/                mutation guard + seatbelt/bwrap isolation backends
src/workspace/             init.ts (layout + materializer), command.ts (/report-init), skill-loader.ts
src/artifacts/             artifact policy, session-log observer, external manifest projection
src/settings.ts            settings layering + durable workflow-settings snapshots
resources/                 bundled assets copied from ../autoreportcli/templates (see table below)
docs/                      dependencies.md, openrouter-testing.md
tests/                     vitest unit tests, integration smokes, self-skipping e2e
```

## Bundled resources

All files are copied verbatim from `../autoreportcli/templates/` with license headers kept;
`materializeResources()` installs them create-missing-only and never overwrites user files.

| Path | Source | Role |
|---|---|---|
| `resources/latex/templates/main.tex` | `templates/latex/templates/main.tex` | LaTeX entry template |
| `resources/latex/themes/mpltx.cls` | `templates/latex/themes/mpltx.cls` | LaTeX theme class |
| `resources/typst/templates/main.typ` | `templates/typst/templates/main.typ` | Typst entry template |
| `resources/typst/templates/mplts.typ` | `templates/typst/templates/mplts.typ` | Typst theme (entry-side copy) |
| `resources/typst/templates/american-physics-society.csl` | `templates/typst/templates/…csl` | Citation style |
| `resources/typst/templates/bibli.bib` | `templates/typst/templates/bibli.bib` | Seed bibliography |
| `resources/typst/themes/mplts.typ` | `templates/typst/themes/mplts.typ` | Typst theme (theme-side copy; currently byte-identical to the templates copy — both kept to preserve upstream layout) |
| `resources/skills/*.md` | adapted from `templates/external/skills/*.md` + new | Preset-scoped runtime skills |
| `resources/report-languages/{latex,typst}.md` | adapted from `templates/report-languages/*` | Language guidance (not runtime skills) |
