import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMainPersona, loadSpecialistPersona } from '../src/personas.js'
import { allSpecialistRoles } from '../src/roles.js'

const CLI_AGENTS = join(import.meta.dirname, '../../autoreportcli/templates/agents')
const REPO_PERSONAS = join(import.meta.dirname, '../resources/personas')

const ROLE_PERSONA_FILES: Readonly<Record<string, string>> = {
  THEORY: 'theory_agent.md',
  DATA_ANALYSIS: 'data_analysis_agent.md',
  PLOTTING: 'plotting_agent.md',
  REPORT: 'report_agent.md',
}

/** Domain quality gates each persona must keep. */
const QUALITY_GATES: Readonly<Record<string, readonly string[]>> = {
  THEORY: [
    'Dimensional / unit consistency',
    'Limiting-case sanity',
    'Variables defined before use',
    'Formula ↔ derivation traceability',
    'Assumptions documented',
    'Downstream coverage',
  ],
  DATA_ANALYSIS: [
    'Write from raw data, never fabricate',
    'Each processed dataset must trace back to a named source file recorded in the manifest',
  ],
  PLOTTING: [
    'Cover the measured data',
  ],
  REPORT: [
    'Cite only real references',
    'Write from data, not from memory',
  ],
}

/** Role boundary statements each specialist persona must keep. */
const ROLE_BOUNDARIES: Readonly<Record<string, readonly string[]>> = {
  THEORY: ['Writes stay confined to your role directory (`Theory/`)'],
  DATA_ANALYSIS: ['Writes stay confined to your role directory (`Data/Processed/`)'],
  PLOTTING: ['Writes stay confined to your role directory (`Plots/`)'],
  REPORT: ['写入仅限于你的角色目录（`Report/`）'],
}

/** Tool/skill names each persona must reference. */
const REQUIRED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  THEORY: ['report_workflow'],
  DATA_ANALYSIS: ['report_workflow', 'manifest'],
  PLOTTING: ['report_workflow', 'manifest'],
  REPORT: ['report_workflow', 'experiment-report-writer'],
}

/**
 * Runtime mechanics that must NOT leak into personas: Python invocation
 * recipes, retired-tool migration traces, static tool-parameter tutorials,
 * MinerU CLI, and false apply_patch auto-validation claims.
 */
const FORBIDDEN_PERSONA_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /DSH_AUTOREPORT_PYTHON/u, reason: 'python-env PATH overlay makes the env-var recipe obsolete' },
  { pattern: /report_exec/u, reason: 'retired tool; do not tell the model what not to call' },
  { pattern: /compile_report/u, reason: 'retired tool; do not tell the model what not to call' },
  { pattern: /delegation_revision/u, reason: 'delegation mechanics belong to the report_workflow tool description' },
  { pattern: /block_type/u, reason: 'delegation mechanics belong to the report_workflow tool description' },
  { pattern: /mineru-open-api/u, reason: 'MinerU CLI lives in the pdf-reference-reader skill, not personas' },
  { pattern: /apply_patch/u, reason: 'apply_patch is not mounted in DSH; auto-validation claims are false' },
  { pattern: /automatically validated/iu, reason: 'runtime auto-validation claims must be true' },
  { pattern: /do the work yourself/iu, reason: 'contradicts MAIN coordinate-do-not-execute' },
  { pattern: /status="success"/u, reason: 'outcome status tutorials belong to tool descriptions' },
]

function assertNoForbiddenPatterns(text: string, label: string): void {
  for (const { pattern, reason } of FORBIDDEN_PERSONA_PATTERNS) {
    expect(text, `${label} must not match ${String(pattern)} (${reason})`).not.toMatch(pattern)
  }
}

