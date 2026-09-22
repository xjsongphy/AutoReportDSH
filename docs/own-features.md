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
  AutoReport session scopes. A REPORT child cannot edit report content or run
  its compiler before the skill governing that action is loaded — see
  [Report-skill gates](#report-skill-gates). The active language's layout rules
  are prompt prose rather than a skill — see
  [Prompt-attached language guidance](#prompt-attached-language-guidance).
  Referenced skill documents are addressed through DSH's own resource anchor —
  see [Skill resource anchoring](#skill-resource-anchoring).
- **Write isolation:** Main may write `Outline/`; Theory `Theory/`; Data
  Analysis `Data/Processed/`; Plotting `Plots/`; Report `Report/`. The plugin
  adds both a synchronous tool guard and a DSH workspace-write sandbox-root
  override. Only writes are confined: every sandbox runner DSH ships grants the
  resolved root write access and leaves reads unrestricted, so a role reads the
  whole experiment tree — and the rest of the filesystem — without gaining a
  write anywhere outside its own directory. `tests/bash-confinement.live.test.ts`
  asserts both halves in one session.
- **Settings integration:** report language, wait limits, Python interpreter,
  and specialist-model selection are stored through DSH settings/project state;
  DSH retains ownership of provider credentials and model execution.
- **Web settings UI:** the plugin contributes only its configuration card and
  does not replace the DSH application UI.

## Report-skill gates

A registered skill is only a catalog line; its body arrives when the model
loads it. A REPORT child could therefore write report prose, or run the
compiler, before ever reading the instructions that govern either. Two gates
close that window:

| Action | Gate | Refused until loaded |
| --- | --- | --- |
| Any file mutation in the report workspace (`write`, `edit`, `str_replace_editor`, `apply_patch`, `delete`) | writing | `experiment-report-writer` |
| `bash`/`pwsh` invoking the active language's compiler (`latexmk`, `tectonic`, `xelatex`, `pdflatex`, `lualatex`; `typst compile`) | compile | the active language's compile skill (`latex-compile` / `typst-compile`) |

The call is refused with an error that names the missing skills, says how to
load them (the `skill` tool, one call per name), and states that nothing else
about the call was wrong — so the model loads the skill instead of rewriting a
call that had no other problem.

**The model loads the skill itself. The harness never attaches one.** An
earlier design had the harness inject the `<skill_content>` block at the next
step boundary. It was rejected: DSH's own event types reserve `tool/call` for
"the model requested this invocation… exactly as the model produced it", and a
`tool/result` is a surface event that joins the model-visible history on every
load. Injecting would have put a fabricated agent action — and a fabricated
tool result the model would keep seeing forever — into the durable transcript
that this project treats as its authoritative record. Letting the agent call
`skill` leaves a real tool call by the agent that actually needed the
instructions, and costs one extra step.

The gates read the durable session stream to know what is loaded: a `skill`
call that returned the rendered `<skill_content>` block, or a
`skill-invocation`-sourced message. A failed call, a denied call, or a mere
mention of a marker in unrelated text never counts.

Boundaries:

- Only the active language's compiler is gated; a foreign toolchain is not this
  requirement's business. A shell command that merely mentions a compiler
  (`rg latexmk build.log`) is not an invocation, and a `str_replace_editor`
  view is a read.
- Only AutoReport-bound REPORT sessions are gated. MAIN, every other role, and
  every stock DSH session pass through untouched.
- A refused child is never stuck: it keeps `read`, non-compiler `bash`,
  `manifest`, and `report_workflow(blocked)`, so it can report the blockage
  instead of stalling silently.
- The gates live in `src/policy/skill-gate.ts`; registration and enforcement
  both resolve through `reportSkillRequirements()`, so a gate can never require
  a skill the child was never given.

## Prompt-attached language guidance

`resources/report-languages/<language>.md` holds the active language's layout
rules. These were once skills, which forced two consequences: a REPORT child
could only obtain them by loading a skill, and the writing gate had to demand
that load before any edit.

They are unconditional guidance, not a decision the model makes, so the report
router appends them to every REPORT prompt (section `report-language-guidance`,
next to the existing `report-environment` facts). The consequences are the
point: the rules are present before the child's first step, the writing gate
needs only the writer, and no refusal can name a skill whose absence the model
was never able to remedy.

These files therefore carry no frontmatter. Frontmatter is what makes a document
a catalog entry, and these deliberately are not one.

## Skill resource anchoring

DSH tells the model what a skill's relative paths resolve against in exactly one
place: the `<skill_resources>` block that `renderSkillContent` emits beside
`<skill_instructions>`. A runtime registration without a `resourceBase` renders
"Resources for this skill are managed by provider \"runtime\"." instead, so a
body saying `[basics.md](basics.md)` has no addressable meaning.

`registerBundledSkill` forwards `resourceBase` for every skill that ships
sibling documents, and the loader derives which those are from the layout rather
than a name list: a skill is a **directory bundle** (`skills/<name>/SKILL.md`
beside its references) or a **flat document** (`skills/<name>.md`). Bundles
advertise their directory; flat documents advertise nothing.

That distinction is load-bearing. DSH's hint reads "Resolve relative paths
mentioned by this skill against the base directory" — it covers bare paths in
prose, not only links. A skill whose body names the experiment workspace
(`Report/main.tex`, `../Plots/Fig/`, `bibli.bib`) must therefore NOT carry a
base, or the model would be told to look for `Report/main.tex` under
`resources/`. Today `experiment-report-writer` and `typst` are bundles; the
compile and PDF-extraction skills are flat.

## Resources are vendored, never fetched

`resources/` is the single source of truth: personas, LaTeX/Typst templates and
themes, skill documents, skill reference bundles, and language guidance. There
is no sync module, no managed-resource table, no `$DSH_HOME/autoreport/resources`
overlay, and no startup fetch. Documents formerly adapted at download time carry
their adapted text in the committed file.

This removes a whole failure class rather than tuning it: an upstream
restructure, a moved path, a changed blob, or a network outage can no longer
change what a session reads, and a prompt a session followed is always the
prompt in the commit it came from. Updating a vendored document is now an
ordinary reviewed commit, and its provenance lives beside it where the file
itself points — `resources/skills/experiment-report-writer/provenance.json`
records the upstream commit and per-module blob hashes.

Because the copy is now the artifact, attribution moved with it: the upstream of
every vendored document, and the license that travels beside it, is listed under
[Credits](../README.md#credits) in the README.

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

### Durable state lives in the plugin's own log

AutoReport's workflow records are **not** in the DSH session log. They live in a
log the plugin owns, under the harness home, keyed by workspace:

```text
<home>/autoreport/<workspaceId>/workflow/<main session id>/session.jsonl
```

That is where AutoReportCLI kept its per-workspace state
(`~/.autoreport/workspaces/<id>/{manifests,taskboard.json,project.toml}`), and
it sits beside this plugin's external project settings
(`<home>/autoreport/<workspaceId>/project.json`). It is deliberately **not**
inside the experiment workspace: `.autoreport` is a name the ported policy
reserves as a *non-writable* workspace directory
(`autoreport-rs/tools/src/file_tools.rs`, asserted by its isolation test), so it
is a guard, not a storage location.

Naming mirrors DSH's own session artifacts (`session-persistence-jsonl`): the
session id is escaped with the same `~XXXX` segment rule, and the file uses
DSH's generation-zero log name, so a future incompatible record format adds
`session.v1.jsonl` beside it under the same rule. One deliberate difference: a
plain `.jsonl` rather than `.jsonl.zstd`, so the log stays readable while
debugging. Each line carries the record's `seq` and an epoch-millisecond `time`.

Why not the session log: a session log carrying third-party event types is
refused by DSH's persistence reader unless every record bears the envelope's
`ignorable` marker. That write option no longer exists (`Session.append` accepts
options only for surface event types), and upstream states that event-name
registration "was rejected because it does not classify omission safety and
would make reads composition-dependent". Keeping our records out of the host log
is the only arrangement in which **every** `dsh` build reads our sessions
unmodified — with no registration step, no marker, and no upstream dependency.

Properties this buys and costs:

- The experiment workspace stays a clean deliverable: no plugin runtime state in
  it, and nothing new for a user's `git status`. The log is keyed by a hash of
  the workspace path (`workspaceIdForRoot`), so it never leaks a path fragment.
- Moving the workspace to another machine does **not** carry the workflow state:
  same-workspace-path on a different home is a different log. The experiment
  `project.json` settings behave the same way.
- `autoreport/*` no longer appears in the WebUI Trajectory event ledger. Reading
  the workflow means opening the log above, or the manifest tool.
- We own durability: synchronous append-only writes, no session write lease and
  no compaction integration. A torn final line is skipped rather than fatal, and
  a missing log is an empty workflow, not an error.
- A session created before the log existed is migrated once: its `autoreport/*`
  records are read out of the host log, written to the new file, and never
  consulted there again.

Likewise, the durable AutoReport task state is that log, not DSH's generic
`todo_write`. The current Main-facing API creates and redispatches workflow
tasks through `send_to_agent`; it is not a full interactive task-board editor or
a generic DSH todo replacement.
