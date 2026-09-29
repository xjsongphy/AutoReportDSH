import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/preset.js'

/** The preset contribution is intentionally small: no domain skills leak into MAIN. */
describe('autoreport preset contribution', () => {
  it('registers only the current fixed-workflow MAIN tools', () => {
    const tools: string[] = []
    const skills: string[] = []
    const sections: { name: string; text: string | ((render: { scope: unknown }) => string) }[] = []
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
        get: (name: string, scope: unknown) => scope === 'specialist' && ['send_to_agent', 'workflow_task'].includes(name)
          ? undefined
          : tools.includes(name) ? { name } : undefined,
        register: (definition: { name: string }) => {
          tools.push(definition.name)
          return () => {}
        },
      },
      skills: skillsService,
      systemPrompt: {
        section: (section: { name: string; text: string | ((render: { scope: unknown }) => string) }) => {
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

    expect(tools.sort()).toEqual(['install_python_package', 'manifest', 'reference_extract', 'send_to_agent', 'workflow_task'])
    expect(skills).toEqual([])
    expect(referencesProvider).toBe(1)
    // Tool-owned policy ships with the tools (master dsh convention): the two
    // sections carry the dispatch and task-board rules, not the persona.
    expect(sections.map(section => section.name)).toEqual(['tool:bash', 'tool:pwsh', 'tool:send_to_agent', 'tool:workflow_task'])
    const render = (index: number, scope: unknown): string => {
      const text = sections[index]?.text
      return typeof text === 'function' ? text({ scope }) : text ?? ''
    }
    expect(render(0, 'main')).toBe('')
    expect(render(1, 'main')).toBe('')
    expect(render(2, 'main')).toContain('Use `send_to_agent` for all subagent delegation')
    expect(render(2, 'main')).toContain('No technical relay')
    expect(render(3, 'main')).toContain('do not use generic todo tools')
    expect(render(2, 'specialist')).toBe('')
    expect(render(3, 'specialist')).toBe('')
  })
})
