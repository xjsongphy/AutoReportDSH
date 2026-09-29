import { describe, expect, it } from 'vitest'
import { allSpecialistRoles, isAutoReportRole, isSpecialistRole, rolePolicy } from '../src/roles.js'

describe('fixed role table (PLAN 2.2)', () => {
  it('matches the plan policy matrix', () => {
    expect(rolePolicy('MAIN')).toEqual({ writableRoot: 'Outline', execution: 'none' })
    expect(rolePolicy('THEORY')).toEqual({ writableRoot: 'Theory', execution: 'none' })
    expect(rolePolicy('DATA_ANALYSIS')).toEqual({ writableRoot: 'Data/Processed', execution: 'shell' })
    expect(rolePolicy('PLOTTING')).toEqual({ writableRoot: 'Plots', execution: 'shell' })
    expect(rolePolicy('REPORT')).toEqual({ writableRoot: 'Report', execution: 'compile' })
  })

  it('narrows specialists and excludes MAIN', () => {
    expect(isSpecialistRole('MAIN')).toBe(false)
    expect(isSpecialistRole('THEORY')).toBe(true)
    expect(isAutoReportRole('MAIN')).toBe(true)
    expect(isAutoReportRole('plotting')).toBe(false)
    expect(allSpecialistRoles()).toEqual(['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'])
  })
})
