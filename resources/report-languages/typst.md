# Active report language: Typst

Write the report entry point as `Report/main.typ`. Import the local `mplts.typ`
theme. Load `typst` for authoring and `typst-compile` before compiling or
diagnosing a PDF. Do not load `latex-compile`.

## Typst layout rules

- Use Typst `figure`, `table`, `grid`, `tablex`, and local theme functions; do not use LaTeX commands, packages, `[H]`, `\linewidth`, or LaTeX column syntax.
- Reference figures from `../Plots/Fig/` with Typst paths and use `bibliography("bibli.bib")` or the project's configured CSL/BibLaTeX-compatible workflow.
- Follow the math notation already established by the supplied template. For a
  new report, set one document-wide convention before drafting: use one symbol
  for each quantity, one bias-voltage sign convention, upright units and named
  operators, and the same derivative notation in equations, captions, and
  tables. Use a labelled display equation for a relation cited later; leave
  short substitutions inline. Treat every displayed equation as part of its
  surrounding sentence and punctuate it accordingly. Check notation and units
  across Theory, Results, captions, and Conclusion after compiling; a successful
  Typst build does not perform this check.
