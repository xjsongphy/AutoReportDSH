# Dependency wiring

AutoReportDSH develops against a **pinned local harness checkout** (dsh is pre-release and
iterating rapidly; PLAN.md risk 9).

## Pinned harness state

- Checkout: sibling directory `../deepseek-harness` (all `link:` specifiers are
  repository-relative so clean clones, CI, and other machines resolve them)
- Public upstream base: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
  (`dsh-v0.1.1-rc.2`)
- Local development Harness: the sibling checkout with the source-test shim applied
  for per-session `sandbox/workspace-root`

## Compatibility seams

The file under `patches/` is a temporary source-test shim for the pinned
development checkout; it is not DSH's plugin distribution mechanism. DSH's
supported plugin path is an npm bundle declaring `dsh.bundle.patch` and
installed with `dsh plugin --profile <name> add <package>`. The source installer
does not apply this shim or modify DSH. Until the workspace-root API is
upstreamed in a documented release, a user-facing install must use a DSH build
that already implements it; host activation now fails loudly when the running
sandbox policy cannot consume `sandbox/workspace-root`.

At host-plugin activation, AutoReport registers its own session event names in
the running DSH process's session vocabulary. This is an in-process operation:
it does not edit DSH files, replace the Agent Loop, monkey-patch `Session`, or
change stock DSH sessions. It is needed because the current DSH release has no
public third-party event-registration API. The registration includes
`sandbox/workspace-root`, which AutoReport uses for per-role writable roots.

The source checkout still uses this local shim so its tests can exercise the
sandbox-root API directly. End users install the plugin through the normal DSH
profile path and do not clone or patch DSH.

`@deepseek-ai/dsh-settings` is already present in the public base and supplies the AutoReport
user-settings namespace. Once the sandbox workspace-root override is released upstream, update
the plugin's published compatibility range and remove the CI-only patch file.

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
