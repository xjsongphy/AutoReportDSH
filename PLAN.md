# AutoReportDSH — Design Plan (rev 4)

Migrate the AutoReportCLI physics-report workflow into a DeepSeek Harness (`dsh`) plugin.
The scope contract is `../autoreportcli/docs/own-features.md`: preserve AutoReport-owned
domain semantics while reusing DSH infrastructure wherever its contract is equivalent.

This revision incorporates the Rev 3 architecture review. The key boundary is:

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

No existing community dsh plugin covers this physics-report domain.

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
│   └── skills.ts                       # preset-scoped bundled skill registration
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

The overlay adds the preset directory to the `agent-presets` row. Because a patch replaces a
row’s entire config, it must merge the existing resolved `roots` array rather than replace
it. The implementation follows the verified profile-boot pattern in
`deepseek-harness/apps/cli/src/profile-boot.ts:159-165` and includes a roster test. The
plugin does not change the deployment default preset; users select `autoreport-main`.

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
| PLOTTING | one continuable child | `Plots/` | workspace | `Plots/Fig/`, `Plots/Scripts/` |
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
  phase: 'reserved' | 'active' | 'failed'
}
```

The synchronous `RoleRegistry` is updated before `startContinuable()`. A failed start is
marked `failed`; a successful accepted start is marked `active`. The guard permits only an
active binding, and unknown/unbound agents fail closed. Resume uses the same durable child
id and registry projection.

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
4. Returns an accepted-message acknowledgement. It never waits for child completion.

The authoritative domain identity is `(task_id, delegation_revision)`; a separate
`delegation_id` may be used as its opaque durable key. DSH `MessageId` is recorded but is
not used as the domain attempt identity.

### 2.5 Replacement structured child report

The stock child-facing `report` tool is not mounted. The AutoReport child setup registers
only `report_workflow`, following the same `registerContinuableSetup()` → child-scoped
`tools.register()` → `ctx.subagents.reportFrom()` pattern as DSH’s stock adapter.

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
- `autoreport/role-binding` — pre-provisioned role-to-child identity and phase;
- `autoreport/task` — complete task snapshot: stable id, subject, role, dependencies,
  status, revision, blocked reason, and workspace scopes;
- `autoreport/delegation` — complete delegation snapshot: task id, delegation revision,
  role, child session, accepted message id, phase, and latest report outcome;
- `autoreport/artifact` — complete artifact snapshot emitted by the runtime observer.

Events are append-only durable facts and projections fold them from the session log under
DSH’s `SessionEventMap` and model-visible-is-logged rules. The report task tool exposes
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
passed to an isolation backend. The backend enforces writable roots and network denial at
the process boundary, not by inspecting shell text or relying on persona instructions.

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

Initialization creates:

```text
Data/
References/
Theory/
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

### 2.14 Configuration

Validated plugin configuration:

- `reportLanguage: 'latex' | 'typst'` (default `latex`);
- `latexEngine: 'latexmk' | 'tectonic'` (default `latexmk`);
- optional `pythonEnv`, checked before use and passed only to report execution;
- `workspaceRoot`, defaulting to the session cwd;
- optional `specialistRoute` (`provider`, `model`);
- execution policy with network denial as the immutable v1 default.

## 3. Testing and acceptance

### Keyless unit tests

- Fixed role/task/delegation protocol validation, including stale revision rejection.
- Role-binding reservation, synchronous registry updates, start failure, and resume.
- Parent→child `startContinuable`/`followup` acknowledgement semantics.
- Replacement `report_workflow` schema and absence of stock `report` in child catalogs.
- Duplicate, malformed, missing, and stale report handling.
- Role write matrix across filesystem, edit, delete, patch, compile, and execution tools.
- Explicit `cwd`/readable/writable policy resolution.
- Artifact filtering, bounded traversal, symlink handling, and external manifest projection.
- Create-missing-only materialization, model-route resolution, and config validation.
- Unsupported-platform network fail-closed behavior.

### Keyless assembled smokes

- Boot the real Loader composition with the preset-root merge.
- Verify the original preset roster remains present.
- Select `autoreport-main`; verify Main tools and absence of generic delegation, shell,
  compile, and stock report tools.
- Provision a child before `startContinuable`; verify role guard authorization from the
  first child tool call.
- Verify child persona, replacement `report_workflow`, recursion restriction, and stale
  delegation report rejection.
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
| `scaffold` | package, plugin rows, preset-root merge, stock-report replacement wiring, README, test harness | — |
| `workflow-state` | role table, role reservation/registry, SessionEventMap events/projections, task tool, revision protocol | scaffold |
| `roles-delegation` | Main preset, fixed personas, thin `send_to_agent`, continuable child setup, replacement report tool | scaffold, workflow-state |
| `execution-policy` | actual mutation guard, explicit execution policy, `report_exec` over ctx.subprocess, Linux/macOS network isolation and smokes | scaffold, workflow-state |
| `workspace-assets` | startup `ensureInitialized`, `/report-init`, resource materializer, bundled assets and preset-scoped skills | scaffold |
| `compile-manifests` | Report-only compiler, automatic artifact observer, AutoReport filtering, external manifest projection | execution-policy, workspace-assets, workflow-state |
| `integration-e2e` | assembled keyless smokes, OpenRouter configuration/e2e, acceptance gates | all previous |

Merge order is `scaffold` → parallel `workflow-state`/`execution-policy`/`workspace-assets` →
`roles-delegation` and `compile-manifests` → `integration-e2e`. The coordinator merges each
branch after focused tests pass. Integration points are role binding between
workflow-state/execution-policy/roles-delegation and artifact paths between
workspace-assets/compile-manifests.

## 5. Risks and gates

1. **Reserved child lifecycle**: role-binding reservation, registry update, and
   `startContinuable({ childId })` must remain one fail-closed provisioning protocol.
2. **Report correlation**: every report must carry task id and delegation revision; stale
   reports must be retained as evidence without changing current task state.
3. **Stock report replacement**: profile composition must not register the generic report
   setup alongside `report_workflow`; a keyless child catalog test is mandatory.
4. **Out-of-tree preset resolution**: verify module resolution inside external
   `agent.cordis.yml`; use the profile resolver manifest or explicit module paths as required.
5. **OS execution isolation**: no platform is declared supported until writable roots and
   localhost network denial are keylessly demonstrated. Unsupported environments fail closed.
6. **Tectonic cache behavior**: no compiler may widen network policy; missing local resources
   cause failure.
7. **Manifest completeness**: filesystem and process-mediated writes need separate tests;
   unknown process changes must be represented as unknown, never omitted.
8. **DSH pre-release churn**: pin the harness checkout used for development and update only
   through focused compatibility changes.
9. **Prompt migration**: retain AutoReport quality gates while translating Rust-CLI tool names
   and generic coordination instructions to DSH report tools.
