# AutoReportDSH backlog

This is the current implementation backlog, not a product-scope contract. See
[`docs/own-features.md`](docs/own-features.md) for supported behavior and
non-goals. The workflow source of truth is durable `autoreport/*` session
events, not DSH `todo_write`.

## P0 — release blockers

- [ ] **Remove mutable startup resource replacement.** Startup currently downloads
  skills/templates from remote `HEAD` and lets the overlay replace bundled
  prompts/skills. Make updates explicit and pin/verify revisions; bundle the
  last-known-good LaTeX compile skill and Typst assets.  Acceptance: a clean,
  offline DSH home can create both LaTeX and Typst workspaces and provision a
  REPORT child; no network request occurs on normal plugin startup.
- [ ] **Publish/pin the required DSH sandbox API.** The role policy depends on
  `sandbox/workspace-root`, while CI applies a source-only DSH patch.  Do not
  claim arbitrary `dsh` compatibility until the capability is upstreamed or
  the installer pins and verifies a compatible release.  Acceptance: a fresh
  documented install proves role-root confinement without an untracked sibling
  Harness patch.
- [ ] **Make the workflow task board model-operable.** `send_to_agent` creates
  empty-step tasks, but no Main tool updates the planned checklist or performs
  cancel/reopen.  Choose a dedicated AutoReport task tool or extend
  `send_to_agent`; do not accidentally substitute DSH's unrelated generic
  todo tool.  Acceptance: a Main session can create, update, cancel, reopen,
  and redispatch a durable task, with integration tests for each transition.

## P1 — verification and product readiness

- [ ] **Persistence/recovery acceptance.** Test actual DSH persistence load,
  compaction, and process restart/rebind from saved AutoReport session logs.
  Acceptance: unfinished task/delegation/manifest state survives a real reload
  and drives the same next action without conversation reconstruction.
- [ ] **Windows role-isolation e2e.** Add real `pwsh` allowed-write and
  cross-role-denial tests in Windows CI.  Acceptance: each role's writable
  root is enforced by the Windows executor, not only by ACL availability.
- [ ] **Read policy e2e.** Test that each specialist can read permitted shared
  workspace inputs while writes remain confined.  Acceptance: Linux/macOS and
  Windows coverage proves both halves of the declared policy.
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
