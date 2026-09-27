---
name: pdf-reference-reader
description: Use when References/ PDFs, lab manuals, handouts, or templates cannot be read with read() and need markdown extraction via MinerU (mineru-open-api) into Outline/.cache/mineru/ for MAIN coordination or subagent reference lookup.
---

# PDF Reference Reader (MAIN)

Extract reference PDFs into markdown so coordination and subagents can read experiment requirements, handouts, and templates. **MAIN only** performs extraction; subagents read cached markdown read-only from `Outline/.cache/mineru/` when MAIN has already extracted.

## When to Use

**Use when:**
- `References/` contains PDFs that `read()` cannot parse
- Project audit needs requirement or template text from a PDF
- A subagent task depends on PDF content MAIN has not yet extracted

**Don't use when:**
- The file is already markdown, plain text, or readable by `read()`
- You are a subagent and MAIN has already extracted to `Outline/.cache/mineru/<stem>/`

## Detect PDFs

Check the available shell tool description for its starting directory. With the
role sandbox, MAIN starts in `Outline/`: use `../References` for shell inputs
and `.cache/mineru/` for shell outputs. Without it, set `workdir: "Outline"`
when needed. `read` and `list` paths remain workspace-root-relative in either
mode. AutoReport uses Bash on Linux/macOS and PowerShell on Windows; use the
platform's directory-listing syntax. Avoid Python here: MAIN's shell commands
are for coordination and PDF extraction.

```bash
find ../References -type f -iname '*.pdf'
ls -la ../References/
```

PowerShell equivalent:

```powershell
Get-ChildItem ../References -File -Recurse -Filter '*.pdf'
Get-ChildItem ../References -Force
```

## Extract via the available shell

Call `mineru-open-api` from the available shell (not flash-extract for
production work):

```bash
mineru-open-api extract "../References/handout.pdf" -o ".cache/mineru/handout/"
```

Rules:
- The workspace-canonical output directory is `Outline/.cache/mineru/<stem>/`; from MAIN's sandboxed `Outline/` shell cwd, pass `.cache/mineru/<stem>/` to `-o`.
- When the shell starts at the workspace root, pass `Outline/.cache/mineru/<stem>/` to `-o` instead.
- Never write extracted markdown or assets into `References/`.
- After extraction, use workspace-root-relative `read()` on the generated markdown (often `Outline/.cache/mineru/<stem>/full.md`).

## Failures

| Situation | Action |
|-----------|--------|
| Auth / API token missing | Tell the user to configure MinerU (`mineru-open-api auth`). Do not invent PDF content. |
| Extract fails | Report the error; do not guess requirements from filenames. |
| Partial or truncated output | Do not treat as complete; re-run or ask the user. |

**Do not fallback to `flash-extract` without warning** — it truncates large documents (20-page limit).

## Subagent read path

Subagents do not run extraction. When MAIN has cached output, read markdown under `Outline/.cache/mineru/` read-only. If no cache exists for a needed PDF, report `missing_data` via `report_workflow` so MAIN can extract.
