import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBundledSkills, loadReportLanguageGuidance, parseBundledSkill } from '../src/workspace/skill-loader.js'
import { resourcesRoot } from '../src/workspace/init.js'

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

  it('loads every bundled skill document and nothing else', () => {
    expect(skills.map(skill => skill.name)).toEqual([
      'experiment-report-writer',
      'latex-compile',
      'pdf-reference-reader',
      'typst',
      'typst-compile',
    ])
  })

  it('does not offer report-language guidance as a skill', () => {
    // It is fixed prompt prose now: a REPORT child receives it before its first
    // step, so publishing it as a skill would only add a load nobody must make.
    expect(skills.map(skill => skill.name)).not.toContain('report-language-latex')
    expect(skills.map(skill => skill.name)).not.toContain('report-language-typst')
  })

  it('returns unique names with non-empty bodies and descriptions', () => {
    const names = new Set(skills.map(skill => skill.name))
    expect(names.size).toBe(skills.length)
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(0)
      expect(skill.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('publishes a resource base exactly for the skills that ship sibling documents', () => {
    const bundles = skills.filter(skill => skill.directory !== undefined).map(skill => skill.name)
    expect(bundles).toEqual(['experiment-report-writer', 'typst'])
    for (const skill of skills) {
      if (skill.directory !== undefined) expect(skill.directory).toBe(dirname(skill.path))
    }
  })

  it('gives the bundle skills a base that actually contains what their bodies link to', () => {
    for (const skill of skills) {
      if (skill.directory === undefined) continue
      const targets = [...skill.content.matchAll(/\]\(([^)#\s]+)\)/gu)]
        .map(match => match[1] as string)
        .filter(target => !/^[a-z]+:/iu.test(target))
      expect(targets.length).toBeGreaterThan(0)
      for (const target of targets) {
        expect(() => readFileSync(join(skill.directory as string, target), 'utf8')).not.toThrow()
      }
    }
  })

  it('omits the base for skills whose prose addresses the experiment workspace', () => {
    for (const name of ['latex-compile', 'typst-compile', 'pdf-reference-reader']) {
      expect(skills.find(skill => skill.name === name)?.directory).toBeUndefined()
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

  it('keeps the frozen-writer provenance beside the skill that cites it', () => {
    const writer = skills.find(skill => skill.name === 'experiment-report-writer')
    expect(writer?.directory).toBe(join(resourcesRoot(), 'skills', 'experiment-report-writer'))
    const provenance = JSON.parse(readFileSync(join(writer?.directory as string, 'provenance.json'), 'utf8')) as { target: string }
    expect(provenance.target).toBe('resources/skills/experiment-report-writer/SKILL.md')
    expect(writer?.content).toContain('[`provenance.json`](provenance.json)')
  })

  it('documents bash-driven LaTeX compilation without compile_report', () => {
    const latex = skills.find(skill => skill.name === 'latex-compile')
    expect(latex?.content).toContain('latexmk')
    expect(latex?.content).toContain('Do not use `compile_report`')
  })

  it('keeps the typst bundle free of workspace paths its base would mis-resolve', () => {
    const typst = skills.find(skill => skill.name === 'typst')
    expect(typst?.content).toContain('[basics.md](basics.md)')
    // The compile command was a second, redundant copy of `typst-compile`'s job,
    // and it was the one workspace path the DSH resource anchor would have
    // resolved against the skill directory.
    expect(typst?.content).not.toContain('typst compile Report/main.typ')
    expect(typst?.content).toContain('typst-compile')
  })

  it('leaves no dangling link inside the typst reference bundle', () => {
    const typst = skills.find(skill => skill.name === 'typst')
    const directory = typst?.directory as string
    const files = ['basics.md', 'styling.md', 'tables.md', 'academic.md']
    for (const file of files) {
      const body = readFileSync(join(directory, file), 'utf8')
      for (const match of body.matchAll(/\]\(([^)#\s]+)\)/gu)) {
        const target = match[1] as string
        if (/^[a-z]+:/iu.test(target)) continue
        expect(() => readFileSync(join(directory, target), 'utf8')).not.toThrow()
      }
    }
  })

  it('includes pdf-reference-reader for MAIN PDF extraction', () => {
    const reader = skills.find(skill => skill.name === 'pdf-reference-reader')
    expect(reader?.content).toContain('mineru-open-api extract')
    expect(reader?.content).toContain('Outline/.cache/mineru/')
  })
})

describe('loadReportLanguageGuidance', () => {
  it('returns prompt prose with no skill frontmatter', () => {
    const latex = loadReportLanguageGuidance('latex')
    expect(latex).toContain('# Active report language: LaTeX')
    // No frontmatter is what makes this text not a catalog entry.
    expect(latex.startsWith('---')).toBe(false)
    expect(latex).not.toContain('name: report-language-latex')
    expect(latex).toContain('Use `[H]` for every figure and table unless the user-provided template explicitly requires another placement policy')
  })

  it('selects the text for the requested language and names its skills', () => {
    expect(loadReportLanguageGuidance('typst')).toContain('# Active report language: Typst')
    expect(loadReportLanguageGuidance('typst')).toContain('do not use LaTeX commands')
    expect(loadReportLanguageGuidance('typst')).toContain('`typst-compile`')
    expect(loadReportLanguageGuidance('typst')).not.toContain('LaTeX layout rules')
  })
})
