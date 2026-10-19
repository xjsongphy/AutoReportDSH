# Native subagent navigation and Agent Teams coexistence (DSH RC2)

AutoReport keeps its own report workflow. Child conversations use DSH's native
subagent UI: the count trigger next to the parent conversation title opens the
catalog, and its rows open child chats or the right-hand conversation pane.
The native list shows activity, token use, and elapsed time.

Residents are created directly through the Agent factory. That bypasses the
provider code which normally publishes two facts: the child `subagent/descriptor`
and the parent's `subagent/catalog`. AutoReport now publishes both. Existing
residents are backfilled when their Main Agent restores them; no new report or
replacement child is needed. Repeated restores preserve existing catalog rows.
A process running old plugin code must be restarted to load this fix. An old
conversation must be resumed so its existing resident bindings are restored.

## Official experimental Agent Teams

Enabling the official Team profile in RC2 does not select a separate preset:
its Team tool plugin installs tools and `team:policy` in each root Agent's own
scope. AutoReport's preset restriction masks inherited tools, not tools another
plugin registers directly on that same Agent. This can expose a second tool
surface and prompt policy or fail AutoReport's exact tool-surface validation.
AutoReport's execution guard rejects Team tools for owned report sessions and
leaves ordinary sessions unchanged, but that backstop is not full coexistence.

Keep the experimental Agent Teams profile disabled when using AutoReport on
RC2. Changing to the AutoReport preset alone is not an isolation guarantee.
This navigation fix neither enables Team nor replaces AutoReport's task board.

## Verification

Regression checks cover catalog identity, idempotence, preserving provider
entries, rejecting unrelated/unclassified children, restoration, and the native
`subagentCatalog` projection produced by a real DSH Subagent runtime. Separate
checks exercise Team tool execution boundaries for Main, a specialist, and an
ordinary session. They do not claim live browser or full Team-plugin acceptance.
