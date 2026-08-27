---
name: mineru
description: Alias for pdf-reference-reader — use when routing mentions MinerU or mineru-open-api for References/ PDF extraction (MAIN only).
---

# MinerU (alias)

This skill is a thin alias for **`pdf-reference-reader`**. Follow that skill's workflow:

1. Detect PDFs in `References/` (bash `find`/`ls`/`python` as needed).
2. Extract with bash: `mineru-open-api extract <pdf> -o Outline/.cache/mineru/<stem>/`
3. Read the generated markdown; never write into `References/`.
4. On auth failure, tell the user to configure MinerU — do not invent content.

MAIN performs extraction; specialists read `Outline/.cache/mineru/` read-only when MAIN has already extracted.
