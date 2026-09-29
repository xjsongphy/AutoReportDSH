# Active report language: Typst

Write the report entry point as `Report/main.typ`. Import the local `mplts.typ`
theme. Load `typst` for authoring and compile with
`compile_report({path: "Report/main.typ"})`; read the returned full log if needed.

## Typst layout rules

- Use Typst `figure`, `table`, `grid`, `tablex`, and local theme functions; do not use LaTeX commands, packages, `[H]`, `\linewidth`, or LaTeX column syntax.
- Reference figures from `../Plots/Fig/` with Typst paths and use `bibliography("bibli.bib")` or the project's configured CSL/BibLaTeX-compatible workflow.
