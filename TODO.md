# AutoReportDSH backlog

This is the current implementation backlog, not a product-scope contract. See
[`docs/own-features.md`](docs/own-features.md) for supported behavior and
non-goals. The workflow source of truth is AutoReport's own durable record log
(`src/workflow/store.ts`, under the harness home keyed by workspace) — not DSH
session events, and not DSH `todo_write`.

## P0 — release blockers

- [x] **Remove mutable startup resource replacement.** The sync module, its manage
  table, its script, and the `$DSH_HOME/autoreport/resources` overlay are gone.
  Every managed document was already byte-identical to its committed copy and is
  now read only from `resources/`; the transforms that adapted upstream text are
  baked into the committed files. Acceptance: a clean, offline DSH home can create
  both LaTeX and Typst workspaces and provision a REPORT child; no network request
  occurs on normal plugin startup.
- [x] **Publish/pin the required DSH sandbox API.** Closed without an upstream
  API: the plugin wraps the running `ctx.sandboxPolicy.resolve` in memory
  (`src/policy/sandbox-override.ts`) and self-checks the wrap at activation,
  failing loud rather than silently running a role on the unconfined root. The
  `sandbox/workspace-root` event and `patches/` are gone, the verified base is
  the upstream release pin (`docs/dependencies.md`), and `Canary` re-runs the
  suite nightly against upstream `master`. Acceptance met by the fresh-install
  path plus `tests/sandbox-override.test.ts` and the live confinement suite.
- [x] **Make the workflow task board model-operable.** Done by a dedicated tool
  rather than by widening `send_to_agent`: `workflow_task` takes
  `read|update|cancel|reopen` and its description states it is the report task
  board, not DSH's generic todo tool. `tests/integration.host.test.ts` covers
  create (via `send_to_agent`) → update → cancel → reopen. Residual coverage gap
  moved to P1 below.

## P1 — verification and product readiness

- [x] **Read policy e2e.** The declared policy has two halves and only the write
  half had a probe. `tests/bash-confinement.live.test.ts` now reads every sibling
  role directory from one session and then shows that same session still cannot
  write outside its own root — the pair is what makes it evidence, since a read
  that passed under a dead sandbox would prove nothing. Verified live on macOS
  (Seatbelt). All four runners share the shape: reads unrestricted, writes
  granted only for the resolved root (`sandbox-local` profiles for
  bwrap/landlock/seatbelt, and the ACL write-grant SID on win32), so a role
  reads the experiment tree without gaining a write anywhere else.
- [ ] **`workflow_task` transition coverage.** Give the task board its own test
  file instead of relying on `tests/integration.host.test.ts`, and cover
  redispatch-after-reopen, which the P0 acceptance named and no case exercises.
- [ ] **Persistence/recovery acceptance.** Test process restart/rebind from a
  saved record log (`src/workflow/store.ts`), plus whatever DSH persistence load
  and compaction do to the session alongside it. Acceptance: unfinished
  task/delegation/manifest state survives a real reload and drives the same next
  action without conversation reconstruction. Note the target moved: these
  records no longer live in the DSH session log, so `tests/store.test.ts` covers
  read/write and torn-line tolerance but nothing about restart.
- [ ] **Windows role-isolation e2e.** The blanket `process.platform === 'win32'`
  skip is gone: the live suite now gates on sandbox usability alone, which on
  win32 already requires a working `bash -lc` *and* the windows-acl runner probe,
  and `dsh-bash-sandbox` has no platform gate of its own (it hands the resolved
  policy to `ctx.sandbox`, whose win32 rung is the ACL restricted-token runner).
  What remains is evidence, not code: one green Windows CI run that resolves a
  real role writable root through that runner. Acceptance: the confinement cases
  execute — not skip — on `windows-latest`.
- [ ] **Deployment/provider smoke.** Run the opt-in configured-route test on a
  maintained configured DSH home after each compatibility change.  Command:
  `AUTOREPORT_LIVE_TEST=1 AUTOREPORT_E2E_DSH_HOME=<home> pnpm vitest run tests/e2e/configured-route.e2e.test.ts`.

## Completed / intentionally not backlog

- `References/skills` is already registered in the AutoReport preset and
  role-bound children, with escaping symlinks rejected.
- `report_exec` and `compile_report` are intentionally removed; reports use
  DSH bash/pwsh plus scoped skills.
- AutoReportDSH has no generic agent graph, MCP/plugin marketplace, provider
  credential layer, native TUI, or browser-agent product surface.
