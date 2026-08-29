import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBundledSkills, parseBundledSkill } from '../src/workspace/skill-loader.js'
import { seedSyncedResourceStubs } from './helpers/synced-resource-stubs.js'

const overlays: string[] = []
afterEach(() => {
  for (const dir of overlays.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function overlay(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-overlay-'))
  overlays.push(root)
  return seedSyncedResourceStubs(root)
}

describe('parseBundledSkill', () => {
  it('parses name and description frontmatter with the body', () => {
    const skill = parseBundledSkill('---\nname: my-skill\ndescription: "Does things."\n---\n\n# Body\n\nText.')
    expect(skill).toEqual({ name: 'my-skill', description: 'Does things.', content: '# Body\n\nText.' })
  })

  it('rejects documents without frontmatter, missing fields, or invalid names', () => {
    expect(parseBundledSkill('# No frontmatter')).toBeUndefined()
    expect(parseBundledSkill('---\ndescription: only description\n---\nBody')).toBeUndefined()
    expect(parseBundledSkill('---\nname: Bad_Name\ndescription: x\n---\nBody')).toBeUndefined()
  })

  it('rejects empty bodies', () => {
    expect(parseBundledSkill('---\nname: empty-body\ndescription: x\n---\n   \n')).toBeUndefined()
  })
})

describe('loadBundledSkills', () => {
  const skills = loadBundledSkills()

  it('loads every bundled skill document', () => {
    expect(skills.map(skill => skill.name)).toEqual([
      'experiment-report-writer',
      'pdf-reference-reader',
      'typst-compile',
    ])
  })

  it('returns unique names with non-empty bodies and descriptions', () => {
    const names = new Set(skills.map(skill => skill.name))
    expect(names.size).toBe(skills.length)
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(0)
      expect(skill.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('bundles a frozen current-writer projection without workflow-prompt instructions', () => {
    const writer = skills.find(skill => skill.name === 'experiment-report-writer')
    expect(writer?.content).toContain('38085aededa0')
    expect(writer?.content).toContain('Narrative requirements')
    expect(writer?.content).toContain('Claim ledger contract')
    expect(writer?.content).toContain('Document release gates')
    expect(writer?.content).not.toContain('report_workflow')
    expect(writer?.content).not.toContain('report_task')
    expect(writer?.content).not.toContain('REPORT role')
  })

  it('documents bash-driven LaTeX compilation without compile_report', () => {
    const latex = loadBundledSkills(overlay()).find(skill => skill.name === 'latex-compile')
    expect(latex?.content).toContain('latexmk')
    expect(latex?.content).toContain('Do not use `compile_report`')
  })

  it('merges overlay typst and latex-compile with bundled skills', () => {
    expect(loadBundledSkills(overlay()).map(skill => skill.name)).toEqual([
      'experiment-report-writer',
      'latex-compile',
      'pdf-reference-reader',
      'typst',
      'typst-compile',
    ])
  })

  it('includes pdf-reference-reader for MAIN PDF extraction', () => {
    const reader = skills.find(skill => skill.name === 'pdf-reference-reader')
    expect(reader?.content).toContain('mineru-open-api extract')
    expect(reader?.content).toContain('Outline/.cache/mineru/')
  })
})
