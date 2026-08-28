import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { Config } from '../src/config.js'
import { apply as applyHost } from '../src/host.js'
import {
  installReferencesSkills,
  REFERENCES_SKILL_PROVIDER,
  REFERENCES_SKILL_RANK,
} from '../src/skills-references.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempExperiment(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-references-'))
  tempDirs.push(root)
  return root
}

const skillMd = (name: string, description = `Skill ${name}`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

describe('installReferencesSkills', () => {
  it('no-ops when the skills service is missing', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(installReferencesSkills(ctx)).toEqual(expect.any(Function))
    expect(() => installReferencesSkills(ctx)()).not.toThrow()
  })

  it('lists flat markdown skills from References/skills for the experiment cwd', async () => {
    const experiment = tempExperiment()
    const skillsDir = join(experiment, 'References', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'foo.md'), skillMd('foo', 'Flat reference skill'))

    let provider: { list: (options: { cwd?: string }) => Promise<unknown[]> } | undefined
    const ctx = {
      get: (key: string) => (key === 'skills' ? { registerProvider: (factory: () => typeof provider) => {
        provider = factory()
        return () => {}
      } } : undefined),
    } as unknown as Context

    installReferencesSkills(ctx)
    expect(provider).toBeDefined()
    const listed = await provider!.list({ cwd: experiment })
    expect(listed).toEqual([{
      name: 'foo',
      description: 'Flat reference skill',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: REFERENCES_SKILL_PROVIDER,
      source: 'custom',
      rank: REFERENCES_SKILL_RANK,
      locator: { path: join(skillsDir, 'foo.md'), directory: skillsDir },
      path: join(skillsDir, 'foo.md'),
      resourceBase: { kind: 'directory', path: skillsDir },
    }])
  })

  it('lists directory bundles with SKILL.md', async () => {
    const experiment = tempExperiment()
    const bundle = join(experiment, 'References', 'skills', 'bar')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'SKILL.md'), skillMd('bar', 'Bundled reference skill'))

    let provider: { list: (options: { cwd?: string }) => Promise<unknown[]> } | undefined
    const ctx = {
      get: (key: string) => (key === 'skills' ? { registerProvider: (factory: () => typeof provider) => {
        provider = factory()
        return () => {}
      } } : undefined),
    } as unknown as Context

    installReferencesSkills(ctx)
    const listed = await provider!.list({ cwd: experiment })
    expect(listed.map((entry: { name: string }) => entry.name)).toEqual(['bar'])
  })

  it('returns an empty list when References/skills is missing', async () => {
    const experiment = tempExperiment()
    let provider: { list: (options: { cwd?: string }) => Promise<unknown[]> } | undefined
    const ctx = {
      get: (key: string) => (key === 'skills' ? { registerProvider: (factory: () => typeof provider) => {
        provider = factory()
        return () => {}
      } } : undefined),
    } as unknown as Context

    installReferencesSkills(ctx)
    await expect(provider!.list({ cwd: experiment })).resolves.toEqual([])
    await expect(provider!.list({})).resolves.toEqual([])
  })

  it('ignores dotfiles and symlinks that escape the References/skills root', async () => {
    const experiment = tempExperiment()
    const outside = tempExperiment()
    const skillsDir = join(experiment, 'References', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'keep.md'), skillMd('keep'))
    writeFileSync(join(skillsDir, '.hidden.md'), skillMd('hidden'))
    writeFileSync(join(outside, 'escape.md'), skillMd('escape'))
    symlinkSync(join(outside, 'escape.md'), join(skillsDir, 'escape-link.md'))

    let provider: { list: (options: { cwd?: string }) => Promise<{ name: string }[]> } | undefined
    const ctx = {
      get: (key: string) => (key === 'skills' ? { registerProvider: (factory: () => typeof provider) => {
        provider = factory()
        return () => {}
      } } : undefined),
    } as unknown as Context

    installReferencesSkills(ctx)
    const listed = await provider!.list({ cwd: experiment })
    expect(listed.map(entry => entry.name)).toEqual(['keep'])
  })

  it('loads skill bodies through get()', async () => {
    const experiment = tempExperiment()
    const skillsDir = join(experiment, 'References', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'foo.md'), skillMd('foo', 'Flat reference skill'))

    let provider: {
      list: (options: { cwd?: string }) => Promise<Array<{ name: string; locator: unknown; invocation: unknown }>>
      get: (candidate: unknown) => Promise<{ content: string } | undefined>
    } | undefined
    const ctx = {
      get: (key: string) => (key === 'skills' ? { registerProvider: (factory: () => typeof provider) => {
        provider = factory()
        return () => {}
      } } : undefined),
    } as unknown as Context

    installReferencesSkills(ctx)
    const [candidate] = await provider!.list({ cwd: experiment })
    const loaded = await provider!.get(candidate)
    expect(loaded?.content).toContain('# foo')
  })
})

describe('References/skills coexistence', () => {
  const hostConfig: Config = {
    defaultReportLanguage: 'latex',
    workspaceRoot: undefined,
    specialistModel: undefined,
    delegationWaitTimeoutMs: 600_000,
  }

  it('does not publish References/skills into the host catalog used by stock sessions', async () => {
    const experiment = tempExperiment()
    const skillsDir = join(experiment, 'References', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'foo.md'), skillMd('foo', 'Must stay AutoReport-scoped'))
    const home = tempExperiment()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.provide('tools', { guard: () => () => {} } as never)
    applyHost(ctx, { ...hostConfig, workspaceRoot: experiment }, { settingsHome: home })
    const listed = await ctx.skills.list({ cwd: experiment })
    expect(listed.map(skill => skill.name)).not.toContain('foo')
    expect(listed.some(skill => skill.provider === REFERENCES_SKILL_PROVIDER)).toBe(false)
  })
})
