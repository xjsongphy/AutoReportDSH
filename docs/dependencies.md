# Dependency wiring

AutoReportDSH develops against a **pinned local harness checkout** (dsh is pre-release and
iterating rapidly; `PLAN.md` §5 risk 9). The pin means **"verified against", not
"exclusive"**: the plugin probes the seams it depends on and degrades gracefully
where it can, so other dsh builds usually work — activation prints which pair
is running (`src/dsh-version.ts`) instead of refusing.

This file is the dependency authority for the repo: `README.md`, `README.zh.md`,
`docs/own-features.md`, `.github/workflows/ci.yml`, and `src/host.ts` all point
here for the pin rather than restating it.

## Pinned harness state

- Checkout: sibling directory `../deepseek-harness` (all `link:` specifiers are
  repository-relative so clean clones, CI, and other machines resolve them)
- Verified base: `6b1808f432` (`release(dsh): 0.1.6-alpha.2`, upstream
  `master`) — the plugin targets the LATEST upstream release, not the retired
  `dsh-v0.1.1-rc.2` base it was originally written against. CI runs its full
  suite against exactly this commit; the `Canary` workflow re-runs the suite
  nightly against upstream `master` to surface API drift early.
- Local development Harness: the sibling checkout sits on the upstream release
  commit. No source shim, no per-session sandbox-root patch, and no
  append-option dependency — the plugin writes only its own log, so the
  `ignorable` marker is no longer needed by anything.

## Compatibility seams

Per-role writable roots no longer require any DSH modification. The host plugin
wraps the running `ctx.sandboxPolicy` singleton's `resolve` in its own memory
(`src/policy/sandbox-override.ts`): AutoReport-owned sessions resolve their role
directory as the `workspace-write` root, and every other session resolves
byte-identical to stock. Activation self-checks the wrap and fails loud when the
host refuses it, so a role can never silently run on the full experiment root.
The former `patches/deepseek-harness-sandbox-workspace-root.patch` source shim
and the `sandbox/workspace-root` session event are retired.

**Session-log compatibility is no longer a compatibility seam, because the
plugin puts nothing of its own in the session log.** AutoReport's durable
records live in a log the plugin owns:
`<home>/autoreport/<workspaceId>/workflow/<session id>/session.jsonl`
(`src/workflow/store.ts`) — under the harness home, keyed by workspace, exactly
where AutoReportCLI kept its per-workspace state. A session log this plugin
produced therefore contains
only DSH's own event types, and every harness build — plain, current, or future,
with or without the plugin — reads it unmodified.

This replaced two mechanisms that both depended on the host:

- **The persisted `ignorable` marker** is unreachable on 0.1.6-alpha.2:
  `Session.append` now accepts options only for surface event types
  (`...opts: T extends SurfaceEventType ? [SurfaceIntent<T>] : []`), and
  `AppendOptions` no longer exists. All `autoreport/*` types are non-surface.
- **In-process vocabulary registration** (`KNOWN_SESSION_EVENT_TYPES` is a
  runtime-mutable `Set`) still works, but `known-event-types.ts` states upstream
  rejected event-name registration by design: it "does not classify omission
  safety and would make reads composition-dependent". Relying on it would mean
  depending on a mutable set the host author has declared is not a mechanism.

The retired `src/session-events.ts` also carried a marker probe and a
fail-loud activation check; both are gone with the mechanism they guarded. See
`docs/own-features.md` for the log's layout, naming, and durability bounds.

Child-scoped composition rides `agent/created` plus `agent.ctx.inject`; the
former `ctx.subagents.registerContinuableSetup` seam was removed upstream along
with the standalone stock report tool, whose role is now played by adjacent-agent
`send_message` and the host-only prompt delivery symbol.

`@deepseek-ai/dsh-settings` supplies the AutoReport user-settings namespace
through `ctx.settings.installSection`.

The version the plugin is verified against has exactly one home,
`VERIFIED_DSH_VERSION` in `src/dsh-version.ts`. Activation compares the running
build against it and warns — never refuses — on a mismatch, and
`scripts/prepare-npm-package.mjs` reads that same constant to derive the
`^` range the publishable manifest declares for every `@deepseek-ai/dsh-*`
dependency. Two copies of this value is what let the published range drift to
the retired rc base once; there is now one.

Once a first-class per-session root override lands upstream, the wrap in
`src/policy/sandbox-override.ts` can be replaced by it and this section's
dev-only notes deleted.

## Wiring decision

Dependencies use pnpm `link:` entries pointing into the harness checkout rather than npm
installs, because:

1. The verified surfaces are the checked-out sources the pin names, not whatever a
   registry currently serves.
2. There is no compatibility shim to wait for: the sandbox-root seam is a runtime
   wrap over a service the host already publishes, so nothing here needs an
   upstream API before it can ship.
3. Linked package directories resolve their own workspace peers through the harness root
   `node_modules`, so no peer duplication is needed on our side.

