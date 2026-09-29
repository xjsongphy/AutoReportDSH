# Role filesystem, delivery, and cancellation decisions

Decision record updated 2026-09-27. This document records the chosen product
boundaries and the work needed to implement them. It does not claim that the
unfinished items below are already enforced.

## Guiding boundary

AutoReport derives each role's visible model-tool roster and workspace roots
from `rolePolicy()`. Known filesystem tools are guarded by role; DATA_ANALYSIS,
PLOTTING, and REPORT run foreground Bash inside a second OS filesystem view on
Linux/macOS. The view masks sibling workspaces and re-exposes only the role's
readable and writable workspace roots. If bubblewrap or Seatbelt cannot start,
the shell call fails closed. On Windows, those roles get foreground `pwsh`
with role-root workdirs, command/path preflight, and DSH's partial ACL write
sandbox. Windows process reads are not confined by readable roots.

## Decisions

### Directory discovery is named `list`

The AutoReport model-facing directory discovery tool is named `list`. It uses
DSH's filesystem capability `ctx.fs.listDir()` internally and remains an
AutoReport tool because AutoReport owns the role checks and product limits; it
is not a second implementation of directory I/O.

The tool must use DSH's filesystem provider for path resolution, containment,
metadata, symlink checks, and listing. It must not use Node filesystem calls in
the deployed provider-backed path. Keep the current product limits: names only,
depth at most 4, at most 512 entries, skip internal directories, and do not
follow listed symlinks. Resolve and check the requested root with
`ctx.fs.resolve()` and `ctx.fs.contains()`.

Provider details to preserve:

- `FsTarget.displayPath` may be a local absolute path, a relative display path,
  or a remote URI. Do not pass it to Node's `path.relative()` as if it were a
  host path. Construct workspace-relative output from the validated logical
  path components, or add a provider-owned relative-path operation.
- DSH's `lstat(path, opts?, signal?)` receives the abort signal as its third
  argument. Do not put it inside the `opts` object.
- Use the resolved child targets returned by `ctx.fs.listDir()` for containment and
  recursion. Treat target keys as opaque.

### Discovery, reads, and writes use separate role roots

`list` is bounded names-only discovery governed by `discoverableRoots`;
`read`, `read_image`, `grep`, and editor view are governed by `readableRoots`;
writes use `writableRoots`. MAIN can inventory the workspace and review
`Data/Processed/`, plots, and reports, while `Data/Raw/` remains names-only by
default. Tests cover role matrices, traversal, symlink escapes, missing paths,
and unaffected stock DSH sessions.

MAIN's broad read permission supports routing-level coverage and editorial
review, not technical reanalysis. The role guard grants these roots without a
workflow-phase check; MAIN's writable root remains `Outline/`.

This policy covers known DSH tools. The separate process wrapper carries the
same readable and writable roots into Python, compilers, and their descendants;
the shell parser remains defense in depth and is not the isolation boundary.

### Plotting visual review follows declared route capability

At each resident Plotting prompt assembly, use the provider/model snapshot that
the model-selection hook placed in the assembled prompt variables. If it is
absent, fall back to pending Session model selection, the latest request header,
then Agent options. Query `ctx.llm.resolveModelInfo()` for that exact route. Add
a prompt requirement to inspect each final figure with `read_image` only when
the model metadata explicitly declares `image` input and the scoped `read_image`
tool is available. An absent modality declaration is unknown, not proof of
image support; this metadata is the adapter's declared capability, not a live
probe of the remote endpoint. Cache results by provider/model and look up again
when the route changes.

When image input is unsupported or unknown, do not add a visual-review
requirement or a report to MAIN. The DSH `read_image` error itself identifies a
model that does not declare image input; rely on that tool feedback instead of
adding a persona fallback. Visual review supplements the numeric and script
checks; it does not replace them. The prompt condition is refreshed at each
assembly, so a route picker change affects the request whose prompt is being
assembled. The `read_image` tool continues to enforce the current route
independently.

### MAIN presents final deliverables

Only MAIN declares final files with DSH `present`, after a specialist reports
success. Restrict paths to the experiment workspace and to files approved by
the workflow's observed artifact/report state. The default deliverable is
`Report/main.pdf`; include source files only when useful or requested. Do not
present every intermediate plot or workspace file.

`present` records a reference to the current source file. It does not copy or
freeze file contents, so a later edit changes what the user opens. Never treat
the delivery record as an immutable artifact snapshot.

### Task cancellation stays behind `workflow_task`

MAIN cancels work through `workflow_task(action="cancel")`; do not expose a
generic `interrupt_agent` tool in the AutoReport preset. Cancellation stops the
current turn while preserving the specialist Session, role binding, and queued
inbox work so that the same specialist can continue later.

AutoReport resident specialists are created and resumed through the Agent
factory and held by AutoReport handles. DSH's `subagents.interrupt()` only
addresses activations registered with its continuation manager; it may accept
an absent target as a no-op. Implement cancellation through an exact
AutoReport-owned resident handle (or change the residency integration first),
not by assuming the generic DSH interrupt tool can see these Agents. A cancel
request is cooperative and may take time to reach quiescence.

### Search is provider-backed and bounded

Do not mount DSH's generic `glob`/`grep` tools directly for role-scoped search:
they execute packaged ripgrep through `ctx.subprocess`, outside `ctx.fs` path
authorization. AutoReport's `grep` uses `ctx.fs` streaming reads, checks each
file against role `readableRoots`, skips symlinks and internal metadata, and
caps depth, files, bytes, line previews, and matches. The generic DSH `glob` is
denied to AutoReport sessions; use role-scoped `list` for names-only discovery.

## Work order

| Priority | Work | Completion condition |
|---|---|---|
| P0 | Finish provider-backed `list` | DSH provider only in production; role `discoverableRoots`, bounds, symlink behavior, abort propagation, and output paths work for supported providers. |
| P0 | Enforce role read roots on known tools | Role tests cover `read`, `read_image`, `grep`, `list`, and editor view. |
| P1 | Gate Plotting visual review on declared image input | Prompt requires `read_image` only for a route that declares image input and has the tool; unsupported/unknown routes continue without a MAIN limitation report. |
| P1 | Add MAIN-only, workspace-contained `present` | A successful REPORT result can make the final PDF a Web deliverable; out-of-workspace and unapproved files are rejected. |
| P1 | Wire `workflow_task(cancel)` to the exact resident activation | The turn stops, the task settles as cancelled, and the same child Session remains resumable. |
| P1 | Verify role process integration | `tests/process-sandbox.live.test.ts` probes allowed/denied workspace reads and writes through the Unix wrapper. Add DSH host-chain coverage for Bash/Python and Windows coverage for the `pwsh` roster, preflight, and ACL writes. Windows arbitrary-process reads remain an explicit limitation until a read-capable sandbox is available. |

## Explicit non-claims

- Shell command screening does not provide workspace-only read isolation.
- DSH's write-oriented `workspaceRoot` sandbox does not by itself confine
  subprocess reads. AutoReport adds a bwrap/Seatbelt workspace view for
  role-aware Bash on Linux/macOS, but that wrapper is not yet covered by a
  dedicated live test. This is workspace isolation, not complete host
  filesystem isolation; other user-readable paths and explicitly exposed runtime
  paths may remain accessible.
- A `present` declaration is not a copied or versioned artifact.
- A cancelled turn does not destroy or replace its resident specialist Session.
