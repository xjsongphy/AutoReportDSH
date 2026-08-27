# Dependency wiring

AutoReportDSH develops against a **pinned local harness checkout** (dsh is pre-release and
iterating rapidly; PLAN.md risk 9).

## Pinned harness state

- Checkout: sibling directory `../deepseek-harness` (all `link:` specifiers are
  repository-relative so clean clones, CI, and other machines resolve them)
- Commit at scaffold time: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
  (`Merge pull request #2908 from deepseek-harness/release/dsh-0.1.1-rc.2`)
- Built: full `pnpm run build` completed successfully on this commit.

## Pending harness patch

`workflow-state` depends on a first-party DSH compatibility change adding an append-options
seam so non-surface events can be written as
`session.append(type, data, { ignorable: true })` — the marker stock readers need to skip
out-of-tree `autoreport/*` records on cold load instead of refusing the session
(PLAN.md §2.6 persistence gate). Branch: `feat/session-append-ignorable`. This repo pins the
harness commit it consumes; update both together when the patch merges.

## Wiring decision

Dependencies use pnpm `link:` entries pointing into the harness checkout rather than npm
installs, because:

1. The verified API surfaces (continuation specs, tool guard, session append) are the local
   sources, not the published rc artifacts.
2. The ignorable-append patch above can only be consumed locally until upstreamed.
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
| `@deepseek-ai/dsh-subprocess` | `../deepseek-harness/packages/subprocess/subprocess` |
| `@deepseek-ai/dsh-home-paths` | `../deepseek-harness/packages/util/home-paths` |
| `@deepseek-ai/dsh-brand` | `../deepseek-harness/packages/util/brand` |

All names verified against each linked package's `package.json`; exports map `. -> ./lib/index.js`
with types at `./lib/types/index.d.ts`.
