---
name: pdf-reference-reader
description: Use when References/ PDFs, lab manuals, handouts, or templates cannot be read and need extraction through MAIN's reference_extract capability into Outline/.cache/mineru/.
---

# PDF Reference Reader (MAIN)

Use this skill when a project requirement, handout, or template is a PDF that the read tool cannot parse. MAIN owns extraction. Specialists read cached Markdown from Outline/.cache/mineru/ and never extract PDFs themselves.

## Find PDFs

Use the names-only list tool to inspect References/ and its subdirectories. Paths passed to list and reference_extract are workspace-relative.

## Extract a reference

Call reference_extract with one PDF beneath References/, for example:

reference_extract(file_path="References/handout.pdf")

The tool writes extracted Markdown and assets beneath Outline/.cache/mineru/<stem>/. Read the returned Markdown paths with the read tool. Never write extracted content into References/.

Do not use shell commands or Python for extraction. Do not use flash-extract for production work; it truncates large documents.

## Failures

| Situation | Action |
|-----------|--------|
| MinerU authentication is missing | Tell the user to configure MinerU authentication. Do not invent PDF content. |
| Extraction fails | Report the tool error; do not infer requirements from filenames. |
| Output is partial or truncated | Treat it as incomplete; retry or ask the user. |

## Specialist handoff

After extraction, identify the relevant cached Markdown path in the task inputs. If a subagent needs a PDF that MAIN has not extracted, MAIN performs the extraction first; specialists report missing inputs through report_workflow.
