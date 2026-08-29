/**
 * Minimal overlay stubs so tests do not hit GitHub. Production sync writes
 * the same relative paths under `$DSH_HOME/autoreport/resources`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const LATEX_COMPILE = `---
name: latex-compile
description: Use when compiling LaTeX reports in an AutoReport workspace via bash.
---

## AutoReport workspace

Compile \`Report/main.tex\` from bash. Prefer \`latexmk\`, then \`tectonic\`, then \`xelatex\`. Do not use \`compile_report\`.

\`\`\`bash
cd Report && latexmk -xelatex -interaction=nonstopmode -file-line-error main.tex
\`\`\`
`

const TYPST_SKILL = `---
name: typst
description: Typst document creation for AutoReport experiment reports.
---

# Typst

Compile through \`typst-compile\`. Read [basics.md](basics.md), [styling.md](styling.md), [tables.md](tables.md), and [academic.md](academic.md).
`

const MPLTS = `// test mplts stub
#let mplts(body) = body
`

const MAIN_TYP = `// test main.typ stub
#import "mplts.typ": *
`

/** Write the overlay files tests need for latex-compile, typst, and Typst templates. */
export function seedSyncedResourceStubs(overlayRoot: string): string {
  const files: Readonly<Record<string, string>> = {
    'skills/latex-compile.md': LATEX_COMPILE,
    'typst/skills/typst/SKILL.md': TYPST_SKILL,
    'typst/themes/mplts.typ': MPLTS,
    'typst/templates/main.typ': MAIN_TYP,
    'typst/templates/bibli.bib': '@article{test, title={t}, author={a}, year={2026}}\n',
    'typst/templates/american-physics-society.csl': '<?xml version="1.0"?><style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0"/>\n',
  }
  for (const [relative, body] of Object.entries(files)) {
    const path = join(overlayRoot, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  return overlayRoot
}
