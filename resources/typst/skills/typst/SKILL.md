---
name: typst
description: 'Typst document creation and package development. Use when: (1) Working with .typ files, (2) User mentions typst, typst.toml, or typst-cli, (3) Creating or using Typst packages, (4) Developing document templates, (5) Converting Markdown/LaTeX to Typst'
---

# Typst

Typst 0.15+ authoring for AutoReport experiment reports.

## LaTeX habits that do NOT work in Typst math

Check these before the first compile — they account for most first-pass
errors when coming from LaTeX (all verified against typst 0.15):

- **Every `^` and `_` needs a base inside the same math run.** A math
  expression cannot START with a script: `F$^{-2}$` fails with
  "unexpected hat". Keep the base and its script in one math run —
  `$F^(-2)$` or `$F^{-2}$` (brace groups after a base are fine; it is the
  base-less hat that breaks).
- **Quoted subscripts close with a quote, not a brace.** LaTeX
  `V_{b,set}` becomes `V_"b,set"`; `V_"b,set}` leaves an unclosed string
  ("unclosed delimiter").
- **No backslash commands in math.** Symbols are bare words — `phi`,
  `times`, `approx`, `dif` — and `\varphi` is an error (the backslash eats
  itself and leaves `arphi`).

The workspace already ships `mplts.typ`. This skill keeps only the
reference docs used when writing a physics or engineering report, and they sit
beside this file:

| When you need to... | Read |
| --- | --- |
| Syntax, imports, functions, control flow | [basics.md](basics.md) |
| Pages, headings, figures, layout | [styling.md](styling.md) |
| Tables and measured data | [tables.md](tables.md) |
| Citations, theorems, equations | [academic.md](academic.md) |
