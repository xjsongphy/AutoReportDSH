# AutoReportDSH

Physics-experiment report workflow (AutoReportCLI) as a **DeepSeek Harness (`dsh`) plugin**.

DeepSeek Harness owns runtime mechanics — agent loops, continuable child sessions,
persistence, compaction, provider routing, tool pipeline, subprocess lifecycle. AutoReportDSH
owns report semantics and policy — fixed roles, role binding, task/delegation state, structured
child reports, role authorization, execution isolation, workspace initialization, artifact
semantics, manifest projection, templates, compilation, domain skills. The full architecture
lives in [PLAN.md](PLAN.md).

## Status: scaffold phase

The package loads as an out-of-tree cordis plugin; domain phases land next per PLAN.md §4:
`workflow-state`, `roles-delegation`, `execution-policy`, `workspace-assets`,
`compile-manifests`, `integration-e2e`.

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

## Repo layout

```text
package.json               link: dependencies into the local harness checkout
cordis.template.yml        patch-overlay source (renders cordis.overlay.generated.yml)
presets/autoreport-main/   Main agent-preset composition (placeholder until roles-delegation)
scripts/install-user-preset.ts
src/index.ts               host-plane plugin entry
resources/                 personas/templates/skills land here in later phases
docs/dependencies.md       pinned harness commit + dependency wiring notes
tests/                     vitest unit tests + smokes
```