Trade-off: the sibling checkout must stay at the pinned commit and built (`pnpm run build`);
typecheck here runs with `skipLibCheck` for the same reason the harness does (declarations
use explicit `.ts` specifiers and cross-package internals).

## Exact table

| Dependency | Linked path (relative to this repo) |
|---|---|
| `@deepseek-ai/cordis` | `../deepseek-harness/vendor/cordis` |
| `@deepseek-ai/schemastery` | `../deepseek-harness/vendor/schemastery` |
| `@deepseek-ai/dsh-session` | `../deepseek-harness/packages/core/session` |
| `@deepseek-ai/dsh-session-persistence` | `../deepseek-harness/packages/session/session-persistence` |
| `@deepseek-ai/dsh-session-projection` | `../deepseek-harness/packages/session/session-projection` |
| `@deepseek-ai/dsh-settings` | `../deepseek-harness/packages/settings/settings` |
| `@deepseek-ai/dsh-tools` | `../deepseek-harness/packages/core/tools` |
| `@deepseek-ai/dsh-agent` | `../deepseek-harness/packages/core/agent` |
| `@deepseek-ai/dsh-subagent` | `../deepseek-harness/packages/subagent/subagent` |
| `@deepseek-ai/dsh-llm` | `../deepseek-harness/packages/llm/llm` |
| `@deepseek-ai/dsh-system-prompt` | `../deepseek-harness/packages/core/system-prompt` |
| `@deepseek-ai/dsh-skill` | `../deepseek-harness/packages/skill/skill` |
| `@deepseek-ai/dsh-commands` | `../deepseek-harness/packages/interaction/commands` |
| `@deepseek-ai/dsh-sandbox-policy` | `../deepseek-harness/packages/sandbox/sandbox-policy` |
| `@deepseek-ai/dsh-shell-env` | `../deepseek-harness/packages/shell/shell-env` |
| `@deepseek-ai/dsh-subprocess` | `../deepseek-harness/packages/subprocess/subprocess` |
| `@deepseek-ai/dsh-home-paths` | `../deepseek-harness/packages/util/home-paths` |
| `@deepseek-ai/dsh-brand` | `../deepseek-harness/packages/util/brand` |

### Test-only linked packages

| Dependency | Linked path (relative to this repo) |
|---|---|
| `@deepseek-ai/dsh-tool-bash` | `../deepseek-harness/packages/shell/tool-bash` |
| `@deepseek-ai/dsh-bash-local` | `../deepseek-harness/packages/shell/bash-local` |
| `@deepseek-ai/dsh-bash-sandbox` | `../deepseek-harness/packages/shell/bash-sandbox` |
| `@deepseek-ai/dsh-shell` | `../deepseek-harness/packages/shell/shell` |
| `@deepseek-ai/dsh-subprocess-local` | `../deepseek-harness/packages/subprocess/subprocess-local` |
| `@deepseek-ai/dsh-sandbox` | `../deepseek-harness/packages/sandbox/sandbox` |
| `@deepseek-ai/dsh-sandbox-local` | `../deepseek-harness/packages/sandbox/sandbox-local` |
| `@deepseek-ai/dsh-client-locale` | `../deepseek-harness/packages/client/locale` |
| `@deepseek-ai/dsh-client-store` | `../deepseek-harness/packages/client/store` |
| `@deepseek-ai/dsh-client-ui-renderer` | `../deepseek-harness/packages/client/ui-renderer` |
| `@deepseek-ai/dsh-client-ui-conversation` | `../deepseek-harness/packages/client/ui-conversation` |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | `../deepseek-harness/packages/client/ui-plugin-manager` |
| `@deepseek-ai/dsh-client-ui-settings` | `../deepseek-harness/packages/client/ui-settings` |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | `../deepseek-harness/packages/client/ui-settings-plugins` |
| `@deepseek-ai/dsh-client-ui-slots` | `../deepseek-harness/packages/client/ui-slots` |
| `@deepseek-ai/dsh-client-ui-primitives` | `../deepseek-harness/packages/client/ui-primitives` |
| `@deepseek-ai/dsh-client-ui-tool` | `../deepseek-harness/packages/client/ui-tool` |
| `@deepseek-ai/dsh-client-connection` | `../deepseek-harness/packages/client/connection` |
| `@deepseek-ai/dsh-api-remotes` | `../deepseek-harness/packages/api/remotes` |

All names verified against each linked package's `package.json`; exports map `. -> ./lib/index.js`
with types at `./lib/types/index.d.ts`.

Two of these are not test-only in the same sense. `dsh-client-ui-tool` is a TYPE-only import: it
owns the `tool.call.toolview` slot contract, but its own browser bundle carries CSS-module imports
this repo's esbuild pipeline cannot process, so no value may be imported from it.
`dsh-client-ui-primitives` is a web-shell PLATFORM module
(`packages/client/web/src/platform.ts`), so the two AutoReport tool rows require it at runtime and
`scripts/build-client.ts` keeps it external and asserts the emitted bundle does exactly that.
