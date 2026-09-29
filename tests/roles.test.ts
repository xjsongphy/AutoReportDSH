import { describe, expect, it } from 'vitest'
import { allSpecialistRoles, isAutoReportRole, isSpecialistRole, rolePolicy } from '../src/roles.js'

describe('fixed role table (PLAN 2.2)', () => {
  it('matches the plan policy matrix', () => {
    expect(rolePolicy('MAIN')).toEqual({
      cwd: '.', discoverableRoots: ['.'],
      readableRoots: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
      writableRoots: ['Outline'], process: 'none', processCommands: [],
      tools: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'workflow_task', 'send_to_agent', 'ask_user_question', 'python_environment', 'reference_extract'],
      network: 'allow', temp: 'private',
    })
    expect(rolePolicy('THEORY').writableRoots).toEqual(['Theory'])
    expect(rolePolicy('DATA_ANALYSIS').writableRoots).toEqual(['Data/Processed'])
    expect(rolePolicy('DATA_ANALYSIS').cwd).toBe('.')
    expect(rolePolicy('PLOTTING').writableRoots).toEqual(['Plots'])
    expect(rolePolicy('REPORT').writableRoots).toEqual(['Report'])
    const discoverableRoots = {
      MAIN: ['.'],
      THEORY: ['References', 'Outline', 'Theory'],
      DATA_ANALYSIS: ['References', 'Outline', 'Theory', 'Data'],
      PLOTTING: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots'],
      REPORT: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
    } as const
    const readableRoots = {
      MAIN: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
      THEORY: ['References', 'Outline', 'Theory'],
      DATA_ANALYSIS: ['References', 'Outline', 'Theory', 'Data'],
      PLOTTING: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots'],
      REPORT: ['References', 'Outline', 'Theory', 'Data/Processed', 'Plots', 'Report'],
    } as const
    const tools = {
      MAIN: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'workflow_task', 'send_to_agent', 'ask_user_question', 'python_environment', 'reference_extract'],
      THEORY: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow'],
      DATA_ANALYSIS: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow', 'bash'],
      PLOTTING: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow', 'bash'],
      REPORT: ['read', 'read_image', 'write', 'edit', 'delete', 'apply_patch', 'str_replace_editor', 'list', 'grep', 'skill', 'manifest', 'report_workflow', 'bash'],
    } as const
    for (const role of ['MAIN', 'THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] as const) {
      expect(rolePolicy(role).network).toBe('allow')
      expect(rolePolicy(role).temp).toBe('private')
      expect(rolePolicy(role).discoverableRoots).toEqual(discoverableRoots[role])
      expect(rolePolicy(role).readableRoots).toEqual(readableRoots[role])
      expect(rolePolicy(role).tools).toEqual(tools[role])
      expect(rolePolicy(role).cwd).toBe('.')
    }
    expect(rolePolicy('MAIN').process).toBe('none')
    expect(rolePolicy('MAIN').processCommands).toEqual([])
    expect(rolePolicy('THEORY').process).toBe('none')
    for (const role of ['DATA_ANALYSIS', 'PLOTTING', 'REPORT'] as const) {
      expect(rolePolicy(role).process).toBe('role-aware')
      expect(rolePolicy(role).processCommands.length).toBeGreaterThan(0)
    }
  })

  it('narrows specialists and excludes MAIN', () => {
    expect(isSpecialistRole('MAIN')).toBe(false)
    expect(isSpecialistRole('THEORY')).toBe(true)
    expect(isAutoReportRole('MAIN')).toBe(true)
    expect(isAutoReportRole('plotting')).toBe(false)
    expect(allSpecialistRoles()).toEqual(['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'])
  })
})
