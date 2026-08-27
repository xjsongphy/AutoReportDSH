---
name: latex-compile
description: Use when compiling LaTeX reports in an AutoReport workspace via bash, or when diagnosing compilation errors, missing cross-references, or diagnostic warnings.
---

# LaTeX Compile

LaTeX compilation assistant for AutoReport LaTeX reports: bash-driven `latexmk` / `tectonic`, error diagnosis, and cross-reference repair.

**Important: When this skill is loaded, there is usually a compilation problem that needs solving. Always surface sufficient error information for diagnosis — do not over-filter output.**

## When to Use

**Use when:**
- Compiling `Report/main.tex` with the XeLaTeX toolchain
- Encountering LaTeX compilation errors (environment mismatch, undefined references, Chinese character issues)
- Diagnosing compilation warnings or failed builds

**Don't use when:**
- The active report language is Typst (`typst-compile` covers that path)
- Setting up a new workspace (`/report-init` materializes `Report/main.tex` and `mpltx.cls`)

## Compilation via bash

Run compilers from bash with workdir `Report/` (or use `latexmk -cd`). Network access is allowed for package fetch.

**Preferred (latexmk + XeLaTeX):**

```bash
cd Report && latexmk -xelatex -interaction=nonstopmode -file-line-error main.tex
```

`latexmk` runs multiple passes as needed for cross-references.

**Fallback when `latexmk` is missing:**

```bash
cd Report && tectonic -X compile main.tex
```

**Manual two-pass XeLaTeX (when neither tool is available):**

```bash
cd Report
xelatex -synctex=1 -interaction=nonstopmode -file-line-error main.tex
xelatex -synctex=1 -interaction=nonstopmode -file-line-error main.tex
```

**Engine choice:** check what is installed (`command -v latexmk`, `command -v tectonic`). User/workspace `latexEngine` setting (`latexmk` vs `tectonic`) is a hint — prefer it when the binary exists.

**Parameters (XeLaTeX):**
- `-synctex=1`: generate SyncTeX data for PDF viewer synchronization
- `-interaction=nonstopmode`: continue on errors so all problems are shown at once
- `-file-line-error`: display error messages with file and line numbers

**Must compile twice** when using raw `xelatex`: the first pass generates `.aux` files, the second resolves cross-references. If labels change, compile again.

All writes stay inside `Report/`.

## Common Compilation Error Diagnosis

### 1. Environment Mismatch Error

**Symptom:**
```
! LaTeX Error: \begin{document} ended by \end{remark}.
```

**Cause:** mismatched environment begin/end tags.

**Fix:** check each `\begin{remark}` has a corresponding `\end{remark}`; remove extra end tags. Locate them with your fs search tools:
```
grep -n "begin{remark}\|end{remark}" Report/*.tex
```

### 2. Missing Required Parameter Error

**Symptom:**
```
! Package pgfkeys Error: I do not know the key '/tcb/Title'...
```

**Cause:** incorrect theorem environment format.

**Correct format (using `\newtcbtheorem`):**
```latex
\begin{remark}{Title}{label}
  Content...
\end{remark}
```
**Wrong format:**
```latex
\begin{remark}[Title]
  Content...
\end{remark}
```

### 3. Chinese Character Error

**Symptom:**
```
! Package pgfkeys Error: I do not know the key '/tcb/中文标题'...
```

**Cause:** Chinese title in square brackets.

**Fix:** use `{Title}{label}` format.

### 4. Undefined Reference Warning

```
LaTeX Warning: Reference `eq:label' undefined...
LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.
```

**Fix:** run `latexmk` or `xelatex` again (second pass).

## Output Interpretation

- **Success**: `Output written on main.pdf (N pages).`
- **Warnings with success**: hyperref "Token not allowed in a PDF string" is usually ignorable.
- **Failure**: lines starting `!` plus `l.<line>` locate the error; fix before recompiling.

## Diagnosis Discipline

**Do not over-filter compiler output — errors may appear anywhere.**

Recommended:
- Filter to errors/warnings without truncating position: `grep -E "Error|! |Warning"` over the log tail.
- Use `-file-line-error` style locations (`./main.tex:123: ...`) and read around that line with fs tools before editing.

Never rely on only the first or last few lines of a long log; middle errors are common.

## Workflow

1. Run the bash compile command from `Report/`. Capture full stdout/stderr.
2. Map each error to file + line using `-file-line-error` locations.
3. Fix with fs edit tools (writes stay inside `Report/`).
4. Recompile via bash; repeat until clean.
5. Confirm `Report/main.pdf` exists and updated.

## Common Issues

- **PDF not updated?** Stale aux data can wedge references. Remove `Report/*.aux`, `*.synctex.gz`, `*.log` intermediates (they are manifest-filtered build residue) and recompile.
- **Compilation slow?** Normal for XeLaTeX on large documents; the first pass is slowest.
- **Missing class file?** `mpltx.cls` must sit beside `main.tex` in `Report/`; `/report-init` restores it if absent.
