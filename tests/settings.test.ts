import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import {
  AUTO_REPORT_PROJECT_SETTINGS_SCHEMA,
  AUTO_REPORT_USER_SETTINGS_SCHEMA,
  loadProjectSettings,
  projectSettingsPath,
  resolveWorkflowSettings,
  saveProjectSettings,
  WORKFLOW_SETTINGS_SCHEMA_DEFAULTS,
  workspaceIdForRoot,
} from '../src/settings.js'
import { createReportInitCommand } from '../src/workspace/command.js'

const cleanup: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

/** Distinct per-layer sentinels so every precedence winner is observable. */
const COMPOSITION = {
  defaultReportLanguage: 'latex',
  defaultLatexEngine: 'latexmk',
  specialistModel: { provider: 'comp-provider', model: 'comp-model' },
  delegationWaitTimeoutMs: 1000,
  executionTimeoutMs: 1000,
  pythonExecutable: '/comp/python',
} as const

const USER = {
  defaultReportLanguage: 'typst',
  defaultLatexEngine: 'tectonic',
  specialistModel: { provider: 'user-provider', model: 'user-model', reasoningEffort: 'high' },
  delegationWaitTimeoutMs: 2000,
  executionTimeoutMs: 2000,
  pythonExecutable: '/user/python',
} as const

const PROJECT = {
  reportLanguage: 'latex',
  latexEngine: 'tectonic',
  specialistModel: { provider: 'project-provider', model: 'project-model' },
  delegationWaitTimeoutMs: 3000,
  executionTimeoutMs: 3000,
  pythonExecutable: '/project/python',
} as const

const OVERRIDE = {
  reportLanguage: 'typst',
  latexEngine: 'latexmk',
  specialistModel: { inheritMain: true },
  delegationWaitTimeoutMs: 4000,
  executionTimeoutMs: 4000,
  pythonExecutable: '/override/python',
} as const

