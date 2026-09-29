import { describe, expect, it } from 'vitest'
import { allSpecialistRoles, isAutoReportRole, isSpecialistRole, rolePolicy } from '../src/roles.js'

describe('fixed role table', () => {
  it('encodes the three-fact permission model per role', () => {
    expect(rolePolicy('MAIN')).toEqual({
      writableRoot: 'Outline',
      hasProcessTool: false,
      tools: ['read', 'list', 'grep', 'read_image', 'write', 'edit', 'skill', 'manifest', 'workflow_task', 'send_to_agent', 'ask_user_question', 'reference_extract', 'python_environment'],
    })
    expect(rolePolicy('THEORY')).toEqual({
      writableRoot: 'Theory',
      hasProcessTool: false,
      tools: ['read', 'list', 'grep', 'read_image', 'write', 'edit', 'skill', 'manifest', 'report_workflow'],
    })
    for (const role of ['DATA_ANALYSIS', 'PLOTTING', 'REPORT'] as const) {
      expect(rolePolicy(role).writableRoot).toBe(
        role === 'DATA_ANALYSIS' ? 'Data/Processed'
          : role === 'PLOTTING' ? 'Plots' : 'Report')
      expect(rolePolicy(role).hasProcessTool).toBe(true)
      expect(rolePolicy(role).tools).toEqual(
        ['read', 'list', 'grep', 'read_image', 'write', 'edit', 'skill', 'manifest', 'report_workflow', 'bash'])
    }
  })

  it('gives every role the BASE file pack over the whole workspace', () => {
    for (const role of ['MAIN', 'THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] as const) {
      const policy = rolePolicy(role)
      expect(policy.tools).toContain('read')
      expect(policy.tools).toContain('list')
      expect(policy.tools).toContain('grep')
      expect(policy.tools).toContain('write')
      expect(policy.tools).toContain('edit')
      expect(policy.writableRoot).not.toBe('.')
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
