---
name: typst
description: 'Typst document creation and package development. Use when: (1) Working with .typ files, (2) User mentions typst, typst.toml, or typst-cli, (3) Creating or using Typst packages, (4) Developing document templates, (5) Converting Markdown/LaTeX to Typst'
---

# Typst

Typst 0.15+ authoring for AutoReport experiment reports.

The workspace already ships `mplts.typ`. This skill keeps only the
reference docs used when writing a physics or engineering report, and they sit
beside this file:

| When you need to... | Read |
| --- | --- |
| Syntax, imports, functions, control flow | [basics.md](basics.md) |
| Pages, headings, figures, layout | [styling.md](styling.md) |
| Tables and measured data | [tables.md](tables.md) |
| Citations, theorems, equations | [academic.md](academic.md) |

Compiling is `typst-compile`'s job; that skill carries the command, the
workspace entry file, and the diagnostics workflow.
