import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMainPersona, loadSpecialistPersona } from '../src/personas.js'
import { allSpecialistRoles } from '../src/roles.js'

const CLI_AGENTS = join(import.meta.dirname, '../../autoreportcli/templates/agents')
const REPO_PERSONAS = join(import.meta.dirname, '../resources/personas')

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
  ],
  PLOTTING: [
    'Cover the measured data',
  ],
  REPORT: [
    'Cite only real references',
  ],
}

describe('persona migration', () => {
  it('loads Main with DSH tool names, bash/pdf guidance, and no generic delegation surface', () => {
    const text = loadMainPersona()
    expect(text).toContain('send_to_agent')
    expect(text).not.toContain('report_task')
    expect(text).toContain('pdf-reference-reader')
    expect(text).toContain('mineru-open-api')
    expect(text).toContain('bash')
    expect(text).not.toContain('subagent_fork')
    expect(text).not.toContain('`respond`')
  })

const ROLE_PERSONA_FILES: Readonly<Record<string, string>> = {
  THEORY: 'theory_agent.md',
  DATA_ANALYSIS: 'data_analysis_agent.md',
  PLOTTING: 'plotting_agent.md',
  REPORT: 'report_agent.md',
}

  it('prefixes every specialist with the shared collaboration rules and bash execution', () => {
    const common = readFileSync(join(REPO_PERSONAS, 'Common.md'), 'utf8')
    for (const role of allSpecialistRoles()) {
      const text = loadSpecialistPersona(role)
      const roleFile = readFileSync(join(REPO_PERSONAS, ROLE_PERSONA_FILES[role] ?? ''), 'utf8')
      expect(text.startsWith(common)).toBe(true)
      expect(text).toContain('report_workflow')
      expect(text).toContain('task_id')
      expect(text).toContain('delegation_revision')
      expect(roleFile).toContain('bash')
      expect(roleFile).toContain('DSH_AUTOREPORT_PYTHON')
      expect(roleFile).not.toMatch(/with the `report_exec` tool|Execute the script with the `report_exec`/u)
      expect(text).not.toContain('`respond`')
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