describe('resolveWorkflowSettings precedence', () => {
  it('falls through to schema defaults when every layer is absent', () => {
    expect(resolveWorkflowSettings({})).toEqual({
      reportLanguage: 'latex',
      latexEngine: 'latexmk',
      specialistModel: { inheritMain: true },
      delegationWaitTimeoutMs: 600_000,
      executionTimeoutMs: 600_000,
    })
    // The documented-defaults constant mirrors the schema layer exactly.
    expect(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS).toMatchObject({ reportLanguage: 'latex', latexEngine: 'latexmk', delegationWaitTimeoutMs: 600_000 })
  })

  it('applies each single layer above the schema defaults', () => {
    expect(resolveWorkflowSettings({ composition: COMPOSITION })).toEqual({
      reportLanguage: 'latex',
      latexEngine: 'latexmk',
      specialistModel: { inheritMain: false, provider: 'comp-provider', model: 'comp-model' },
      delegationWaitTimeoutMs: 1000,
      executionTimeoutMs: 1000,
      pythonExecutable: '/comp/python',
    })
    expect(resolveWorkflowSettings({ user: USER })).toEqual({
      reportLanguage: 'typst',
      latexEngine: 'tectonic',
      specialistModel: { inheritMain: false, provider: 'user-provider', model: 'user-model', reasoningEffort: 'high' },
      delegationWaitTimeoutMs: 2000,
      executionTimeoutMs: 2000,
      pythonExecutable: '/user/python',
    })
    expect(resolveWorkflowSettings({ project: PROJECT })).toEqual({
      reportLanguage: 'latex',
      latexEngine: 'tectonic',
      specialistModel: { inheritMain: false, provider: 'project-provider', model: 'project-model' },
      delegationWaitTimeoutMs: 3000,
      executionTimeoutMs: 3000,
      pythonExecutable: '/project/python',
    })
  })

  it('walks the full chain downward when higher layers drop out', () => {
    const all = { override: OVERRIDE, project: PROJECT, user: USER, composition: COMPOSITION }
    expect(resolveWorkflowSettings(all)).toMatchObject({
      reportLanguage: 'typst',
      latexEngine: 'latexmk',
      delegationWaitTimeoutMs: 4000,
      executionTimeoutMs: 4000,
      pythonExecutable: '/override/python',
      specialistModel: { inheritMain: true },
    })
    const withoutOverride = (({ override: _drop, ...rest }) => rest)(all)
    expect(resolveWorkflowSettings(withoutOverride)).toMatchObject({
      reportLanguage: 'latex',
      latexEngine: 'tectonic',
      delegationWaitTimeoutMs: 3000,
      executionTimeoutMs: 3000,
      pythonExecutable: '/project/python',
      specialistModel: { provider: 'project-provider' },
    })
    const withoutProject = (({ project: _drop, ...rest }) => rest)(withoutOverride)
    expect(resolveWorkflowSettings(withoutProject)).toMatchObject({
      reportLanguage: 'typst',
      latexEngine: 'tectonic',
      delegationWaitTimeoutMs: 2000,
      executionTimeoutMs: 2000,
      pythonExecutable: '/user/python',
      specialistModel: { provider: 'user-provider', reasoningEffort: 'high' },
    })
    const withoutUser = (({ user: _drop, ...rest }) => rest)(withoutProject)
    expect(resolveWorkflowSettings(withoutUser)).toMatchObject({
      reportLanguage: 'latex',
      latexEngine: 'latexmk',
      delegationWaitTimeoutMs: 1000,
      executionTimeoutMs: 1000,
      pythonExecutable: '/comp/python',
      specialistModel: { provider: 'comp-provider' },
    })
  })

  it('merges sparse layers field by field', () => {
    const resolved = resolveWorkflowSettings({
      composition: COMPOSITION,
      user: { defaultLatexEngine: 'tectonic' },
      project: { reportLanguage: 'typst' },
      override: { delegationWaitTimeoutMs: 42 },
    })
    expect(resolved).toEqual({
      reportLanguage: 'typst',
      latexEngine: 'tectonic',
      specialistModel: { inheritMain: false, provider: 'comp-provider', model: 'comp-model' },
      delegationWaitTimeoutMs: 42,
      executionTimeoutMs: 42,
      pythonExecutable: '/comp/python',
    })
  })

  it('accepts deprecated executionTimeoutMs alias in override layers', () => {
    expect(resolveWorkflowSettings({ override: { executionTimeoutMs: 77 } }).delegationWaitTimeoutMs).toBe(77)
    expect(resolveWorkflowSettings({ override: { executionTimeoutMs: 77 } }).executionTimeoutMs).toBe(77)
  })

  it('accepts a plain route shorthand on the override and fails loud on garbage', () => {
    expect(resolveWorkflowSettings({ override: { specialistModel: { provider: 'p', model: 'm' } } }).specialistModel)
      .toEqual({ inheritMain: false, provider: 'p', model: 'm' })
    // Schemastery materializes absent nested objects as {}; that artifact
    // reads as ABSENT (inherit Main), never as a phantom route.
    expect(resolveWorkflowSettings({ override: { specialistModel: {} as never } }).specialistModel)
      .toEqual({ inheritMain: true })
    // An INCOMPLETE non-empty route fails loud instead of half-configuring.
    expect(() => resolveWorkflowSettings({ override: { specialistModel: { provider: 'only-provider' } as never } }))
      .toThrow(/specialistModel/)
    expect(() => resolveWorkflowSettings({ override: { reportLanguage: 'markdown' as never } })).toThrow(/reportLanguage/)
    expect(() => resolveWorkflowSettings({ project: { latexEngine: 'pandoc' as never } })).toThrow(/latexEngine/)
    expect(() => resolveWorkflowSettings({ user: { delegationWaitTimeoutMs: 0 } })).toThrow(/delegationWaitTimeoutMs/)
    expect(() => resolveWorkflowSettings({ composition: { specialistModel: { provider: '', model: 'm' } } })).toThrow(/specialistModel/)
  })
})

