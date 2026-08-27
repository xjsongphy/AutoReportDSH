import { describe, expect, it } from 'vitest'
import { skillNamesForRole } from '../src/skills-preset.js'

describe('AutoReport role-scoped domain skills', () => {
  it('keeps domain skills out of MAIN and unrelated specialists', () => {
    expect(skillNamesForRole('DATA_ANALYSIS', 'latex')).toEqual([])
    expect(skillNamesForRole('PLOTTING', 'typst')).toEqual([])
  })

  it('limits MinerU to reference-consuming roles', () => {
    expect(skillNamesForRole('THEORY', 'latex')).toEqual(['mineru'])
    expect(skillNamesForRole('REPORT', 'latex')).toContain('mineru')
    expect(skillNamesForRole('DATA_ANALYSIS', 'latex')).not.toContain('mineru')
    expect(skillNamesForRole('PLOTTING', 'latex')).not.toContain('mineru')
  })

  it('gives REPORT only the active compilation skill plus writing guidance', () => {
    expect(skillNamesForRole('REPORT', 'latex')).toEqual([
      'experiment-report-writer', 'latex-compile', 'mineru',
    ])
    expect(skillNamesForRole('REPORT', 'typst')).toEqual([
      'experiment-report-writer', 'typst-compile', 'mineru',
    ])
  })
})
