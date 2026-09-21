# AutoReportDSH own features and scope

This is the product-scope contract for AutoReportDSH. It adapts the
report-domain boundary of the sibling AutoReportCLI project to a DeepSeek
Harness (DSH) plugin: DSH supplies the host runtime; this project supplies
report semantics and does not claim to be a separate general-purpose agent
platform.

## AutoReportDSH-owned features

- **Fixed five-role workflow:** Main, Theory, Data Analysis, Plotting, and
  Report have fixed personas, responsibilities, and writable roots.
- **Durable report coordination:** `send_to_agent`, `report_workflow`, role
  bindings, task/delegation snapshots, artifact observations, and manifest
  notes are persisted in the owning Main session. A specialist can be
  re-bound without reconstructing its work from chat history.
- **Experiment workspace:** create-missing-only initialization of `Data/`,
  `References/`, `Theory/`, `Plots/`, `Report/`, and `Outline/`; LaTeX/Typst
  report assets and project-scoped language settings.
- **Domain instructions:** bundled personas plus scoped report skills; project
  skills may be supplied under `References/skills/` and are discovered only in
  AutoReport session scopes.
- **Write isolation:** Main may write `Outline/`; Theory `Theory/`; Data
  Analysis `Data/Processed/`; Plotting `Plots/`; Report `Report/`. The plugin
  adds both a synchronous tool guard and a DSH workspace-write sandbox-root
  override.
- **Settings integration:** report language, wait limits, Python interpreter,
  and specialist-model selection are stored through DSH settings/project state;
  DSH retains ownership of provider credentials and model execution.
- **Web settings UI:** the plugin contributes only its configuration card and
  does not replace the DSH application UI.

## Explicit non-goals

AutoReportDSH does not add arbitrary agent definitions or graphs, MCP,
marketplaces, provider/API-key management, account login, a native TUI,
general browser automation, general coding-agent workflows, or an independent
runtime/persistence system. It uses DSH agents, sessions, compaction,
subagent transport, filesystem tools, shell tools, sandboxing, and skill
infrastructure.

A future feature belongs here only when it is report-domain behavior or a
small implementation adaptation required to enforce that behavior. Otherwise
it needs an explicit product-scope decision.

## AutoReportCLI adaptation

| Concern | AutoReportCLI | AutoReportDSH |
| --- | --- | --- |
| Runtime/session host | native Rust runtime and local rollout files | DSH agents, sessions, compaction, and subagent transport |
| Taskboard persistence | project-state `taskboard.json` | append-only `autoreport/task` and `autoreport/delegation` events on Main |
| Agent team | fixed five roles | fixed five roles |
| Write isolation | AutoReport execution policy | DSH `workspace-write` plus AutoReport guard/root override |
| Providers and credentials | CLI configuration/auth flow | DSH profile configuration; not duplicated here |
| Generic plugins/MCP | excluded | excluded |

The two taskboard stores are intentionally different. AutoReportDSH may claim
recovery equivalence only after actual DSH persistence-load, compaction, and
restart/rebind tests prove it; in-memory event-fold tests alone are insufficient.

## Current release gates

Role write isolation no longer depends on a DSH-side API: the host plugin wraps
the in-process sandbox-policy singleton, so stock DSH confines each role to its
own directory and the `patches/` source shim is retired (see
`docs/dependencies.md`).

Session logs stay loadable through in-process vocabulary registration, verified
against the stock release: a log carrying `autoreport/*` records loads once the
plugin registers its names, and the plugin fails loud if a future DSH removes
both that mechanism and the persisted-marker write option. The remaining gap is
portability, not loadability: without upstream's `AppendOptions.ignorable` write
option, a log is loadable where the plugin loads, not by a plain or future `dsh`
build. Two upstream dependencies therefore remain before a release may claim
compatibility with an arbitrary DSH build:

1. `Session.append` accepting `AppendOptions.ignorable` (development workaround:
   one cherry-picked commit; upstream PR pending) — closes the portability gap.
2. The subagent seam keeping host-protocol child delivery and `agent/created`
   scope injection; both are internal-leaning surfaces the unified-steer change
   moved in 0.1.6-alpha.1.

Likewise, the durable AutoReport task state is the workflow event log, not
DSH's generic `todo_write`. The current Main-facing API creates and redispatches
workflow tasks through `send_to_agent`; it is not a full interactive task-board
editor or a generic DSH todo replacement.
