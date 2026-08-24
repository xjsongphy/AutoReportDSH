# AutoReportDSH — Design Plan (rev 3)

Migrate the AutoReportCLI physics-report workflow into a DeepSeek Harness (`dsh`) plugin.
The scope contract is `../autoreportcli/docs/own-features.md`: preserve AutoReport-owned
domain semantics, while reusing DSH infrastructure wherever its contract is equivalent.

This revision incorporates the architecture review supplied after the first subagent review.
The main corrections are: DSH continuable messaging is used as messaging rather than a
synchronous RPC; report task/delegation state is plugin-owned and durable; manifests are
runtime-generated; and role write/network boundaries are enforced rather than described only
in personas.

## 1. Product boundary

### AutoReportDSH owns

- The fixed roles Main, Theory, Data Analysis, Plotting, and Report.
- Role prompts, report quality gates, and role-to-directory policy.
- The constrained parent/child report workflow and durable delegation/task state.
- Experiment workspace initialization and create-missing-only asset materialization.
- LaTeX/Typst templates, themes, bibliography assets, and compilation workflow.
- Runtime-generated produced-file manifests.
- Physics/report-writing skills and the report-specific execution policy.
- Default network denial for report execution, with fail-closed behavior where it cannot be
  established by the host platform.

### DeepSeek Harness owns and is reused

- Agent loops, continuable child Sessions, inboxes, follow-up/report message delivery,
  persistence, resume, compaction, and cancellation.
- Provider/model routing, credentials, settings, and the Web/TUI host.
- Generic tools, filesystem primitives, subprocess capability, approvals, and base sandbox.
- Generic skill discovery/loading, slash-command infrastructure, and user-input requests.

### Intentional v1 divergences

- AutoReport’s broadcast bus and arbitrary peer messaging remain out of scope. Fixed roles
  communicate only through DSH’s authenticated parent→child `followup()` and child→parent
  `reportFrom()` paths.
- Pinned remote resource synchronization is dropped for v1; resources are bundled and
  versioned with the plugin.
- DSH `todo_write` is not used as the report task board. It may remain available as a private
  generic tool only if the selected preset needs it; it is not authoritative report state.
- DSH’s stock sandbox is not treated as a network boundary. AutoReportDSH owns a report
  execution wrapper that establishes network denial or refuses execution.
- No arbitrary agent creation, MCP, account login, hosted service, browser automation,
  image understanding, or general coding-agent product surface is added.

No existing community dsh plugin covers the physics-report domain. The npm/GitHub
`dsh-plugin` search found UI-level LaTeX helpers, marketplaces, and unrelated utilities only.

## 2. Architecture

### 2.1 Package shape

One out-of-tree Cordis plugin package is loaded as a patch overlay over stock `web` or
`headless` profiles:

```text
AutoReportDSH/
├── package.json
├── cordis.yml                         # plugin rows + merged preset-root overlay
├── src/
│   ├── index.ts                       # host-plane registration and lifecycle
│   ├── config.ts                      # validated report/execution configuration
│   ├── roles.ts                        # fixed role table and policy metadata
│   ├── workflow/
│   │   ├── service.ts                  # report task/delegation service
│   │   ├── events.ts                   # SessionEventMap extension and projections
│   │   └── protocol.ts                 # constrained message/report envelopes
│   ├── tools/
│   │   ├── send-to-agent.ts            # thin DSH continuation-message consumer
│   │   ├── report-task.ts              # report task/delegation state consumer
│   │   ├── report-exec.ts              # role-scoped, network-denied execution consumer
│   │   └── compile-report.ts            # report compiler over report-exec
│   ├── workspace/
│   │   ├── init.ts                     # scaffold and create-missing-only materializer
│   │   └── manifest.ts                 # runtime manifest projection/materializer
│   ├── policy/
│   │   ├── tool-guard.ts               # actual role write enforcement
│   │   └── execution-isolation.ts      # network + role-root process enforcement
│   └── skills.ts                        # bundled SkillProvider
├── presets/
│   └── autoreport-main/agent.cordis.yml
├── resources/
│   ├── personas/*.md
│   ├── report-languages/*.md
│   ├── latex/{templates,themes}/
│   ├── typst/{templates,themes}/
│   └── skills/*.md
└── tests/
```

The plugin’s host-plane `apply()` registers the report workflow service, durable event
projection, `/report-init`, bundled skills, runtime manifest observer, role policy guard, and
report execution capability. Model-facing tools are mounted through the `autoreport-main`
agent-plane composition, not globally, so unrelated DSH sessions do not see report tools.

