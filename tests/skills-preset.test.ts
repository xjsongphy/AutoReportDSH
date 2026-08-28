import { describe, expect, it } from 'vitest'
import { skillNamesForRole, registerMainSkills, registerRoleSkills, MAIN_SKILL_NAMES } from '../src/skills-preset.js'

describe('AutoReport role-scoped domain skills', () => {
  it('keeps domain skills out of unrelated specialists', () => {
    expect(skillNamesForRole('THEORY', 'latex')).toEqual([])
    expect(skillNamesForRole('DATA_ANALYSIS', 'latex')).toEqual([])
    expect(skillNamesForRole('PLOTTING', 'typst')).toEqual([])
  })

  it('does not give THEORY or REPORT MinerU — MAIN extracts PDFs', () => {
    expect(skillNamesForRole('THEORY', 'latex')).not.toContain('mineru')
    expect(skillNamesForRole('REPORT', 'latex')).not.toContain('mineru')
    expect(skillNamesForRole('REPORT', 'typst')).not.toContain('mineru')
  })

  it('gives REPORT only the active compilation skill plus writing guidance', () => {
    expect(skillNamesForRole('REPORT', 'latex')).toEqual([
      'experiment-report-writer', 'latex-compile',
    ])
    expect(skillNamesForRole('REPORT', 'typst')).toEqual([
      'experiment-report-writer', 'typst-compile',
    ])
  })

  it('registers REPORT runtime skills on the child context', () => {
    const skills: string[] = []
    const sections: string[] = []
    const context = {
      skills: {
        register: (registration: { name: string }) => {
          skills.push(registration.name)
          return () => {}
        },
      },
      systemPrompt: {
        section: (section: { name: string }) => {
          sections.push(section.name)
          return () => {}
        },
      },
    }
    registerRoleSkills(context, 'REPORT', 'latex')
    expect(skills).toEqual(['experiment-report-writer', 'latex-compile'])
    expect(sections).toEqual([])
  })

  it('falls back to system prompt sections when child skills are unavailable', () => {
    const sections: string[] = []
    const context = {
      systemPrompt: {
        section: (section: { name: string }) => {
          sections.push(section.name)
          return () => {}
        },
      },
    }
    registerRoleSkills(context, 'REPORT', 'latex')
    expect(sections).toEqual([
      'autoreport:skill:experiment-report-writer',
      'autoreport:skill:latex-compile',
    ])
  })

  it('registers MAIN-only pdf skills in the preset scope', () => {
    const skills: string[] = []
    const context = {
      skills: {
        register: (registration: { name: string }) => {
          skills.push(registration.name)
          return () => {}
        },
      },
    }
    registerMainSkills(context)
    expect(skills).toEqual([...MAIN_SKILL_NAMES])
  })
})