describe('persona slimming', () => {
  it('loads Main with DSH tool names and skill pointers but no protocol mechanics', () => {
    const text = loadMainPersona()
    expect(text).toContain('send_to_agent')
    expect(text).not.toContain('report_task')
    expect(text).toContain('pdf-reference-reader')
    expect(text).toContain('bash')
    expect(text).toContain('Selective todos')
    expect(text).toContain('No tables by default')
    expect(text).not.toContain('subagent_fork')
    expect(text).not.toContain('`respond`')
    assertNoForbiddenPatterns(text, 'MAIN persona')
  })

  it('prefixes every specialist with the shared collaboration rules and keeps role boundaries', () => {
    const common = readFileSync(join(REPO_PERSONAS, 'Common.md'), 'utf8')
    expect(common).toContain('## Workflow boundary')
    for (const role of allSpecialistRoles()) {
      const text = loadSpecialistPersona(role)
      const roleFile = readFileSync(join(REPO_PERSONAS, ROLE_PERSONA_FILES[role] ?? ''), 'utf8')
      expect(text.startsWith(common)).toBe(true)
      expect(text).toContain('report_workflow')
      for (const boundary of ROLE_BOUNDARIES[role] ?? []) {
        expect(roleFile).toContain(boundary)
      }
      for (const reference of REQUIRED_REFERENCES[role] ?? []) {
        expect(text).toContain(reference)
      }
      expect(roleFile).not.toMatch(/with the `report_exec` tool|Execute the script with the `report_exec`/u)
      expect(text).not.toContain('`respond`')
      assertNoForbiddenPatterns(text, `${role} persona`)
    }
  })

  it('embeds AutoReport quality gates in DSH personas with translated tool names', () => {
    const dshTheory = readFileSync(join(REPO_PERSONAS, 'theory_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.THEORY ?? []) {
      expect(dshTheory).toContain(gate)
    }
    expect(dshTheory).toContain('`report_workflow`')

    const dshData = readFileSync(join(REPO_PERSONAS, 'data_analysis_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.DATA_ANALYSIS ?? []) {
      expect(dshData).toContain(gate)
    }

    const dshPlot = readFileSync(join(REPO_PERSONAS, 'plotting_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.PLOTTING ?? []) {
      expect(dshPlot).toContain(gate)
    }

    const dshReport = readFileSync(join(REPO_PERSONAS, 'report_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.REPORT ?? []) {
      expect(dshReport).toContain(gate)
    }
  })

  it('keeps the plotting unicode-minus requirement without claiming auto-validation', () => {
    const text = readFileSync(join(REPO_PERSONAS, 'plotting_agent.md'), 'utf8')
    expect(text).toContain('unicode_minus')
    expect(text).toContain('plt.close')
    expect(text).not.toContain('Auto-validated')
    expect(text).not.toContain('Automatic code validation')
  })

  it('keeps the hard LaTeX figure/table placement policy in language guidance', () => {
    const latex = readFileSync(join(REPO_PERSONAS, '../report-languages/latex.md'), 'utf8')
    expect(latex).toContain('Use `[H]` for every figure and table unless the user-provided template explicitly requires another placement policy')
  })

  it('keeps DATA_ANALYSIS output responsibilities unambiguous', () => {
    const text = readFileSync(join(REPO_PERSONAS, 'data_analysis_agent.md'), 'utf8')
    // analysis.md appears once as the methods/formulas/assumptions file.
    const occurrences = text.split('`analysis.md`').length - 1
    expect(occurrences).toBe(1)
    expect(text).toContain('`analysis.md` — Methods, formulas, assumptions')
  })

  const CLI_AVAILABLE = existsSync(join(CLI_AGENTS, 'theory_agent.md'))

  it.skipIf(!CLI_AVAILABLE)('keeps AutoReportCLI quality gates while translating tool names', () => {
    const cliTheory = readFileSync(join(CLI_AGENTS, 'theory_agent.md'), 'utf8')
    const dshTheory = readFileSync(join(REPO_PERSONAS, 'theory_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.THEORY ?? []) {
      expect(cliTheory).toContain(gate)
      expect(dshTheory).toContain(gate)
    }
    expect(cliTheory).toContain('`respond`')
    expect(dshTheory).toContain('`report_workflow`')

    const cliData = readFileSync(join(CLI_AGENTS, 'data_analysis_agent.md'), 'utf8')
    const dshData = readFileSync(join(REPO_PERSONAS, 'data_analysis_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.DATA_ANALYSIS ?? []) {
      expect(cliData).toContain(gate)
      expect(dshData).toContain(gate)
    }

    const cliPlot = readFileSync(join(CLI_AGENTS, 'plotting_agent.md'), 'utf8')
    const dshPlot = readFileSync(join(REPO_PERSONAS, 'plotting_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.PLOTTING ?? []) {
      expect(cliPlot).toContain(gate)
      expect(dshPlot).toContain(gate)
    }

    const cliReport = readFileSync(join(CLI_AGENTS, 'report_agent.md'), 'utf8')
    const dshReport = readFileSync(join(REPO_PERSONAS, 'report_agent.md'), 'utf8')
    for (const gate of QUALITY_GATES.REPORT ?? []) {
      expect(cliReport).toContain(gate)
      expect(dshReport).toContain(gate)
    }
  })
})
