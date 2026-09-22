import { describe, expect, it } from 'vitest'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { skillNamesForRole, registerMainSkills, registerRoleSkills, MAIN_SKILL_NAMES } from '../src/skills-preset.js'

/** Capture one registration; `resourceBase` presence is part of what we assert. */
function recorder(): { registrations: SkillRegistration[]; register: (registration: SkillRegistration) => () => void } {
  const registrations: SkillRegistration[] = []
  return {
    registrations,
    register: registration => {
      registrations.push(registration)
      return () => {}
    },
  }
}

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

  it('gives REPORT the writer, the active compiler, and that language\'s references', () => {
    expect(skillNamesForRole('REPORT', 'latex')).toEqual([
      'experiment-report-writer', 'latex-compile',
    ])
    expect(skillNamesForRole('REPORT', 'typst')).toEqual([
      'experiment-report-writer', 'typst', 'typst-compile',
    ])
  })

  it('does not register the active language guidance as a skill', () => {
    // The report-language files are appended to the REPORT system prompt, so a
    // load of `report-language-<lang>` is not a step any child must take.
    const skills = recorder()
    registerRoleSkills({ skills } as never, 'REPORT', 'latex')
    expect(skills.registrations.map(skill => skill.name)).not.toContain('report-language-latex')
    skills.registrations.length = 0
    registerRoleSkills({ skills } as never, 'REPORT', 'typst')
    expect(skills.registrations.map(skill => skill.name)).not.toContain('report-language-typst')
  })

  it('registers REPORT runtime skills on the child context', () => {
    const skills = recorder()
    registerRoleSkills({ skills } as never, 'REPORT', 'latex')
    expect(skills.registrations.map(skill => skill.name)).toEqual([
      'experiment-report-writer', 'latex-compile',
    ])
    skills.registrations.length = 0
    registerRoleSkills({ skills } as never, 'REPORT', 'typst')
    expect(skills.registrations.map(skill => skill.name)).toEqual([
      'experiment-report-writer', 'typst', 'typst-compile',
    ])
  })

  it('anchors the skills that ship sibling documents and only those', () => {
    const skills = recorder()
    registerRoleSkills({ skills } as never, 'REPORT', 'typst')
    const byName = new Map(skills.registrations.map(skill => [skill.name, skill]))
    const writer = byName.get('experiment-report-writer')?.resourceBase
    const typst = byName.get('typst')?.resourceBase
    expect(writer).toMatchObject({ kind: 'directory' })
    expect(typst).toMatchObject({ kind: 'directory' })
    expect((writer as { path: string }).path).toContain('experiment-report-writer')
    expect((typst as { path: string }).path).toContain('typst/skills/typst')
    // A flat document whose prose names workspace paths must NOT carry a base:
    // DSH tells the model to resolve those paths against it.
    expect(byName.get('typst-compile')?.resourceBase).toBeUndefined()
    expect(byName.get('latex-compile')?.resourceBase).toBeUndefined()
  })

  it('fails loud when the child skills service is missing', () => {
    expect(() => registerRoleSkills({} as never, 'REPORT', 'latex')).toThrow(/ctx\.skills\.register/)
    expect(() => registerMainSkills({} as never)).toThrow(/ctx\.skills\.register/)
  })

  it('registers MAIN-only pdf skills in the preset scope', () => {
    const skills: string[] = []
    const context = {
      skills: {
        register: (registration: SkillRegistration) => {
          skills.push(registration.name)
          return () => {}
        },
      },
    }
    registerMainSkills(context as never)
    expect(skills).toEqual([...MAIN_SKILL_NAMES])
  })

  it('invokes skills.register as a method so DSH SkillService keeps this.ctx', () => {
    class FakeSkills {
      ctx = { ok: true }
      names: string[] = []
      register(registration: SkillRegistration) {
        if (this.ctx === undefined) throw new Error('lost this')
        this.names.push(registration.name)
        return () => {}
      }
    }
    const skills = new FakeSkills()
    registerMainSkills({ skills } as never)
    expect(skills.names).toEqual([...MAIN_SKILL_NAMES])
  })
})