The preset is derived from the DSH `standard` composition but replaces generic delegation
with the fixed report surface. It carries the normal filesystem/read and approval support,
then mounts `send_to_agent`, `report_task`, `report_exec`, and `compile_report` as scoped
rows. Generic `subagent`, `subagent_fork`, workflow, and ralph tools are omitted.

The overlay adds the preset directory to the `agent-presets` row. Because a patch replaces a
row’s entire config, it must merge the existing resolved `roots` array rather than replace
it. The implementation will follow the verified profile-boot pattern in
`deepseek-harness/apps/cli/src/profile-boot.ts:159-165` and add a keyless roster test.
The plugin does not change the deployment’s default preset; users select `autoreport-main`.

### 2.2 Fixed roles and write scopes

| Role | Durable child | Permitted writes | Execution root |
|---|---|---|---|
| MAIN | user session | `Outline/` | no arbitrary shell; report tools only |
| THEORY | one continuable child | `Theory/` | `Theory/` |
| DATA_ANALYSIS | one continuable child | `Data/` processed outputs | `Data/` |
| PLOTTING | one continuable child | `Plots/Fig/`, `Plots/Scripts/` | `Plots/` |
| REPORT | one continuable child | `Report/` | `Report/` |

All roles can read the experiment workspace subject to the deployment’s ordinary read
policy. A role’s write scope is narrower than the DSH workspace root and is an independent
AutoReport authorization decision.

### 2.3 Constrained communication over DSH continuations

`send_to_agent` is a thin constrained consumer of the existing DSH continuation seam. It is
not a new agent runtime, result-bearing child wrapper, message bus, or synchronous RPC.

Verified DSH behavior:

- `startContinuable()` accepts the initial child message and returns `{ childId, messageId }`;
- `followup()` accepts a later FIFO message and returns its accepted message id;
- neither waits for the child turn to start or finish;
- `reportFrom()` is the child-authorized parent-message path;
- cold resume is owned by DSH’s continuation manager, not by this plugin.

The tool therefore does only the following:

1. Validate a fixed role and report task id. It does not accept an arbitrary provider,
   persona, tool set, or child graph request.
2. Resolve the role’s durable child descriptor. Start it with `startContinuable()` when no
   child exists; otherwise deliver a `followup()` to the same child. DSH’s durable child
   identity and label are authoritative; the plugin stores the role/task association in its
   own durable workflow event.
3. Append a delegation event before/after accepted delivery, including role, task id,
   child session id, message id, and lifecycle state.
4. Return an **accepted-message acknowledgement**, not a completion result. Main receives
   the specialist’s result through DSH’s next-step child report message.

The child-side report protocol is also a thin wrapper over `ctx.subagents.reportFrom()`.
The plugin may install a role-scoped `report_workflow` tool alongside the stock `report`
tool. Its schema validates and serializes:

```json
{
  "status": "success" | "blocked",
  "block_type": "missing_data" | "quality",
  "response": "self-contained result for Main",
  "produced_files": ["workspace-relative paths"]
}
```

The message is delivered through DSH’s existing authenticated parent report path. It does
not end the child turn. A parent-side observer validates the envelope, appends a durable
workflow/delegation event, and exposes the result in Main’s next admitted step. Invalid or
missing envelopes are recorded as a failed/quality-blocked delegation; they are never treated
as successful completion.

The child role persona and tool restriction are supplied through DSH’s supported continuable
child setup. Since `applyChildComposition()` joins the child to its parent preset, each
specialist inherits the Main composition; its restriction removes `send_to_agent` and any
other delegation-control tool to prevent recursion. A keyless test must prove the role
persona shadows the inherited Main persona and that the specialist cannot execute the
removed tools.

### 2.4 Durable report task and delegation state

AutoReport task state is not represented by DSH `todo_write`. The plugin adds a small
workflow service and SessionEventMap extension whose snapshots are the authoritative state.
The exact event names and schemas are finalized before implementation, but the minimum
records are:

- `autoreport/workflow` — selected workspace, language, initialized state, and version;
- `autoreport/task` — complete task snapshot: stable id, subject, role owner, dependencies,
  status, revision, blocked reason, and relevant workspace scope;
- `autoreport/delegation` — complete delegation snapshot: task, role, child session,
  accepted message, phase, and latest report outcome;
- `autoreport/artifact` — complete artifact snapshot emitted by the manifest projection.

