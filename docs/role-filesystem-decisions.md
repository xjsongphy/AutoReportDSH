# Role filesystem, delivery, and cancellation decisions

Decision record updated 2026-09-26. This document records the chosen product
boundaries and the work needed to implement them. It does not claim that the
unfinished items below are already enforced.

## Guiding boundary

AutoReport restricts known model-facing file tools by role. That policy does
not restrict what an arbitrary shell, Python process, compiler, or descendant
process can read. Command-text checks may explain or reject common calls, but
they are not a filesystem security boundary. Any workspace-only read guarantee
for arbitrary processes requires a separately verified OS-level isolation
backend; unsupported platforms must not silently fall back to unrestricted
execution.

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

### Known filesystem tools use role-readable roots

`read`, `read_image`, `list`, and editor view operations are limited by
`readableRoots`. Writes continue to use each role's `writableRoots`. Tests must
cover role matrices, traversal, symlink escapes, missing paths, and unaffected
stock DSH sessions.

This is a capability restriction for these known tool calls. It does not imply
that `bash`, Python, compilers, or other subprocesses can read only those roots.
Keep that limitation visible in tool guidance and documentation.

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
authorization. If search becomes necessary, implement AutoReport-owned search
through DSH filesystem operations, with explicit path, byte, result, and time
bounds. Use streaming reads for content search where available. Defer this work
until there is a demonstrated need.

## Work order

| Priority | Work | Completion condition |
|---|---|---|
| P0 | Finish provider-backed `list` | DSH provider only in production; bounds, symlink behavior, abort propagation, and output paths work for supported providers. |
| P0 | Enforce readable roots on known file tools | Role tests cover `read`, `read_image`, `list`, and editor view; no claim is made about subprocess reads. |
| P1 | Add MAIN-only, workspace-contained `present` | A successful REPORT result can make the final PDF a Web deliverable; out-of-workspace and unapproved files are rejected. |
| P1 | Wire `workflow_task(cancel)` to the exact resident activation | The turn stops, the task settles as cancelled, and the same child Session remains resumable. |
| P2 | Add bounded provider-backed `glob`/`grep` if users need them | Search stays inside readable roots and obeys resource/output caps without unconfined subprocess access. |
| Separate security track | Arbitrary-process read isolation | Supported OS backends enforce and verify the boundary; unsupported platforms fail closed when this guarantee is required. |

## Explicit non-claims

- Shell command screening does not provide workspace-only read isolation.
- DSH's write-oriented `workspaceRoot` sandbox does not by itself confine
  subprocess reads.
- A `present` declaration is not a copied or versioned artifact.
- A cancelled turn does not destroy or replace its resident specialist Session.
