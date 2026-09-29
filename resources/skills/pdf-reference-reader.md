---
name: pdf-reference-reader
description: Use when References/ PDFs, lab manuals, handouts, or templates need markdown extraction into Outline/.cache/mineru/ for MAIN coordination or subagent reference lookup.
---

# PDF Reference Reader (MAIN)

When a PDF under `References/` is needed and `read()` cannot parse it, call
`reference_extract` with its workspace-relative path:

```text
reference_extract({path: "References/handout.pdf"})
```

The tool invokes MinerU and saves extracted markdown and assets under
`Outline/.cache/mineru/<stem>/`. Read the generated markdown there, often
`full.md`, before using it as evidence. Subagents may read the cached files;
they should report a missing dependency to MAIN when extraction is needed.

If the tool reports missing credentials or a failed extraction, report the
blocker. Do not infer PDF contents from the filename or substitute a truncated
extractor output.