describe('specialist model resolution representation', () => {
  it('records explicit Main inheritance only when nothing configures a route', () => {
    expect(resolveWorkflowSettings({}).specialistModel).toEqual({ inheritMain: true })
    expect(resolveWorkflowSettings({
      composition: { ...COMPOSITION, specialistModel: undefined },
      project: { executionTimeoutMs: 1 },
    }).specialistModel).toEqual({ inheritMain: true })
  })

  it('records a concrete route with reasoningEffort preserved and frozen', () => {
    const selection = resolveWorkflowSettings({ user: USER }).specialistModel
    expect(selection).toEqual({
      inheritMain: false,
      provider: 'user-provider',
      model: 'user-model',
      reasoningEffort: 'high',
    })
    expect(Object.isFrozen(selection)).toBe(true)
  })

  it('lets an explicit inheritMain:true override beat lower concrete routes', () => {
    const resolved = resolveWorkflowSettings({ project: PROJECT, override: { specialistModel: { inheritMain: true } } })
    expect(resolved.specialistModel).toEqual({ inheritMain: true })
  })
})

describe('snapshot immutability', () => {
  it('freezes the snapshot deeply and stays detached from later input mutation', () => {
    // Project-only resolution so every mutated field is observable in the
    // result (no higher layer masking the values under test).
    const project: Record<string, unknown> = { ...PROJECT }
    const resolved = resolveWorkflowSettings({ project: project as never })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.specialistModel)).toBe(true)

    // Later edits to the caller's input layer must never leak into the
    // committed snapshot (PLAN.md §2.14: settings changes never mutate an
    // in-flight report).
    project['reportLanguage'] = 'typst'
    project['latexEngine'] = 'latexmk'
    project['delegationWaitTimeoutMs'] = 999_999
    project['specialistModel'] = { provider: 'mutated', model: 'mutated' }

    expect(resolved.reportLanguage).toBe('latex')
    expect(resolved.latexEngine).toBe('tectonic')
    expect(resolved.delegationWaitTimeoutMs).toBe(3000)
    expect(resolved.executionTimeoutMs).toBe(3000)
    expect(resolved.specialistModel).toEqual({ inheritMain: false, provider: 'project-provider', model: 'project-model' })
  })
})

