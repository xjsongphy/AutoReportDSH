# AutoReportDSH — Design Plan (rev 5, amended rev 7)

Migrate the AutoReportCLI physics-report workflow into a DeepSeek Harness (`dsh`) plugin.
The scope contract is `../autoreportcli/docs/own-features.md`: preserve AutoReport-owned
domain semantics while reusing DSH infrastructure wherever its contract is equivalent.

This revision incorporates the Rev 3 architecture review plus a source-backed review of
`../autoreportcli`, `../deepseek-harness`, and `../codex`. The key boundary is:

```text
DSH owns runtime mechanics.
AutoReportDSH owns report semantics and policy.
```

## 1. Product boundary

### AutoReportDSH owns

- Fixed roles: Main, Theory, Data Analysis, Plotting, and Report.
- Role prompts, report quality gates, and role authorization policy.
- Role binding, durable report task/delegation state, and structured child reports.
- Experiment workspace initialization and create-missing-only asset materialization.
- LaTeX/Typst templates, themes, bibliography assets, and compilation workflow.
- Runtime-generated artifact events and external manifest projections.
- Physics/report-writing skills and report-specific execution policy.
- Default network denial for report execution, with fail-closed behavior where it cannot be
  established by the host platform.
- Optional specialist model-route policy; DSH still owns provider/model execution and
  credentials.

### DeepSeek Harness owns and is reused

- Agent loops, continuable child Sessions, inboxes, follow-up/report message delivery,
  persistence, resume, compaction, and cancellation.
- Provider/model routing, credentials, settings, and Web/TUI host infrastructure.
- Generic filesystem primitives, subprocess lifecycle, approvals, and base sandbox.
- Generic skill discovery/loading, slash commands, and user-input requests.

### Intentional v1 decisions

