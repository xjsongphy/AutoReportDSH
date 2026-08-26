import { describe, expect, it } from 'vitest'
import { loadBundledSkills, parseBundledSkill } from '../src/workspace/skill-loader.js'

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
      'latex-compile',
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
})