Events are append-only durable facts and projections fold them from the session log, following
DSH’s `SessionEventMap` and model-visible-is-logged rules. The report task tool exposes only
fixed-workflow operations: create/update/claim/complete/block/reopen, with dependency and
role validation. Main’s prompt directs it to this tool and `Outline/`, not generic todo state.

Parent→child task delivery is `followup()`; child→parent progress/results use
`reportFrom()`. There is no second queue and no arbitrary peer mailbox. User-input requests
reuse DSH’s existing `ask-user` capability.

### 2.5 Actual role write isolation

The policy has two layers:

1. A scoped monotonic `ctx.tools.guard()` or equivalent `tools/pre-execute` decision validates
   every model-facing mutation tool. It identifies the exact calling Agent, resolves its
   role from the durable workflow binding, parses the target paths for filesystem/edit/
   patch/report tools, and denies any target outside the role’s normalized allowed prefixes.
   Unknown or unbound agents fail closed. The stock `fs/write-intent` and `fs/edit-intent`
   waterfalls are not layered on because DSH’s observation policy owns those single-slot
   decisions.
2. Generic unrestricted shell tools are not mounted in the AutoReport preset. All model-
   requested process execution goes through `report_exec`, which passes the role’s
   execution root to a real process isolation backend. The backend must enforce the root at
   the OS/process boundary, not by inspecting shell text or relying on persona instructions.

The role guard also covers deletes and rename-like mutations, not only writes and edits.
Compilation is permitted only for the Report role and writes only within `Report/`.

### 2.6 Actual default network denial

The DSH sandbox documentation explicitly limits its policy vocabulary to file effects;
network access is not denied by `workspace-write` or `read-only`. AutoReportDSH therefore
must not claim network denial from the stock sandbox.

`report_exec` uses a dedicated execution-isolation backend with this invariant:

> Every report process starts with network access denied unless an explicit future policy
> grants it, and execution fails closed if the selected platform cannot establish or verify
> that denial.

The backend may reuse DSH subprocess/sandbox primitives where they provide the required
primitive, but it must add platform-specific isolation where they do not (for example,
network namespaces or an OS sandbox profile). The implementation must document supported
platforms and prove denial with a keyless subprocess smoke. A prompt-only prohibition,
command-string blacklist, or stock workspace sandbox is not accepted as enforcement.

No network-capable generic web tool is mounted in the report preset. If future report
features need network access, that is a separate explicit policy and approval decision, not
a silent exception to the default.

### 2.7 Workspace and resources

`/report-init` is a human command registered through `ctx.commands`:

1. Select/validate the experiment cwd.
2. Create `Data/`, `References/`, `Theory/`, `Plots/Fig/`, `Plots/Scripts/`, `Report/`, and
   `Outline/`.
3. Materialize only missing resources for the selected language:
   - LaTeX: `Report/main.tex` and theme `.cls`;
   - Typst: `Report/main.typ`, `mplts.typ`, `.csl`, and seed `bibli.bib`.

Existing files are never overwritten. Assets are copied from
`autoreportcli/templates/{latex,typst}` with license headers retained.

### 2.8 Runtime-generated manifests

Agents do not call an `update_manifest` tool. Manifest tracking is automatic:

- For filesystem mutation tools, the runtime records the authorized target and successful
  result through the tool lifecycle (`tools/result` or an equivalent post-success observer),
  then appends an `autoreport/artifact` event.
- `report_exec` snapshots the role’s permitted execution root before and after a successful
  process and records the normalized changed-file set. This covers Python scripts, plotting
  output, compiler output, and other process-mediated writes without trusting model claims.
- A projection materializes the visible per-directory manifest atomically. Manifest files
  are derived artifacts, not the source of truth; session events remain authoritative.
- Failed, denied, or ambiguous process results do not claim artifacts. If a process changes
  files but the result cannot be classified, the projection records an `unknown` artifact
  state for later inspection rather than silently reporting success.

A read-only artifact/manifest query may be mounted for agents, but no model-facing mutation
operation is needed.

### 2.9 Compilation and scientific execution

`compile_report` is a thin report-domain tool over `report_exec`. It is only authorized for
REPORT and invokes `latexmk`/`tectonic` for LaTeX or `typst` for Typst under the role root,
returning bounded structured diagnostics and artifact paths. Missing binaries fail loudly.
Python and plotting scripts use `report_exec` with the same root/network policy.

Bundled skills include `experiment-report-writer.md`, `latex-compile.md`, a Typst compiler
skill, and language-specific guidance migrated from the AutoReport templates. Skill discovery
uses DSH’s `ctx.skills`; the plugin does not create a second skill catalog.

