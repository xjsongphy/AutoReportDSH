---
name: typst-compile
description: Use when compiling Typst reports in an AutoReport workspace, or when diagnosing Typst compilation errors from the compile_report workflow.
---

# Typst Compile

Typst compilation assistant for AutoReport Typst reports: the standard `compile_report` workflow, common errors, and artifact locations.

## When to Use

**Use when:**
- Compiling `Report/main.typ` (the active report language is Typst)
- Diagnosing Typst compilation errors or missing-font warnings

**Don't use when:**
- The active report language is LaTeX (`latex-compile` covers that path)

## Compilation Through compile_report

Call `compile_report`; with `reportLanguage: 'typst'` it runs the `typst` CLI inside the report execution policy:

- **Offline**: network access is denied. Typst must not need to fetch packages; the bundled template imports only the local theme `mplts.typ` and local bibliography assets.
- **Confinement**: process writes stay inside `Report/`. Typst's cache stays in a private temp area, not in your workspace.
- **Entry**: the tool compiles `Report/main.typ` to `Report/main.pdf`.

Conceptual equivalent:

```bash
typst compile Report/main.typ Report/main.pdf --root <workspace>
```

The workspace root flag lets figures reference `../Plots/Fig/...` exactly as the template does.

## Common Errors

### 1. Unknown variable / failed import

```
error: unknown variable: $
  ┌─ Report/main.typ:12:5
```

**Fix:** read the located line with fs tools. Most cases are a missing `#import "mplts.typ": *` at the top of `main.typ` — `/report-init` materializes both files; never edit `mplts.typ` to "fix" an entry-file problem.

### 2. File not found for figure or bibliography

```
error: file not found: ../Plots/Fig/result.png
```

**Fix:** the referenced artifact does not exist yet. Check what PLOTTING actually produced under `Plots/Fig/` (fs list/read), fix the path, or report `blocked` (`missing_data`) if the figure was never produced. Never invent placeholder paths.

### 3. Missing font

```
error: unknown font family: ...
```

**Fix:** the bundled template defaults to macOS system fonts (`font: "macos"` option in `main.typ`). On non-macOS hosts adjust the font set in `main.typ` (your writable root) rather than installing fonts; keep CJK coverage in mind.

### 4. Bibliography issues

`bibliography("bibli.bib")` resolves relative to `Report/`. Citation keys must exist in `bibli.bib`; a `failed to load bibliography` error usually means the `.csl` or `.bib` file was deleted — restore it via `/report-init`, which recreates missing resources.

## Workflow

1. Call `compile_report`.
2. Read the structured diagnostics; Typst errors carry file + line spans — read those exact lines before editing.
3. Fix in `Report/*.typ` (writes stay confined there).
4. Recompile until clean; confirm the reported PDF path.