describe('project settings persistence', () => {
  it('derives a stable path-keyed id outside the experiment workspace', () => {
    const root = tempDir('autoreport-ws-')
    const id = workspaceIdForRoot(root)
    expect(id).toMatch(/^[a-z0-9]{16}$/u)
    expect(workspaceIdForRoot(`${root}/`)).toBe(id)
    expect(workspaceIdForRoot(join(root, 'other'))).not.toBe(id)
    const path = projectSettingsPath(undefined, id)
    expect(path.endsWith(join('autoreport', id, 'project.json'))).toBe(true)
    expect(path.startsWith(resolveDshHome())).toBe(true)
    expect(path).not.toContain(root)
    expect(() => projectSettingsPath(undefined, '../escape')).toThrow(/workspace id/)
  })

  it('tolerates a missing file as the empty patch and roundtrips saves atomically', () => {
    const home = tempDir('autoreport-home-')
    const workspaceId = workspaceIdForRoot('/some/experiment')
    expect(loadProjectSettings(home, workspaceId)).toEqual({})
    expect(existsSync(join(home, 'autoreport'))).toBe(false)

    saveProjectSettings(home, workspaceId, { reportLanguage: 'typst', delegationWaitTimeoutMs: 5000 })
    const directory = join(home, 'autoreport', workspaceId)
    expect(JSON.parse(readFileSync(join(directory, 'project.json'), 'utf8')))
      .toEqual({ reportLanguage: 'typst', delegationWaitTimeoutMs: 5000 })
    expect(loadProjectSettings(home, workspaceId)).toEqual({ reportLanguage: 'typst', delegationWaitTimeoutMs: 5000 })
    // Atomic rename leaves no temporary siblings behind.
    expect(readdirSync(directory)).toEqual(['project.json'])

    saveProjectSettings(home, workspaceId, {})
    expect(loadProjectSettings(home, workspaceId)).toEqual({})
    expect(readdirSync(directory)).toEqual(['project.json'])
  })

  it('validates writes and loads loud against the project schema', () => {
    const home = tempDir('autoreport-home-')
    const workspaceId = workspaceIdForRoot('/another/workspace')
    expect(() => saveProjectSettings(home, workspaceId, { reportLanguage: 'markdown' as never })).toThrow()
    const file = projectSettingsPath(home, workspaceId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ not json')
    expect(() => loadProjectSettings(home, workspaceId)).toThrow(/not valid JSON/)
    writeFileSync(file, '[1, 2]')
    expect(() => loadProjectSettings(home, workspaceId)).toThrow(/JSON object/)
    writeFileSync(file, JSON.stringify({ reportLanguage: 'kotlin' }))
    expect(() => loadProjectSettings(home, workspaceId)).toThrow()
  })

  it('exposes schemas whose standalone resolution carries documented defaults', () => {
    const user = AUTO_REPORT_USER_SETTINGS_SCHEMA({}) as Record<string, unknown>
    expect(user['defaultReportLanguage']).toBe('latex')
    expect(user['defaultLatexEngine']).toBe('latexmk')
    expect(user['delegationWaitTimeoutMs']).toBe(600_000)
    // Schemastery materializes the nested route object as {}; storage and
    // resolution treat that artifact as absent (covered by the roundtrip and
    // inheritance tests).
  })
})

describe('report-init --language coexistence', () => {
  function invocation(rawInput: string, cwd?: string): CommandInvocation {
    return {
      commandId: 'cmd-1' as CommandInvocation['commandId'],
      agent: { session: { header: { cwd } } },
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    } as unknown as CommandInvocation
  }

  /** Real store seam wired exactly like host.ts over one temp harness home. */
  function factoryWithHome(home: string) {
    return createReportInitCommand({
      reportLanguage: 'latex',
      projectStore: root => ({
        load: () => loadProjectSettings(home, workspaceIdForRoot(root)),
        save: next => saveProjectSettings(home, workspaceIdForRoot(root), next),
      }),
    })
  }

  it('materializes both backends side by side while the project language rules', async () => {
    const home = tempDir('autoreport-cmdhome-')
    const definition = factoryWithHome(home)
    const root = tempDir('autoreport-coexist-')

    const latex = await definition.handler(invocation(`--language latex ${root}`))
    expect(latex.kind).toBe('success')
    if (latex.kind === 'success') expect(latex.text).toContain('report language: latex (saved to project settings)')
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)

    // Explicit switch materializes ONLY missing typst files; latex files are
    // never touched (they are outside the typst set), so both backends coexist.
    const typst = await definition.handler(invocation(`--language typst ${root}`))
    expect(typst.kind).toBe('success')
    if (typst.kind === 'success') expect(typst.text).toContain('+ Report/main.typ')
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)
    expect(existsSync(join(root, 'Report/mpltx.cls'))).toBe(true)
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    expect(loadProjectSettings(home, workspaceIdForRoot(root))).toEqual({ reportLanguage: 'typst' })

    // No flag: the stored project language wins over composition defaults;
    // nothing new is written because every file already exists.
    const implicit = await definition.handler(invocation(root))
    expect(implicit.kind).toBe('success')
    if (implicit.kind === 'success') {
      expect(implicit.text).toContain('files written: 0')
      expect(implicit.text).toContain('report language: typst')
    }
  })

  it('persists the explicit choice where later workflows resolve it', async () => {
    const home = tempDir('autoreport-cmdhome-')
    const definition = factoryWithHome(home)
    const root = tempDir('autoreport-persist-')
    await definition.handler(invocation(`--language typst ${root}`))
    expect(loadProjectSettings(home, workspaceIdForRoot(root))).toEqual({ reportLanguage: 'typst' })
  })

  it('surfaces store failures loud instead of initializing with a wrong language', async () => {
    const home = tempDir('autoreport-cmdhome-')
    const root = tempDir('autoreport-broken-')
    const brokenHome = join(home, 'missing-parent')
    const definition = createReportInitCommand({
      reportLanguage: 'latex',
      projectStore: workspaceRoot => ({
        load: () => {
          throw new Error(`corrupt settings for ${workspaceRoot}`)
        },
        save: next => void next,
      }),
    })
    const result = await definition.handler(invocation(`--language typst ${brokenHome}`))
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('corrupt settings')
    expect(existsSync(join(brokenHome, 'Report/main.tex'))).toBe(false)
  })
})
