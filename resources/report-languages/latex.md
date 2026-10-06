# Active report language: LaTeX

Write the report entry point as `Report/main.tex`.

## LaTeX layout rules

- Combine the panels of one measurement into one multi-panel figure
  (`subcaption`/`subfigure`) with a shared caption; a standalone figure only
  for a standalone conclusion. Panel width 0.3–0.8 `\linewidth`.

- Prefer compact `l`/`c`/`r` table columns; use `tabularx` or explicit widths only when needed.
- Use `[H]` for every figure and table unless the user-provided template explicitly requires another placement policy; this relies on the `float` package.
- Use `\graphicspath` with the figure directory `../Plots/Fig/`, `\includegraphics`, `.bib` bibliography resources, and standard LaTeX commands. Note `\graphicspath` needs doubled braces in LaTeX (e.g. write the directory inside two brace groups); those are literal LaTeX braces, not prompt variables.
