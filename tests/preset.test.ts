import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/preset.js'

/** The preset contribution is intentionally small: no domain skills leak into MAIN. */
describe('autoreport preset contribution', () => {
  it('registers only the current fixed-workflow MAIN tools', () => {
    const tools: string[] = []
    const skills: string[] = []
    const sections: { name: string; text: string }[] = []
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
      systemPrompt: {
        section: (section: { name: string; text: string }) => {
          sections.push(section)
          return () => {}
        },
        getSectionOrder: () => 2900,
      },
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

    expect(tools.sort()).toEqual([
      'extract_pdf', 'install_python_package', 'manifest', 'send_to_agent', 'workflow_task',
    ])
    expect(skills).toEqual([])
    expect(referencesProvider).toBe(1)
    // Tool-owned policy ships with the tools (master dsh convention): the two
    // sections carry the dispatch and task-board rules, not the persona.
    expect(sections.map(section => section.name)).toEqual([
      'tool:bash', 'tool:pwsh', 'tool:send_to_agent', 'tool:workflow_task',
    ])
    expect(sections.find(section => section.name === 'tool:send_to_agent')?.text).toBeTypeOf('function')
    expect(sections.find(section => section.name === 'tool:workflow_task')?.text).toBeTypeOf('function')
  })
})
