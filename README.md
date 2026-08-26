# AutoReportDSH

Physics-experiment report workflow (AutoReportCLI) as a **DeepSeek Harness (`dsh`) plugin**.

DeepSeek Harness owns runtime mechanics — agent loops, continuable child sessions,
persistence, compaction, provider routing, tool pipeline, subprocess lifecycle. AutoReportDSH
owns report semantics and policy — fixed roles, role binding, task/delegation state, structured
child reports, role authorization, execution isolation, workspace initialization, artifact
semantics, manifest projection, templates, compilation, domain skills. The full architecture
lives in [PLAN.md](PLAN.md).

## Status: workspace-assets phase

The package loads as an out-of-tree cordis plugin; domain phases land per PLAN.md §4:
`workflow-state`, `roles-delegation`, `execution-policy`, `compile-manifests`,
`integration-e2e`. Workspace initialization, bundled report assets, the `/report-init`
command factory, and preset-scoped bundled skills are implemented.

## Quickstart

Prerequisites: Node 22.19+/24+, Corepack-enabled pnpm (`corepack enable`), and a local
checkout of `deepseek-harness` as a sibling directory (`../deepseek-harness`), built once
(`cd ../deepseek-harness && pnpm install && pnpm run build`).

```sh
pnpm install                 # links harness packages from ../deepseek-harness
pnpm test                    # vitest unit tests
pnpm run build               # tsc -> dist/
pnpm install:preset          # preset -> $DSH_HOME/.agent-presets/autoreport-main + renders cordis.overlay.generated.yml
pnpm dsh web --patch ./cordis.overlay.generated.yml   # run from the deepseek-harness checkout
```

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

The user layer rides DSH's settings service (namespace `'autoreport'`). DSH
exposes the registration API in-tree (`installSettingsSection` in
`@deepseek-ai/dsh-settings`), but that package is not yet linked out-of-tree to
this plugin, so user settings are currently passed as plain data and the
namespace registration lands together with the dependency.

## Repo layout

```text
package.json               link: dependencies into the local harness checkout
cordis.template.yml        patch-overlay source (renders cordis.overlay.generated.yml)
presets/autoreport-main/   Main agent-preset composition (placeholder until roles-delegation)
scripts/install-user-preset.ts
src/index.ts               host-plane plugin entry (registration wiring lands in integration)
src/workspace/             init.ts (layout + materializer), command.ts (/report-init), skill-loader.ts
src/skills-preset.ts       preset-scoped registration of resources/skills/*.md
resources/                 bundled assets copied from ../autoreportcli/templates (see table below)
docs/dependencies.md       pinned harness commit + dependency wiring notes
tests/                     vitest unit tests + smokes
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