### 2.10 Configuration

Validated plugin configuration:

- `reportLanguage: 'latex' | 'typst'` (default `latex`);
- `latexEngine: 'latexmk' | 'tectonic'`;
- optional `pythonEnv`, checked before use and passed only to report execution;
- `workspaceRoot`, defaulting to the session cwd;
- execution policy with network denial as the immutable default for v1.

Provider/model binding remains entirely in DSH. Development/e2e testing uses the OpenRouter
Anthropic-compatible endpoint from `~/.claude/settings.json`: base URL
`https://openrouter.ai/api`, key environment variable `OPENROUTER_API_KEY`, and model
`stealth/ox-alpha` (optionally `stealth/ox-alpha[1M]`). Credentials are never committed.

## 3. Testing and acceptance

### Keyless unit tests

- Fixed role/task/delegation protocol validation.
- Durable event folding and revision/conflict behavior.
- Parent→child `startContinuable`/`followup` acknowledgement semantics.
- Child report envelope validation and malformed/missing report handling.
- Role write matrix across filesystem, edit, delete, patch, compile, and execution tools.
- Manifest event generation and idempotent projection.
- Create-missing-only resource materialization.
- Config and unsupported-platform fail-closed behavior.

### Keyless assembled smokes

- Boot the real Loader composition with the preset-root patch.
- Verify the original preset roster remains present after roots are merged.
- Select `autoreport-main`; verify its scoped tool catalog and absent generic delegation tools.
- Spawn one child; verify inherited composition, role persona shadowing, recursion restriction,
  durable binding, and report-message delivery.
- Run `/report-init` in a temporary workspace and verify every directory/resource.
- Attempt cross-role filesystem and process writes and verify actual denial.
- Run a harmless report process and verify network isolation using an OS-level probe.
- Verify manifests are produced after fs and process mutations without any agent manifest call.

### Real API milestone

Only after all keyless acceptance tests pass, use OpenRouter `stealth/ox-alpha` to drive a
minimal flow: initialize → Main creates report tasks → Theory/Data/Plotting work through
continuations → Report compiles a stub report. Assert durable events, files, manifests,
write denials, and PDF output; never accept a model’s textual claim as evidence.

## 4. Delivery plan

| Branch | Content | Depends on |
|---|---|---|
| `scaffold` | package, plugin rows, preset-root merge, README, build/test harness | — |
| `workflow-state` | role table, SessionEventMap events/projections, report task tool, message protocol | scaffold |
| `roles-delegation` | Main preset, fixed personas, thin `send_to_agent`, continuable child setup/report tool | scaffold, workflow-state |
| `execution-policy` | actual role mutation guard, role-scoped report executor, network-denial backend and smokes | scaffold, workflow-state |
| `workspace-assets` | `/report-init`, resource materializer, bundled LaTeX/Typst assets and skills | scaffold |
| `compile-manifests` | compiler over report-exec, automatic artifact observer, manifest projection | execution-policy, workspace-assets, workflow-state |
| `integration-e2e` | assembled keyless smokes, OpenRouter configuration/e2e, acceptance gates | all previous |

Merge order is `scaffold` → parallel `workflow-state`/`execution-policy`/`workspace-assets` →
`roles-delegation` and `compile-manifests` → `integration-e2e`. The coordinator merges each
branch as its dependencies pass focused tests. The important integration points are role
binding between workflow-state/execution-policy/roles-delegation and artifact paths between
workspace-assets/compile-manifests.

## 5. Risks and gates

1. **Continuable setup API**: the implementation must use DSH’s `startContinuable()` /
   `followup()` acceptance semantics and never await child completion inside `send_to_agent`.
2. **Report delivery ordering**: the parent observer must distinguish child-authored
   `subagent-report` messages from DSH settlement notices and fold both without duplicate
   task completion.
3. **Out-of-tree preset resolution**: verify module resolution inside an external
   `agent.cordis.yml`; use the profile resolver manifest or explicit module paths as required.
4. **OS execution isolation**: no platform is declared supported until role-root writes and
   network denial are keylessly demonstrated. Unsupported environments fail closed.
5. **Manifest completeness**: filesystem and process-mediated writes need separate tests;
   unknown process changes must be represented as unknown, never omitted.
6. **DSH pre-release churn**: pin the harness checkout used for development and update only
   through focused compatibility changes.
7. **Prompt migration**: retain AutoReport quality gates while translating Rust-CLI tool
   names and generic coordination instructions to the DSH report tools.
