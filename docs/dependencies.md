# Dependency wiring

AutoReportDSH develops against a **pinned local harness checkout** (dsh is pre-release and
iterating rapidly; PLAN.md risk 9).

## Pinned harness state

- Checkout: sibling directory `../deepseek-harness` (all `link:` specifiers are
  repository-relative so clean clones, CI, and other machines resolve them)
- Public upstream base: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
  (`dsh-v0.1.1-rc.2`)
- Local development Harness: the sibling checkout with the two CI patches applied
  (ignorable-append plus per-session `sandbox/workspace-root`)

## Compatibility seams

AutoReportDSH requires:

1. `Session.append(type, data, { ignorable: true })` so stock readers skip
   out-of-tree `autoreport/*` records during cold load.
2. Per-session sandbox writable-root override (`sandbox/workspace-root`), with
   bash/fs navigation remaining on `session.header.cwd`.

Until the upstream DSH release range contains both, CI checks out the public
upstream base and applies, in order:

1. [`patches/deepseek-harness-ignorable-append.patch`](../patches/deepseek-harness-ignorable-append.patch)
2. [`patches/deepseek-harness-sandbox-workspace-root.patch`](../patches/deepseek-harness-sandbox-workspace-root.patch)

Local source development should use the matching patched Harness checkout.

`@deepseek-ai/dsh-settings` is already present in the public base and supplies the AutoReport
user-settings namespace. Once the append API and sandbox workspace-root override are released
upstream, remove the patch steps, update the source-install requirement, and pin the published
compatibility version together.

## Wiring decision

Dependencies use pnpm `link:` entries pointing into the harness checkout rather than npm
installs, because:

1. The verified API surfaces (continuation specs, tool guard, session append) are the local
   sources, not the published rc artifacts.
2. The compatibility patches above can only be consumed locally until upstreamed.
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

All names verified against each linked package's `package.json`; exports map `. -> ./lib/index.js`
with types at `./lib/types/index.d.ts`.
