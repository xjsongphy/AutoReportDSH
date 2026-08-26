import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/preset.js'

/** The preset contribution is intentionally small: scoped skills plus two MAIN tools. */
describe('autoreport preset contribution', () => {
  it('registers bundled skills and the current fixed-workflow MAIN tools together', () => {
    const tools: string[] = []
    const skills: string[] = []
    const context = {
      tools: {
        register: (definition: { name: string }) => {
          tools.push(definition.name)
          return () => {}
        },
      },
      skills: {
        register: (registration: { name: string }) => {
          skills.push(registration.name)
          return () => {}
        },
      },
      subagents: {},
      autoreportWorkflow: {
        config: {
          defaultReportLanguage: 'latex',
          defaultLatexEngine: 'latexmk',
          defaultPythonEnv: undefined,
          workspaceRoot: undefined,
          specialistModel: undefined,
          executionTimeoutMs: 600_000,
        },
        forSession: () => ({ state: {} }),
      },
    } as unknown as Context

    apply(context)

    expect(tools.sort()).toEqual(['report_task', 'send_to_agent'])
    expect(skills.sort()).toEqual([
      'experiment-report-writer',
      'latex-compile',
      'typst-compile',
    ])
  })
})