- Session membership is explicit (compatibility invariant): loading the AutoReportDSH
  overlay must not change the behavior of sessions that did not explicitly select it.
  Only top-level sessions actually running the `autoreport-main` preset (header value or a
  later logged `agent-preset/selected`, matching DSH's `resolveSessionPreset`) join the
  workflow runtime as MAIN, and only RoleRegistry-bound children are specialists. Every
  other session keeps stock DSH behavior: no initialization, no workflow events, stock
  write/shell policy, stock child reporting. "Unknown to AutoReport" means "not our
  session", never "invalid AutoReport session" (see `src/membership.ts`).
- Fixed roles communicate only through DSH’s authenticated parent→child `followup()` and
  child→parent `reportFrom()` paths. AutoReport does not add a broadcast bus or arbitrary
  peer mailbox.
- Pinned remote resource synchronization is omitted; resources are bundled and versioned
  with the plugin.
- DSH `todo_write` is not authoritative report state. AutoReport uses its own durable task
  events and task tool.
- DSH’s stock sandbox is not treated as a network boundary. AutoReport owns report-execution
  isolation and refuses execution when network denial cannot be established.
- No arbitrary agent graphs, MCP, account login, hosted services, browser automation, image
  understanding, or general coding-agent product surface is added.
- `send_to_agent` supports explicit `wait: false | true`. The default remains
  compatibility-oriented blocking behavior: after DSH accepts the message, the tool may
  wait on the AutoReport delegation projection for `success | blocked | timeout` without
  waiting for the parent’s next model step. `wait: false` returns the DSH acceptance
  acknowledgement immediately. The waiter is a local synchronization aid; durable
  delegation state remains authoritative and DSH still owns child lifecycle and transport.
- Workflow continuity comes only from durable task/delegation state plus the workspace
  files themselves. There is no agent memory layer (no memory store, semantic retrieval, or
  conversation reconstruction), no workspace-to-prompt injection at resume (no automatic
  scan/summarize/inject), and no requirement to preserve prior reasoning. A recreated or
  compacted agent recovers from: task state + workspace state + role ownership.
- The MinerU / `mineru-open-api` skill path is omitted in v1. Default network denial would
  conflict with it; restoring it is a later explicit network-policy change.
- Agent-editable manifest descriptions/notes are omitted. Manifests are derived projections
  of `autoreport/artifact` events, not a model-facing annotation store.

No existing community dsh plugin covers this physics-report domain. `dsh-overleaf` and
similar UI/LaTeX helpers are not substitutes for the five-role workflow.

## 2. Architecture

### 2.1 Package shape

One out-of-tree Cordis plugin package is loaded as a patch overlay over stock `web` or
`headless` profiles:

```text
AutoReportDSH/
├── package.json
├── cordis.yml                         # plugin rows and global report-router overlay
├── scripts/
│   └── install-user-preset.ts         # materializes the preset under $DSH_HOME/.agent-presets
├── src/
│   ├── index.ts                       # host-plane registration and lifecycle
│   ├── config.ts                      # validated report/execution/model configuration
│   ├── roles.ts                        # fixed role table and policy metadata
│   ├── workflow/
│   │   ├── service.ts                  # report task/delegation service
│   │   ├── events.ts                   # SessionEventMap extension and projections
│   │   ├── role-registry.ts            # synchronous authorization projection
│   │   └── protocol.ts                 # delegation/report envelopes
│   ├── tools/
│   │   ├── send-to-agent.ts            # thin DSH continuation-message consumer
│   │   ├── report-task.ts              # report task/delegation state consumer
│   │   ├── report-workflow.ts          # replacement child report tool
│   │   ├── report-exec.ts              # policy-controlled process consumer
│   │   └── compile-report.ts            # Report-only compiler over report-exec
│   ├── workspace/
│   │   ├── init.ts                     # initialization and asset materializer
│   │   └── manifest.ts                 # external manifest projection/materializer
│   ├── policy/
│   │   ├── tool-guard.ts               # actual role mutation enforcement
│   │   └── execution-isolation.ts      # root/network isolation over ctx.subprocess
│   └── skills-preset.ts                # preset-scoped bundled skill registration
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

The plugin host plane registers the workflow service, durable projections, `/report-init`,
role policy guard, report-execution capability, and lifecycle observers. Model-facing tools
are mounted through the `autoreport-main` agent-plane composition rather than globally.

The Main preset is derived from DSH’s `standard` composition but exposes only the fixed
report surface:

```text
Main catalog
├── read/search
├── send_to_agent
├── report_task
├── ask_user
└── local planning/report context tools as needed
```

It does **not** expose generic `subagent`, `subagent_fork`, workflow, ralph, unrestricted
bash, or the generic DSH `report` tool.

Continuable child setup contributes `report_workflow` and `report_exec` to specialist
children. `compile_report` is contributed only to the Report child. If the DSH setup
mechanism cannot conditionally contribute by pre-provisioned role, the compiler schema may
be inherited by all specialists but its tool visibility and runtime guard must still deny it
outside Report; Main must never inherit it.

The stock `@deepseek-ai/dsh-tool-subagent-report` contribution is replaced for this profile,
not mounted alongside the AutoReport contribution. The overlay must patch/disable the stock
`tool-subagent-report` row and install the AutoReport child setup in its place. This prevents
an unstructured `report("done")` bypass beside `report_workflow(...)`.

The preset is installed into DSH’s existing writable user preset root:
`$DSH_HOME/.agent-presets/autoreport-main/`. The install script copies the preset
composition and static resources before the profile starts; it is idempotent and fails
loudly if the deployment disables `includeUserRoot`. No `agent-presets.roots` patch or
launcher-owned roots concat is required. The required smoke is: after installation, both
shipped `standard` and user `autoreport-main` resolve. The plugin does not change the
deployment default preset; users select `autoreport-main`.

If package installation cannot run the materializer, the documented explicit command is
`autoreportdsh install-preset`; runtime boot must not silently create a preset after the
roster has already been discovered. This uses DSH’s existing user-root discovery contract
rather than introducing a new preset-root contribution seam.

### 2.2 Fixed roles and explicit execution policy

Role identity, DSH Session identity, delegation identity, and transport identity are distinct.

```text
AutoReport Role
      │ binds to
      ▼
DSH Child SessionId
      │ receives work through
      ▼
AutoReport Delegation (task_id, revision)
      │ transported as
      ▼
DSH MessageId
```

Role policies use separate dimensions rather than one ambiguous execution root:

```ts
interface ReportExecutionPolicy {
  cwd: string
  readableRoots: string[]
  writableRoots: string[]
  network: 'deny'
  temp: 'private'
}
```

| Role | Child | `cwd` | Readable roots | Writable roots |
|---|---|---|---|---|
| MAIN | user session | workspace | workspace | `Outline/` |
| THEORY | one continuable child | `Theory/` | workspace | `Theory/` |
| DATA_ANALYSIS | one continuable child | `Data/` | workspace | `Data/Processed/` |
| PLOTTING | one continuable child | `Plots/` | workspace | `Plots/` |
| REPORT | one continuable child | `Report/` | workspace | `Report/` |

Every report process has `network: 'deny'` and a private temporary area. `cwd` controls
relative-command behavior only; it is not a read or write authorization boundary.

All roles can read the experiment workspace subject to the deployment’s ordinary read
policy. A role’s writable roots are narrower than the DSH workspace root and are enforced
independently.

### 2.3 Role binding before child execution

Authorization guards are synchronous and must not query persistence during tool execution.
The role binding therefore exists before a child can receive work:

```text
allocate caller-reserved child SessionId
        ↓
append autoreport/role-binding reservation
        ↓
update synchronous RoleRegistry
        ↓
startContinuable({ childId, ... })
        ↓
child becomes executable
```

`ContinuableStartSpec.childId` is the DSH-supported caller-reserved identity. The durable
`autoreport/role-binding` record contains at least:

```ts
interface RoleBinding {
  role: SpecialistRole
  childSessionId: SessionId
  parentSessionId: SessionId
  workflowId: string
}

type ProvisioningState = 'reserved' | 'active' | 'failed'
```

Authorization identity is separate from provisioning state. A reserved binding is already
valid for authorization: the synchronous `RoleRegistry` contains the exact child id,
parent-session id, and workflow id before `startContinuable()` begins materialization. The
guard requires the live child identity plus that parent/workflow relationship; it does not
wait for `phase === 'active'`. A failed start transitions provisioning to `failed` and
revokes the registry entry. A successful acceptance transitions provisioning to `active`.
Resume uses the same durable child id and reconstructs the registry before any follow-up.

This ordering is mandatory because `startContinuable()` may materialize, publish, and begin
the child’s first turn before returning `{ childId, messageId }` to the caller.

### 2.4 Thin constrained communication over DSH continuations

`send_to_agent` is a constrained consumer of the existing DSH continuation seam. It is not
a new runtime, result-bearing child wrapper, message bus, or synchronous RPC.

Verified DSH behavior:

- `startContinuable()` accepts an initial message and returns `{ childId, messageId }`;
- `followup()` accepts a later FIFO message and returns its accepted message id;
- neither waits for the child turn to start or finish;
- `reportFrom()` is the child-authorized parent-message path;
- cold resume is owned by DSH’s continuation manager.

The tool:

1. Validates a fixed role, task id, and current task state. It accepts no arbitrary provider,
   persona, tool set, or child graph request.
2. Creates a new `delegation_revision` for dispatch/re-dispatch. It resolves the role’s
   pre-bound child, using `startContinuable({ childId })` on first dispatch and `followup()`
   thereafter.
3. Records the accepted DSH `MessageId` as transport evidence in the delegation snapshot.
4. Returns an accepted-message acknowledgement when `wait: false`. With `wait: true`,
   it waits on an in-process waiter keyed by `(task_id, delegation_revision)` while the
   durable delegation projection remains authoritative. The waiter is resolved by the
   child report/settlement observer, not by waiting for the parent’s next model step. A
   bounded timeout produces a durable timeout phase and a tool error/result; it does not
   create another queue or transport path.

The model-facing request has explicit wait semantics:

```ts
send_to_agent({
  task_id,
  role,
  prompt,
  wait?: boolean,       // default true for AutoReport compatibility
  timeout_ms?: number,
})
```

The authoritative domain identity is `(task_id, delegation_revision)`; a separate
`delegation_id` may be used as its opaque durable key. DSH `MessageId` is recorded but is
not used as the domain attempt identity. After process restart, state recovers from the
session projection; an in-flight local waiter is not durable.

### 2.5 Replacement structured child report

The stock child-facing `report` setup is replaced by one global routing setup, not a
preset-local setup. DSH’s continuable setup registry is host-plane and shared by all
presets. The router performs:

```text
continuable child created
        ↓
RoleRegistry lookup
        ├── AutoReport specialist → report_workflow
        └── ordinary DSH child   → stock report
```

The stock `@deepseek-ai/dsh-tool-subagent-report` row is disabled/replaced so it does not
register a second setup. The AutoReport router reuses DSH’s exported stock
`installReportTool` for ordinary children rather than reimplementing generic reporting.
AutoReport specialists receive only `report_workflow`, following the same
`registerContinuableSetup()` → child-scoped `tools.register()` →
`ctx.subagents.reportFrom()` pattern as DSH’s stock adapter.

Its validated envelope is:

```json
{
  "task_id": "task-7",
  "delegation_revision": 3,
  "status": "success",
  "block_type": null,
  "response": "self-contained result for Main",
  "produced_files": ["workspace-relative paths"]
}
```

`block_type` is `missing_data` or `quality` when `status` is `blocked`, and null for
success. The tool validates path normalization and report size before serializing the
canonical envelope to `ctx.subagents.reportFrom()`.

A parent observer validates the envelope, correlates it by `(task_id, delegation_revision)`,
records its DSH `MessageId`, and folds it into the delegation state. A report for an older
revision is retained as stale evidence and cannot complete the current revision. Duplicate
transport delivery is idempotent by report message identity; multiple reports for one
attempt are treated as progress until one valid terminal report is accepted. Missing,
malformed, or unrecognized reports become explicit quality failures, never success.

The child report does not terminate the child turn. The child persona receives the
AutoReport-specific instruction to report with the replacement tool before finishing.

### 2.6 Durable report task/delegation state

AutoReport task state is not represented by DSH `todo_write`. The plugin adds a workflow
service and SessionEventMap extension whose snapshots are authoritative:

- `autoreport/workflow` — selected workspace, language, model policy, initialization state,
  and schema version;
- `autoreport/role-binding` — pre-provisioned role-to-child identity, parent/workflow
  lineage, authorization validity, and provisioning state;
- `autoreport/task` — complete task snapshot: stable id, subject, owning role,
  dependencies, status, revision, blocked reason, workspace scopes, and a bounded
  step checklist (`steps: { description, done }[]`) answering “what work remains”;
- `autoreport/delegation` — complete delegation snapshot: task id, delegation revision,
  role, child session, accepted message id, durable phase, and latest report outcome.
  Durable phases are at least `dispatched`, `waiting_for_child`, `completed`, `blocked`,
  `failed`, `timed_out`, `stale`, and `cancelled`. The snapshot records WHY something
  waits; it never serializes an in-memory waiter.
- `autoreport/artifact` — complete artifact snapshot emitted by the runtime observer.

Events are append-only durable facts and projections fold them from the session log under
DSH’s `SessionEventMap` and model-visible-is-logged rules.

**Persistence gate (P0).** `KNOWN_SESSION_EVENT_TYPES` is generated from the DSH repo only.
Out-of-tree plugin types are excluded by construction. AutoReport records must be
unknown-but-ignorable to stock readers, while the AutoReport plugin folds them when present.

This requires a small first-party DSH compatibility patch before `workflow-state`:

```ts
session.append(type, data, { ignorable: true })
```

The supported append API must preserve the existing official path: snapshot and validate the
data, assign `seq`/`time`, publish `session/event`, and persist through normal backends. The
patch adds an append-options type/overload carrying `ignorable?: true` alongside existing
surface metadata where applicable, copies the marker onto the resulting `SessionEvent`, and
adds direct writer tests. AutoReport must not monkey-patch `Session.prototype`, construct
events externally, write directly to persistence, or maintain a parallel event log.

AutoReport writes every `autoreport/*` event through this explicit seam. Keyless cold
`sessionPersistence.load` of a log containing those events is mandatory: with the plugin
mounted, projections recover state; without it, stock DSH opens the session while ignoring
unknown ignorable events. Live in-memory folding is not a substitute. The DSH compatibility
change is a prerequisite branch/repository change and its pinned version is recorded by
AutoReportDSH.

**Persistence and recovery rule.** The authoritative inputs for continuing unfinished work
are exactly:

```text
autoreport/* durable state  +  existing workspace files  +  role ownership
        ↓
continue work
```

LLM conversation history is not authoritative task storage. Recovery must not depend on
previous messages, compacted summaries, or hidden context, and AutoReportDSH must not add a
memory layer or auto-scan/summarize the workspace into prompts. A recreated agent inspects
workspace files through its normal tools.

Concrete consequences:

- **Compaction**: DSH compaction shadows surface content; the append-only log (including
  every `autoreport/*` fact) is untouched. Folding replays the full log, so task, role, and
  artifact projections survive compaction unchanged. No reconstruction from summaries is
  attempted or needed.
- **Report receipts**: DSH delivers each child report into the parent session log as a
  durable `subagent-report` message; the observer folds it into a delegation snapshot.
  Recovery folds both, so outcomes that arrived while Main was down reappear as state.
- **Child recreation (rebind)**: if a role’s cold resume fails unrecoverably (for example
  DSH `NOT_RESUMABLE`), the workflow may rebind: reserve a NEW caller-reserved child id,
  append a role-binding supersede event (old binding → `failed`/replaced, new reservation
  installed), and swap the synchronous registry atomically. The old child id loses
  authorization immediately; the new child is authorized before materialization. Unfinished
  tasks continue under new delegation revisions addressed to the same role — the new child
  needs no part of the old conversation.
- **Process restart**: fold rebuilds RoleRegistry and workflow state before any follow-up;
  delegations interrupted mid-flight resurface with their durable phases. In-process
  `wait:true` waiters are gone and are not reconstructed; Main re-dispatches with a new
  revision when needed.

The report task tool exposes
fixed-workflow operations:

```text
create
 dispatch
 block
 complete
 fail
 cancel
 reopen
```

There is no general `claim` operation: ownership is established during fixed-role dispatch.
Parent→child task delivery is `followup()`; child→parent progress/results are `reportFrom()`.
User questions reuse DSH’s existing `ask-user` capability.

### 2.7 Actual role write isolation

A scoped monotonic `ctx.tools.guard()` or equivalent `tools/pre-execute` decision validates
every model-facing mutation tool. It identifies the exact live Agent, resolves its role from
the synchronous `RoleRegistry`, parses target paths for filesystem/edit/delete/patch/report
tools, and denies targets outside normalized writable roots. Unknown or unbound agents fail
closed. DSH’s `fs/write-intent` and `fs/edit-intent` waterfalls are not layered on because
stock observation policy owns those single-slot decisions.

Unrestricted shell tools are not mounted in the AutoReport preset. All model-requested
process execution goes through `report_exec`, whose resolved `ReportExecutionPolicy` is
passed to an isolation backend. File-effect confinement reuses `ctx.sandbox.confine()`
when a single writable root can be expressed as that call’s `workspaceRoot`. Network
denial is an additional wrapper (bubblewrap `--unshare-net` / Seatbelt network deny);
DSH sandbox vocabulary does not include network. Multi-root roles (none in v1 after
Plotting writes `Plots/`) must not invent a second file-sandbox if `confine()` suffices.
The backend enforces writable roots and network denial at the process boundary, not by
inspecting shell text or relying on persona instructions.

### 2.8 `report_exec` over `ctx.subprocess`

AutoReportDSH does not implement a generic Node process manager. `report_exec` owns report
policy and calls DSH’s `ctx.subprocess` seam for lifecycle management:

```text
report_exec
     │
     ▼
AutoReport execution policy
     ├── explicit argv
     ├── cwd/readable/writable roots
     ├── private temp
     └── network-denial isolation backend
     │
     ▼
ctx.subprocess.spawn(...)
```

This reuses DSH executable lookup, bounded output, spill support, cancellation,
process-tree termination, process-group handling, environment scrubbing, and disposal.
The isolation backend may wrap argv with a supported OS mechanism (for example, bubblewrap
on Linux or a Seatbelt profile on macOS) while retaining DSH subprocess lifecycle. It must
not silently fall back to unrestricted subprocess execution.

### 2.9 Actual default network denial

DSH’s sandbox policy explicitly covers file effects, not network access. AutoReportDSH
therefore enforces this invariant independently:

> Every report process starts with network access denied unless a future explicit policy
grants it, and execution fails closed if the selected platform cannot establish or verify
that denial.

V1 support is explicitly:

```text
Linux:   supported after bubblewrap/network-namespace smoke
macOS:   supported after Seatbelt/network smoke
Windows: unsupported until equivalent denial is verified
```

The keyless network test starts a local TCP server, then runs a sandboxed child that attempts
a localhost connection; the connection must fail. It does not depend on public Internet
availability. No network-capable generic web tool is mounted in the report preset.

### 2.10 Workspace initialization and resources

AutoReportCLI initializes/materializes the project during normal startup. AutoReportDSH
preserves that behavior at the domain boundary: the first admitted report workflow turn
calls idempotent `ensureInitialized()`. `/report-init` remains an explicit idempotent
recovery/reinitialization command registered through `ctx.commands`.

Initialization creates AutoReportCLI’s `REQUIRED_DIRS` (`loader.rs`):

```text
Data/
Data/Processed/
References/
Theory/
Plots/
Plots/Fig/
Plots/Scripts/
Report/
Outline/
```

It materializes only missing resources for the selected language:

- LaTeX: `Report/main.tex` and theme `.cls`;
- Typst: `Report/main.typ`, `mplts.typ`, `.csl`, and seed `bibli.bib`.

Existing files are never overwritten. Assets are copied from
`autoreportcli/templates/{latex,typst}` with license headers retained.

### 2.11 Runtime-generated artifacts and external manifests

Agents do not call an `update_manifest` tool. Manifest tracking is automatic:

- Successful filesystem mutation tools produce `autoreport/artifact` events through the
  tool lifecycle observer.
- `report_exec` snapshots the relevant readable/writable roots before and after successful
  processes and emits normalized changed-file artifacts.
- Failed, denied, or ambiguous results never claim success; ambiguous process changes are
  represented as `unknown` artifacts.
- Session events are the source of truth. A projection may materialize an atomic cache under
  `$DSH_HOME/autoreport/<workspace-id>/manifests/`, never inside the experiment workspace.
  The workspace remains limited to user/report content directories.

The artifact policy preserves AutoReportCLI behavior:

```text
ignored intermediates:
.aux .log .out .toc .lof .lot .fls .fdb_latexmk .synctex.gz
.bbl .blg .tmp .bak .swp __pycache__ .DS_Store

no symlink traversal
bounded scan depth
bounded total entries
```

The exact ignore set, depth, and entry limits are ported from AutoReportCLI and covered by
unit tests. A read-only artifact query may be mounted for agents, but no mutation tool is
needed.

### 2.12 Compilation and skills

`compile_report` is contributed only to the Report child and is a thin domain tool over
`report_exec`. It invokes `latexmk` by default, optionally `tectonic` only when a local
cache/bundle is configured and verified, or `typst` for Typst reports. It returns bounded
structured diagnostics and artifact paths. It never widens network policy. Missing local
compiler resources fail loudly.

Bundled AutoReport skills are registered in the `autoreport-main` preset scope rather than
host-global. Specialist children inherit that scope through parent composition. Static
bundled resources use DSH’s normal skill registration; a custom SkillProvider is reserved
for a future return of dynamic remote resource synchronization.

### 2.13 Model policy

DSH owns provider implementations, credentials, and route execution. AutoReport preserves
separate Main/specialist binding as a lightweight policy:

- Main uses the DSH model route selected for the `autoreport-main` session.
- `specialistRoute` is an optional AutoReport configuration passed as the child
  `provider/model` request for every specialist role.
- If `specialistRoute` is unset, specialists inherit the Main route, matching DSH defaults.

This keeps provider mechanics in DSH while preserving the product-level ability to select a
different specialist model. Development/e2e configuration uses OpenRouter’s
Anthropic-compatible endpoint from `~/.claude/settings.json`: base URL
`https://openrouter.ai/api`, key environment variable `OPENROUTER_API_KEY`, and model
`stealth/ox-alpha` (optionally `stealth/ox-alpha[1M]`). Credentials are never committed.

### 2.14 Settings layering (rev 7)

DSH continues to own providers/credentials, Main model selection, compaction,
approvals, sandbox/shell configuration, session lifecycle, and UI preferences.
AutoReport owns ONLY report-workflow policy, layered as:

```text
explicit workflow override
        ↓
project settings        (<dshHome>/autoreport/<workspaceId>/project.json — external,
                          never inside the experiment workspace)
        ↓
AutoReport user settings (settings namespace 'autoreport')
        ↓
Cordis composition Config (plugin defaults)
        ↓
schema defaults
```

Plugin `Config` fields are DEFAULTS (`defaultReportLanguage`, `defaultLatexEngine`,
`specialistModel` with inherit-from-Main default, `defaultPythonEnv`,
`executionTimeoutMs`), not live workflow inputs. When a workflow is created,
`resolveWorkflowSettings()` resolves the full precedence chain and persists the
effective values as a `WorkflowSettingsSnapshot` in the durable
`autoreport/workflow` event; execution reads the snapshot, so later settings
changes never mutate an in-flight report. Project-scoped language selection is
preserved: `/report-init [--language latex|typst]` updates project settings and
materializes missing resources for that language without deleting the other
backend's files; both `Report/main.tex` and `Report/main.typ` may coexist with
`project.reportLanguage` authoritative.

Fixed authorization stays non-configurable (no allowNetwork/disableRoleIsolation
surface); AutoReport policy may only narrow DSH capabilities. Specialist model
reuses DSH routing entirely: children inherit Main by default with one optional
AutoReport-level specialist override.

### 2.15 Direct human conversation vs workflow delegation (rev 7)

Specialists remain continuable children of MAIN under DSH's parent-owned
continuation contract; humans talk to them through stock DSH subagent surfaces
(list/history/prompt/interrupt) with no parallel transport. The domain invariant
is explicit:

```text
conversation state != workflow task state
```

Human follow-ups preserve role context and role-authorized file access (guards
key on child session identity regardless of message source), but must not create,
complete, or mutate task/delegation state unless the message carries an active
workflow delegation context. Every specialist persona carries this rule verbatim;
MAIN's persona documents that specialists also answer humans directly.

### 2.16 Disposition of the sixteen-point integration review (rev 7)

Every point of the post-implementation architecture review, with its disposition
and where it lives in the codebase:

| # | Point | Disposition |
|---|---|---|
| 1 | Opt-in preset as mode switch | **By design** — installer only adds `autoreport-main` to `$DSH_HOME/.agent-presets`; deployment default preset and ordinary `standard` sessions untouched; no global `enabled` flag (PLAN §2.1) |
| 2 | DSH-owned vs AutoReport-owned settings split | **Implemented** — `src/settings.ts`; composition `Config` reduced to defaults; user-settings schema ready (`AUTO_REPORT_USER_SETTINGS_SCHEMA`) |
| 3 | Plugin config = defaults, not live workflow inputs | **Implemented** — fields renamed `defaultReportLanguage`/`defaultLatexEngine`/`defaultPythonEnv`/`specialistModel`; consumers read snapshots |
| 4 | Project-scoped language selection | **Implemented** — external `<dshHome>/autoreport/<workspaceId>/project.json`; concurrent projects supported |
| 5 | Persist resolved settings in workflow snapshot | **Implemented** — `WorkflowSettingsSnapshot` in `autoreport/workflow` payload (schema version 2); `resolveWorkflowSettings()` precedence chain |
| 6 | `/report-init --language latex\|typst` | **Implemented** — updates project settings + materializes missing resources only; other backend files never deleted |
| 7 | Non-configurable authorization/execution policy | **By design** — fixed role table + immutable `network:'deny'`, no broadening knobs exposed |
| 8 | Reuse DSH provider infrastructure | **Implemented** — specialists inherit Main route by default; single optional AutoReport-level specialist override (`reasoningEffort` carried in config but not forwarded: DSH `AgentOptions` accepts provider/model/maxTokens only) |
| 9 | Web settings card via plugin settings seam | **Deferred** — DSH's `SettingsProvider.register` is in-tree but not linked out-of-tree; namespace registration deferred until `@deepseek-ai/dsh-settings` becomes a dependency; documented in README |
| 10 | Continuable children for four specialists | **Implemented** — one durable child per role, reserve→start→markActive protocol |
| 11 | Direct human conversations with specialists | **Supported** — stock DSH subagent surfaces; no parallel transport |
| 12 | Conversation ≠ delegation invariant | **Documented** — PLAN §2.15; enforced by observer correlation on `(task_id, revision)` context |
| 13 | Specialist prompt rule | **Implemented** — rule present exactly once in each specialist persona; duplicate removed from Common.md |
| 14 | Role permissions unchanged by human turns | **Enforced** — guard keys on child session identity regardless of message source |
| 15 | Parent-owned continuation semantics | **Reused** — DSH continuation contract untouched; no independent specialist lifecycle |
| 16 | Strictly scoped compatibility hooks | **Implemented** — report router falls back to stock `installReportTool` for non-AutoReport children; verified by keyless router tests |

## 3. Testing and acceptance

### Keyless unit tests

- Fixed role/task/delegation protocol validation, including stale revision rejection.
- Role-binding reservation, synchronous registry updates, start failure, and resume.
- Parent→child `startContinuable`/`followup` acknowledgement semantics.
- Replacement `report_workflow` schema for AutoReport specialists, stock `report` fallback
  for ordinary DSH children, and no duplicate setup registration.
- Duplicate, malformed, missing, and stale report handling.
- Role write matrix across filesystem, edit, delete, patch, compile, and execution tools.
- Explicit `cwd`/readable/writable policy resolution.
- Artifact filtering, bounded traversal, symlink handling, and external manifest projection.
- Create-missing-only materialization, including `Data/Processed/` and the full
  `REQUIRED_DIRS` set, model-route resolution, and config validation.
- Cold load of a session log containing `autoreport/*` events, with and without the plugin;
  plugin-present folding recovers task/role/artifact state and stock DSH skips unknown
  ignorable records safely.
- Direct `Session.append(..., { ignorable: true })` writer/persistence tests from the DSH
  compatibility patch.
- Unsupported-platform network fail-closed behavior.
- Process-mediated write of `Data/<raw>` via Data Analysis `report_exec` is denied.

Recovery acceptance (keyless):

- **Compaction safety** — populate task/checklist state on a long-running specialist task,
  trigger compaction, verify task/role/artifact projections are unchanged and the agent can
  continue remaining steps from state + workspace only.
- **Child recreation safety** — produce intermediate files under a running delegation,
  force the child unresumable, rebind the role to a new reserved child id, and verify: same
  role assignment, same unfinished task, old child id denied by the guard, new child
  authorized before first tool call, work continues correctly.
- **No hidden recovery dependency** — recover with surface messages removed/shadowed (and a
  fresh child seeded only with role + task briefing) and verify continuation succeeds using
  only `autoreport/*` state plus workspace files; no memory store, injected summary, or
  conversation reconstruction exists anywhere in the flow.

### Keyless assembled smokes

- Install the preset under `$DSH_HOME/.agent-presets` before booting the real Loader
  composition; verify the original shipped roster remains present.
- Select `autoreport-main`; verify Main tools and absence of generic delegation, shell,
  compile, and stock report tools.
- Provision a child before `startContinuable`; verify role guard authorization from the
  first child tool call.
- Verify child persona, role-routed `report_workflow`, ordinary-child stock-report fallback,
  recursion restriction, and stale delegation report rejection.
- Verify AutoReport skills are visible only inside the preset scope.
- Run the first report turn and `/report-init` in a temporary workspace; verify idempotent
  initialization and every resource.
- Attempt cross-role filesystem/process writes and verify actual denial.
- Run a harmless report process and verify localhost network isolation.
- Verify manifests appear under the DSH home cache after fs and process mutations without any
  agent manifest call, and that compiler intermediates are filtered.

### Real API milestone

Only after all keyless acceptance tests pass, use OpenRouter `stealth/ox-alpha` to drive:
initialization → Main task creation/dispatch → Theory/Data/Plotting continuations → Report
compilation. Assert durable events, files, external manifests, write denials, and PDF output;
never accept a model’s textual claim as evidence.

## 4. Delivery plan

| Branch | Content | Depends on |
|---|---|---|
| `dsh-ignorable-append` | First-party DSH append-options seam, `ignorable:true` writer/persistence tests, pinned dependency update | — |
| `scaffold` | package, plugin rows, user-preset installer, global report-router wiring, README, test harness | dsh-ignorable-append |
| `workflow-state` | role reservation/registry, SessionEventMap events/projections, task tool, revision protocol, local waiters | scaffold |
| `roles-delegation` | Main preset, fixed personas, thin `send_to_agent` with wait modes, continuable report router | scaffold, workflow-state |
| `execution-policy` | actual mutation guard, explicit execution policy, `report_exec` over ctx.subprocess, Linux/macOS network isolation and smokes | scaffold, workflow-state |
| `workspace-assets` | startup `ensureInitialized`, `/report-init`, resource materializer, bundled assets and preset-scoped skills | scaffold |
| `compile-manifests` | Report-only compiler, automatic artifact observer, AutoReport filtering, external manifest projection | execution-policy, workspace-assets, workflow-state |
| `integration-e2e` | assembled keyless smokes, cold-load tests, OpenRouter configuration/e2e, acceptance gates | all previous |

Merge order is `dsh-ignorable-append` → `scaffold` → parallel `workflow-state`/
`workspace-assets` → `execution-policy` and `roles-delegation` → `compile-manifests` →
`integration-e2e`. `execution-policy` is not parallel with `workflow-state`: the mutation
guard reads the role table. The coordinator merges each branch after focused tests pass.
Integration points are role binding between workflow-state/execution-policy/roles-delegation,
report routing between workflow-state/roles-delegation, and artifact paths between
workspace-assets/compile-manifests.

## 5. Risks and gates

1. **Append compatibility**: the DSH `Session.append(..., { ignorable: true })` patch is a
   prerequisite; cold-load tests with and without the plugin must pass before domain work.
2. **Reserved child lifecycle**: role-binding reservation and synchronous registry update
   must authorize the child before its first tool call; failed provisioning must revoke it.
3. **Report correlation**: every report must carry task id and delegation revision; stale
   reports must be retained as evidence without changing current task state.
4. **Global report routing**: exactly one child-report router must select AutoReport or stock
   reporting by pre-provisioned role; a keyless child catalog test must prove no bypass or
   duplicate registration.
5. **User preset installation**: materialize under `$DSH_HOME/.agent-presets` before roster
   discovery; do not rely on a dynamic roots concat or late runtime write.
6. **OS execution isolation**: no platform is supported until writable roots and localhost
   network denial are keylessly demonstrated. Unsupported environments fail closed.
7. **Tectonic cache behavior**: no compiler may widen network policy; missing local resources
   cause failure.
8. **Manifest completeness**: filesystem and process-mediated writes need separate tests;
   unknown process changes must be represented as unknown, never omitted.
9. **DSH pre-release churn**: pin the harness checkout used for development and update only
   through focused compatibility changes.
10. **Blocking delegation**: `wait:true` must wait on AutoReport delegation state, not the
    parent’s next model step; timeout and settlement wake the local waiter without another
    message queue. Waiters are never persisted; durable phases answer why work is waiting.
11. **Recovery inputs**: continuation after compaction/recreation/restart may read only
    `autoreport/*` projections plus workspace files via normal tools; any design drift toward
    memory layers or prompt-injected summaries is rejected in review.
12. **Prompt migration**: retain AutoReport quality gates while translating Rust-CLI tool
    names and generic coordination instructions to DSH report tools.

## 6. Implementation status (as of integration-e2e merge)

All planned phases are implemented and merged to `main`; 172 keyless tests pass
(plus one self-skipping real-API e2e) and the build is clean.

| Phase | Branch(es) | Delivered |
|---|---|---|
| DSH compatibility patch | harness `feat/session-append-ignorable` | `Session.append(..., { ignorable: true })` writer surface + cold-load tests |
| Scaffold | `scaffold` | package, absolute harness links, user-preset installer, overlay template, keyless boot proof |
| Workflow state | `workflow-state` | role table, `autoreport/*` events + folds, RoleRegistry, waiters, `report_task` tool |
| Workspace assets | `workspace-assets` | REQUIRED_DIRS init, create-missing-only materializer, `/report-init`, bundled skills |
| Execution policy | `execution-policy` | mutation guard matrix, seatbelt/bwrap isolation, `report_exec`, live macOS network-denial smoke |
| Roles & delegation | `roles-delegation` | personas, Main preset, `send_to_agent`, `report_workflow`, global report router, observer |
| Compile & manifests | `compile-manifests` ×3 lanes | `compile_report`, artifact policy ported from manifest.rs, observer, external manifest projection |
| Settings layering (rev 7) | `settings-layering` | precedence resolution, project/user settings stores, durable workflow snapshots |
| Integration & e2e | `integration-e2e` | wiring fixes, assembled smokes, installer boot smoke, OpenRouter config + self-skipping e2e |

Deferred (documented in README): `autoreport` settings namespace card (needs
`@deepseek-ai/dsh-settings` out-of-tree), Windows support, MinerU network path,
agent-editable manifest annotations.
