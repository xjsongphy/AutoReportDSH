---
name: typst-compile
description: Use when compiling Typst reports in an AutoReport workspace via its role shell, or when diagnosing Typst compilation errors.
---

# Typst Compile

Typst compilation assistant for AutoReport Typst reports: shell-driven `typst compile`, common errors, and artifact locations.

## When to Use

**Use when:**
- Compiling `Report/main.typ` (the active report language is Typst)
- Diagnosing Typst compilation errors or missing-font warnings

**Don't use when:**
- The active report language is LaTeX (`latex-compile` covers that path)

## Compilation via the role shell

On supported Linux/macOS hosts, REPORT's role-aware Bash starts in `Report/`.
Compile without repeating `Report/` after the shell enters that directory.
Windows process execution is unavailable until a role-aware backend exists;
report the platform blocker instead of claiming compilation succeeded. Network
access is allowed (package/font fetch when needed). Workspace-canonical output
paths and handoffs still include `Report/`; `read` paths are workspace-root-
relative, while `write`/`edit` path bases are shown by those tools.

```bash
typst compile main.typ main.pdf --root ..
```

The `--root` flag lets figures reference `../Plots/Fig/...` as the template does.

Capture full stdout/stderr for diagnosis.

## Common Errors

### 1. Unknown variable / failed import

```
error: unknown variable: $
  ┌─ Report/main.typ:12:5
```

**Fix:** read the located line with fs tools. Most cases are a missing `#import "mplts.typ": *` at the top of `main.typ` — `/init` materializes both files; never edit `mplts.typ` to "fix" an entry-file problem.

### 2. File not found for figure or bibliography

```
error: file not found: ../Plots/Fig/result.png
```

**Fix:** the referenced artifact does not exist yet. Check what PLOTTING actually produced under `Plots/Fig/` (fs list/read), fix the path, or report `blocked` (`missing_data`) if the figure was never produced. Never invent placeholder paths.

### 3. Inline formula floats as its own block

No compiler error: the PDF shows short formulas broken out of paragraphs,
floating beside or after the text they belong to.

**Cause:** spaces inside `$ ... $` switch Typst to display mode. Inline math
must be written without inner spaces (`$C_0$`); reserve `$ ... $` with spaces
for labelled display equations.

**Fix:** read the reported line and strip the inner spaces from inline math,
then recompile and inspect the affected paragraph in the rendered output.

### 4. Missing font

```
error: unknown font family: ...
```

**Fix:** the bundled template defaults to macOS system fonts (`font: "macos"` option in `main.typ`). On non-macOS hosts adjust the font set in `main.typ` (your writable root) rather than installing fonts; keep CJK coverage in mind.

### 4. Bibliography issues

`bibliography("bibli.bib")` resolves relative to `Report/`. Citation keys must exist in `bibli.bib`; a `failed to load bibliography` error usually means the `.csl` or `.bib` file was deleted — restore via `/init`.

## Workflow

1. Run `typst compile` via the available shell from REPORT's `Report/` cwd with `--root ..` set to the experiment workspace.
2. Read full diagnostics; Typst errors carry file + line spans — read those exact lines before editing.
3. Fix in `Report/*.typ` (writes stay confined there).
4. Recompile until clean; confirm `Report/main.pdf`.
