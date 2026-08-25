import { describe, expect, it } from 'vitest'
import { allSpecialistRoles, isAutoReportRole, isSpecialistRole, rolePolicy } from '../src/roles.js'

describe('fixed role table (PLAN 2.2)', () => {
  it('matches the plan policy matrix', () => {
    expect(rolePolicy('MAIN')).toEqual({
      cwd: '.', readableRoots: ['.'], writableRoots: ['Outline'], network: 'deny', temp: 'private',
    })
    expect(rolePolicy('THEORY').writableRoots).toEqual(['Theory'])
    expect(rolePolicy('DATA_ANALYSIS').writableRoots).toEqual(['Data/Processed'])
    expect(rolePolicy('DATA_ANALYSIS').cwd).toBe('Data')
    expect(rolePolicy('PLOTTING').writableRoots).toEqual(['Plots'])
    expect(rolePolicy('REPORT').writableRoots).toEqual(['Report'])
    for (const role of ['MAIN', 'THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] as const) {
      expect(rolePolicy(role).network).toBe('deny')
      expect(rolePolicy(role).temp).toBe('private')
      expect(rolePolicy(role).readableRoots).toEqual(['.'])
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
