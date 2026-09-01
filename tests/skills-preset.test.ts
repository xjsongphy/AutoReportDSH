import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { skillNamesForRole, registerMainSkills, registerRoleSkills, MAIN_SKILL_NAMES } from '../src/skills-preset.js'
import { seedSyncedResourceStubs } from './helpers/synced-resource-stubs.js'

const overlays: string[] = []
afterEach(() => {
  for (const dir of overlays.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function overlay(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-skills-overlay-'))
  overlays.push(root)
  return seedSyncedResourceStubs(root)
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

  it('gives REPORT only the active compilation skill plus writing guidance', () => {
    expect(skillNamesForRole('REPORT', 'latex')).toEqual([
      'experiment-report-writer', 'report-language-latex', 'latex-compile',
    ])
    expect(skillNamesForRole('REPORT', 'typst')).toEqual([
      'experiment-report-writer', 'report-language-typst', 'typst', 'typst-compile',
    ])
  })

  it('registers REPORT runtime skills on the child context', () => {
    const skills: { name: string; content: string }[] = []
    const context = {
      skills: {
        register: (registration: { name: string; content: string }) => {
          skills.push(registration)
          return () => {}
        },
      },
    }
    registerRoleSkills(context, 'REPORT', 'latex', overlay())
    expect(skills.map(skill => skill.name)).toEqual([
      'experiment-report-writer', 'report-language-latex', 'latex-compile',
    ])
    expect(skills.find(skill => skill.name === 'report-language-latex')?.content).toContain(
      'Use `[H]` for every figure and table unless the user-provided template explicitly requires another placement policy',
    )
    skills.length = 0
    registerRoleSkills(context, 'REPORT', 'typst', overlay())
    expect(skills.map(skill => skill.name)).toEqual([
      'experiment-report-writer', 'report-language-typst', 'typst', 'typst-compile',
    ])
    expect(skills.find(skill => skill.name === 'report-language-typst')?.content).toContain(
      'do not use LaTeX commands',
    )
  })

  it('fails loud when the child skills service is missing', () => {
    expect(() => registerRoleSkills({} as never, 'REPORT', 'latex')).toThrow(/ctx\.skills\.register/)
    expect(() => registerMainSkills({} as never)).toThrow(/ctx\.skills\.register/)
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

  it('invokes skills.register as a method so DSH SkillService keeps this.ctx', () => {
    class FakeSkills {
      ctx = { ok: true }
      names: string[] = []
      register(registration: { name: string }) {
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
