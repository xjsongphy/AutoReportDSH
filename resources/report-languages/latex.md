# Active report language: LaTeX

Write the report entry point as `Report/main.tex`. Compile with
`compile_report({path: "Report/main.tex"})`; read the returned full log if needed.

## LaTeX layout rules

- Prefer compact `l`/`c`/`r` table columns; use `tabularx` or explicit widths only when needed.
- Use `[H]` for every figure and table unless the user-provided template explicitly requires another placement policy; this relies on the `float` package.
- Use `\graphicspath` with the figure directory `../Plots/Fig/`, `\includegraphics`, `.bib` bibliography resources, and standard LaTeX commands. Note `\graphicspath` needs doubled braces in LaTeX (e.g. write the directory inside two brace groups); those are literal LaTeX braces, not prompt variables.
