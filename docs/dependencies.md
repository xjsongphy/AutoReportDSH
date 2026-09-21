# Dependency wiring

AutoReportDSH develops against a **pinned local harness checkout** (dsh is pre-release and
iterating rapidly; PLAN.md risk 9). The pin means **"verified against", not
"exclusive"**: the plugin probes the seams it depends on and degrades gracefully
where it can, so other dsh builds usually work — activation prints which pair
is running (`src/dsh-version.ts`) instead of refusing.

## Pinned harness state

- Checkout: sibling directory `../deepseek-harness` (all `link:` specifiers are
  repository-relative so clean clones, CI, and other machines resolve them)
- Verified base: `6b1808f432` (`release(dsh): 0.1.6-alpha.2`, upstream
  `master`) — the plugin targets the LATEST upstream release, not the retired
  `dsh-v0.1.1-rc.2` base it was originally written against. CI runs its full
  suite against exactly this commit; the `Canary` workflow re-runs the suite
  nightly against upstream `master` to surface API drift early.
- Local development Harness: the sibling checkout sits on the upstream release
  commit (previously it carried a cherry-picked ignorable-append candidate;
  that upstream change is NOT in alpha.2, so the marker probe degrades to the
  in-process vocabulary mechanism — `Session.append` ignores the extra
  argument and `probeIgnorableMarker` reports marker support by observation).
  No source shim, no per-session sandbox-root patch.

## Compatibility seams

Per-role writable roots no longer require any DSH modification. The host plugin
wraps the running `ctx.sandboxPolicy` singleton's `resolve` in its own memory
(`src/policy/sandbox-override.ts`): AutoReport-owned sessions resolve their role
directory as the `workspace-write` root, and every other session resolves
byte-identical to stock. Activation self-checks the wrap and fails loud when the
host refuses it, so a role can never silently run on the full experiment root.
The former `patches/deepseek-harness-sandbox-workspace-root.patch` source shim
and the `sandbox/workspace-root` session event are retired.

Third-party session events are loadable through two independent mechanisms, and
host activation measures both (`src/session-events.ts`):

1. **In-process vocabulary registration.** `KNOWN_SESSION_EVENT_TYPES` is a
   runtime-mutable `Set`, and the reader consults that same object, so
   registering the `autoreport/*` names at activation makes every later load in
   this process accept them. Verified against the stock release installed on the
   development machine (0.1.5-rc.1): the unregistered log is refused, and the
   same log loads once registered. Nothing is persisted — a log opened without
   this plugin loaded still refuses.
2. **The persisted `ignorable` marker.** Records written with
   `{ ignorable: true }` are self-describing and loadable anywhere, including
   future builds and installations without the plugin. This is upstream's own
   documented compatibility mechanism; the write-side option is not in a stock
   release yet, so activation probes it and warns when it is missing.

Activation fails loud only when NEITHER mechanism exists — the one state where
the plugin would silently write logs no reader can open. The write-side option
is a cherry-picked commit in the development checkout and remains the first
upstream PR candidate; landing it upgrades every deployment from
"loadable where the plugin loads" to "loadable anywhere".

Child-scoped composition rides `agent/created` plus `agent.ctx.inject`; the
former `ctx.subagents.registerContinuableSetup` seam was removed upstream along
with the standalone stock report tool, whose role is now played by adjacent-agent
`send_message` and the host-only prompt delivery symbol.

`@deepseek-ai/dsh-settings` supplies the AutoReport user-settings namespace
through `ctx.settings.installSection`. Once both upstream candidates land (the
append option, and any future first-class per-session root override), update the
plugin's published compatibility range and delete this section's dev-only notes.

## Wiring decision

Dependencies use pnpm `link:` entries pointing into the harness checkout rather than npm
installs, because:

1. The verified API surfaces (continuation specs, tool guard, session append) are the local
   sources, not the published rc artifacts.
2. The compatibility shim above can only be consumed locally until upstreamed.
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
| `@deepseek-ai/dsh-client-runtime` | `../deepseek-harness/packages/client/runtime` |
| `@deepseek-ai/dsh-client-locale` | `../deepseek-harness/packages/client/locale` |
| `@deepseek-ai/dsh-client-ui-settings` | `../deepseek-harness/packages/client/ui-settings` |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | `../deepseek-harness/packages/client/ui-settings-plugins` |
| `@deepseek-ai/dsh-client-ui-slots` | `../deepseek-harness/packages/client/ui-slots` |
| `@deepseek-ai/dsh-client-connection` | `../deepseek-harness/packages/client/connection` |
| `@deepseek-ai/dsh-api-remotes` | `../deepseek-harness/packages/api/remotes` |

All names verified against each linked package's `package.json`; exports map `. -> ./lib/index.js`
with types at `./lib/types/index.d.ts`.
