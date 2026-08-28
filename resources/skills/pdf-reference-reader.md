---
name: pdf-reference-reader
description: Use when References/ PDFs, lab manuals, handouts, or templates cannot be read with read() and need markdown extraction via MinerU (mineru-open-api) into Outline/.cache/mineru/ for MAIN coordination or specialist reference lookup.
---

# PDF Reference Reader (MAIN)

Extract reference PDFs into markdown so coordination and specialists can read experiment requirements, handouts, and templates. **MAIN only** performs extraction; specialists read cached markdown read-only from `Outline/.cache/mineru/` when MAIN has already extracted.

## When to Use

**Use when:**
- `References/` contains PDFs that `read()` cannot parse
- Project audit needs requirement or template text from a PDF
- A specialist task depends on PDF content MAIN has not yet extracted

**Don't use when:**
- The file is already markdown, plain text, or readable by `read()`
- You are a specialist and MAIN has already extracted to `Outline/.cache/mineru/<stem>/`

## Detect PDFs

Locate candidates with workspace inspection (bash is allowed for MAIN):

```bash
find References -type f -iname '*.pdf'
ls -la References/
python3 -c "import pathlib; print('\n'.join(str(p) for p in pathlib.Path('References').rglob('*.pdf')))"
```

## Extract via bash

Call `mineru-open-api` from bash (not flash-extract for production work):

```bash
mineru-open-api extract "References/handout.pdf" -o "Outline/.cache/mineru/handout/"
```

Rules:
- Always pass `-o` to a directory under `Outline/.cache/mineru/<stem>/` (use the PDF stem as `<stem>`).
- Never write extracted markdown or assets into `References/`.
- After extraction, `read()` the generated markdown (often `full.md` or similar) inside the output directory.

## Failures

| Situation | Action |
|-----------|--------|
| Auth / API token missing | Tell the user to configure MinerU (`mineru-open-api auth`). Do not invent PDF content. |
| Extract fails | Report the error; do not guess requirements from filenames. |
| Partial or truncated output | Do not treat as complete; re-run or ask the user. |

**Do not fallback to `flash-extract` without warning** — it truncates large documents (20-page limit).

## Specialist read path

Specialists do not run extraction. When MAIN has cached output, read markdown under `Outline/.cache/mineru/` read-only. If no cache exists for a needed PDF, report `missing_data` via `report_workflow` so MAIN can extract.
