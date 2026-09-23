# Active report language: LaTeX

Write the report entry point as `Report/main.tex`. Load `latex-compile` before
compiling or diagnosing a PDF.

## LaTeX layout rules

- Prefer compact `l`/`c`/`r` table columns; use `tabularx` or explicit widths only when needed.
- Use `[H]` for every figure and table unless the user-provided template explicitly requires another placement policy; this relies on the `float` package.
- Use `\graphicspath` with the figure directory `../Plots/Fig/`, `\includegraphics`, `.bib` bibliography resources, and standard LaTeX commands. Note `\graphicspath` needs doubled braces in LaTeX (e.g. write the directory inside two brace groups); those are literal LaTeX braces, not prompt variables.
