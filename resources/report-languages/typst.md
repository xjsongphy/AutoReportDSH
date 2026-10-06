# Active report language: Typst

Write the report entry point as `Report/main.typ`. Import the local `mplts.typ`
theme. Load `typst` for authoring.

## Typst layout rules

- Combine the panels of one measurement into one multi-panel figure (a `grid`
  inside `#figure`, panels labelled `(a)`, `(b)`) with a shared caption; a
  standalone figure only for a standalone conclusion. Panel width 0.3–0.8 of
  the text width.

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
- Inline math carries no spaces inside the delimiters (`$C_0$`). Spaced
  delimiters (`$ C_0 = 5000 "pF" $`) switch Typst to display mode: the formula
  breaks out of the paragraph and floats as a separate block. Reserve spaced
  math for labelled display equations only.
- Read the theme's `#set math.equation(...)` before writing references. The
  local theme sets the equation supplement to 式, so `@eq:name` already renders
  as 式 (n); never write the supplement word in front of a reference, and
  likewise never prefix figure or table references with a word the theme's
  supplement already provides.
