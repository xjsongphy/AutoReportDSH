import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/preset.js'

/** The preset contribution is intentionally small: no domain skills leak into MAIN. */
describe('autoreport preset contribution', () => {
  it('registers only the current fixed-workflow MAIN tools', () => {
    const tools: string[] = []
    const skills: string[] = []
    let referencesProvider = 0
    const skillsService = {
      register: (registration: { name: string }) => {
        skills.push(registration.name)
        return () => {}
      },
      registerProvider: () => {
        referencesProvider += 1
        return () => {}
      },
    }
    const context = {
      get: (name: string) => name === 'skills' ? skillsService : undefined,
      tools: {
        register: (definition: { name: string }) => {
          tools.push(definition.name)
          return () => {}
        },
      },
      skills: skillsService,
      systemPrompt: { section: () => () => {} },
      subagents: {},
      autoreportWorkflow: {
        config: {
          defaultReportLanguage: 'latex',
          workspaceRoot: undefined,
          specialistModel: undefined,
          delegationWaitTimeoutMs: 600_000,
        },
        forSession: () => ({ state: {} }),
      },
    } as unknown as Context

    apply(context)

    expect(tools.sort()).toEqual(['manifest', 'send_to_agent'])
    expect(skills).toEqual(['pdf-reference-reader'])
    expect(referencesProvider).toBe(1)
  })
})
