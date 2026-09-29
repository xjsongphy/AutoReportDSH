import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import {
  AUTO_REPORT_USER_SETTINGS_SCHEMA,
  resolveWorkflowSettings,
  validatePythonExecutableSetting,
  WORKFLOW_SETTINGS_SCHEMA_DEFAULTS,
  workspaceIdForRoot,
} from '../src/settings.js'
import { managedPythonExecutable } from '../src/python-detect.js'
import { createReportInitCommand } from '../src/workspace/command.js'
import { pathWithBin, writeFakeVenvBootstrap } from './helpers/managed-python-stub.js'

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
  specialistModel: { provider: 'comp-provider', model: 'comp-model' },
  delegationIdleTimeoutMs: 1100,
  delegationWaitTimeoutMs: 1000,
  pythonExecutable: '/comp/python',
} as const

const USER = {
  defaultReportLanguage: 'typst',
  specialistModel: { provider: 'user-provider', model: 'user-model', reasoningEffort: 'high' },
  delegationIdleTimeoutMs: 2200,
  delegationWaitTimeoutMs: 2000,
  pythonExecutable: '/user/python',
} as const

const OVERRIDE = {
  reportLanguage: 'typst',
  specialistModel: { inheritMain: true },
  delegationIdleTimeoutMs: 4400,
  delegationWaitTimeoutMs: 4000,
  pythonExecutable: '/override/python',
} as const

describe('resolveWorkflowSettings precedence', () => {
  it('falls through to schema defaults when every layer is absent', () => {
    expect(resolveWorkflowSettings({})).toEqual({
      reportLanguage: 'latex',
      specialistModel: { inheritMain: true },
      delegationIdleTimeoutMs: 60_000,
      delegationWaitTimeoutMs: 600_000,
    })
    expect(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS).toMatchObject({ reportLanguage: 'latex', delegationIdleTimeoutMs: 60_000, delegationWaitTimeoutMs: 600_000 })
  })

  it('materializes __managed__ into the created DSH-owned interpreter', () => {
    const root = tempDir('autoreport-resolve-managed-')
    const dshHome = join(root, 'dsh')
    const bin = writeFakeVenvBootstrap(join(root, 'bootstrap'))
    const resolved = resolveWorkflowSettings({
      user: { pythonExecutable: '__managed__' },
      dshHome,
      pythonEnv: pathWithBin(bin),
    })
    expect(realpathSync(resolved.pythonExecutable as string)).toBe(
      realpathSync(managedPythonExecutable(dshHome)),
    )
  })

  it('applies each single layer above the schema defaults', () => {
    expect(resolveWorkflowSettings({ composition: COMPOSITION })).toEqual({
      reportLanguage: 'latex',
      specialistModel: { inheritMain: false, provider: 'comp-provider', model: 'comp-model' },
      delegationIdleTimeoutMs: 1100,
      delegationWaitTimeoutMs: 1000,
      pythonExecutable: '/comp/python',
    })
    expect(resolveWorkflowSettings({ user: USER })).toEqual({
      reportLanguage: 'typst',
      specialistModel: { inheritMain: false, provider: 'user-provider', model: 'user-model', reasoningEffort: 'high' },
      delegationIdleTimeoutMs: 2200,
      delegationWaitTimeoutMs: 2000,
      pythonExecutable: '/user/python',
    })
  })

  it('walks the full chain downward when higher layers drop out', () => {
    const all = { override: OVERRIDE, user: USER, composition: COMPOSITION }
    expect(resolveWorkflowSettings(all)).toMatchObject({
      reportLanguage: 'typst',
      delegationIdleTimeoutMs: 4400,
      delegationWaitTimeoutMs: 4000,
      pythonExecutable: '/override/python',
      specialistModel: { inheritMain: true },
    })
    const withoutOverride = (({ override: _drop, ...rest }) => rest)(all)
    expect(resolveWorkflowSettings(withoutOverride)).toMatchObject({
      reportLanguage: 'typst',
      delegationIdleTimeoutMs: 2200,
      delegationWaitTimeoutMs: 2000,
      pythonExecutable: '/user/python',
      specialistModel: { provider: 'user-provider', reasoningEffort: 'high' },
    })
    const withoutUser = (({ user: _drop, ...rest }) => rest)(withoutOverride)
    expect(resolveWorkflowSettings(withoutUser)).toMatchObject({
      reportLanguage: 'latex',
      delegationIdleTimeoutMs: 1100,
      delegationWaitTimeoutMs: 1000,
      pythonExecutable: '/comp/python',
      specialistModel: { provider: 'comp-provider' },
    })
  })

  it('merges sparse layers field by field', () => {
    const resolved = resolveWorkflowSettings({
      composition: COMPOSITION,
      user: { defaultReportLanguage: 'typst', delegationIdleTimeoutMs: 24, delegationWaitTimeoutMs: 42 },
      override: { pythonExecutable: '/override/python' },
    })
    expect(resolved).toEqual({
      reportLanguage: 'typst',
      specialistModel: { inheritMain: false, provider: 'comp-provider', model: 'comp-model' },
      delegationIdleTimeoutMs: 24,
      delegationWaitTimeoutMs: 42,
      pythonExecutable: '/override/python',
    })
  })

  it('accepts a plain route shorthand on the override and fails loud on garbage', () => {
    expect(resolveWorkflowSettings({ override: { specialistModel: { provider: 'p', model: 'm' } } }).specialistModel)
      .toEqual({ inheritMain: false, provider: 'p', model: 'm' })
    expect(resolveWorkflowSettings({ override: { specialistModel: {} as never } }).specialistModel)
      .toEqual({ inheritMain: true })
    expect(() => resolveWorkflowSettings({ override: { specialistModel: { provider: 'only-provider' } as never } }))
      .toThrow(/specialistModel/)
    expect(() => resolveWorkflowSettings({ override: { reportLanguage: 'markdown' as never } })).toThrow(/reportLanguage/)
    expect(() => resolveWorkflowSettings({ user: { delegationWaitTimeoutMs: 0 } })).toThrow(/delegationWaitTimeoutMs/)
    expect(() => resolveWorkflowSettings({ user: { delegationIdleTimeoutMs: 0 } })).toThrow(/delegationIdleTimeoutMs/)
    expect(() => resolveWorkflowSettings({ composition: { specialistModel: { provider: '', model: 'm' } } })).toThrow(/specialistModel/)
  })
})

describe('per-workspace language', () => {
  it('lets a workspace entry beat the user default', () => {
    // Keys are resolved paths: build them with `resolve` so the case holds on
    // Windows, where `resolve('/exp/a')` is a drive-qualified native path.
    const root = resolve('/exp/a')
    const resolved = resolveWorkflowSettings({
      user: { workspaceLanguages: { [root]: 'typst', [resolve('/exp/b')]: 'latex' } },
      workspaceRoot: root,
    })
    expect(resolved.reportLanguage).toBe('typst')
  })

  it('falls back through the user default and the schema default', () => {
    expect(resolveWorkflowSettings({
      user: { workspaceLanguages: { [resolve('/exp/b')]: 'latex' }, defaultReportLanguage: 'typst' },
      workspaceRoot: '/exp/a',
    }).reportLanguage).toBe('typst')
    expect(resolveWorkflowSettings({
      user: { defaultReportLanguage: 'typst' },
      workspaceRoot: '/exp/a',
    }).reportLanguage).toBe('typst')
    expect(resolveWorkflowSettings({ workspaceRoot: '/exp/a' }).reportLanguage).toBe('latex')
    expect(resolveWorkflowSettings({
      user: { workspaceLanguages: { '/exp/a': 'typst' } },
    }).reportLanguage).toBe('latex')
  })

  it('keys on the resolved path, so a trailing slash is the same workspace', () => {
    const root = resolve('/exp/a')
    expect(resolveWorkflowSettings({
      user: { workspaceLanguages: { [root]: 'typst' } },
      workspaceRoot: `${root}/`,
    }).reportLanguage).toBe('typst')
  })

  it('defaults the field to an empty map and rejects a foreign language', () => {
    const user = AUTO_REPORT_USER_SETTINGS_SCHEMA({}) as Record<string, unknown>
    expect(user['workspaceLanguages']).toEqual({})
    expect(() => AUTO_REPORT_USER_SETTINGS_SCHEMA({ workspaceLanguages: { '/exp': 'kotlin' } })).toThrow()
    expect(() => AUTO_REPORT_USER_SETTINGS_SCHEMA({ workspaceLanguages: { '/exp': 3 } })).toThrow()
  })
})

describe('specialist model resolution representation', () => {
  it('records explicit Main inheritance only when nothing configures a route', () => {
    expect(resolveWorkflowSettings({}).specialistModel).toEqual({ inheritMain: true })
    expect(resolveWorkflowSettings({
      composition: { ...COMPOSITION, specialistModel: undefined },
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
    const resolved = resolveWorkflowSettings({ user: USER, override: { specialistModel: { inheritMain: true } } })
    expect(resolved.specialistModel).toEqual({ inheritMain: true })
  })
})

describe('snapshot immutability', () => {
  it('freezes the snapshot deeply and stays detached from later input mutation', () => {
    const user: Record<string, unknown> = { ...USER }
    const resolved = resolveWorkflowSettings({ user: user as never })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.specialistModel)).toBe(true)

    user['defaultReportLanguage'] = 'latex'
    user['delegationWaitTimeoutMs'] = 999_999
    user['specialistModel'] = { provider: 'mutated', model: 'mutated' }

    expect(resolved.reportLanguage).toBe('typst')
    expect(resolved.delegationWaitTimeoutMs).toBe(2000)
    expect(resolved.specialistModel).toEqual({ inheritMain: false, provider: 'user-provider', model: 'user-model', reasoningEffort: 'high' })
  })
})

describe('workspace log identity', () => {
  it('derives a stable opaque key from the resolved workspace path', () => {
    const root = tempDir('autoreport-ws-')
    const id = workspaceIdForRoot(root)
    expect(id).toMatch(/^[a-z0-9]{16}$/u)
    expect(workspaceIdForRoot(`${root}/`)).toBe(id)
    expect(workspaceIdForRoot(join(root, 'other'))).not.toBe(id)
  })

  it('exposes schemas whose standalone resolution carries documented defaults', () => {
    const user = AUTO_REPORT_USER_SETTINGS_SCHEMA({}) as Record<string, unknown>
    expect(user['defaultReportLanguage']).toBe('latex')
    expect(user['delegationWaitTimeoutMs']).toBe(600_000)
  })
})

describe('init --language recording', () => {
  function invocation(rawInput: string, cwd?: string): CommandInvocation {
    return {
      commandId: 'cmd-1' as CommandInvocation['commandId'],
      agent: { session: { header: { cwd } } },
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    } as unknown as CommandInvocation
  }

  /** The recording seam a host provides; touching the workspace is the host's job. */
  function factoryWithStore(recorded: Map<string, 'latex' | 'typst'>) {
    return createReportInitCommand({
      reportLanguage: 'latex',
      languageStore: {
        read: root => recorded.get(root),
        write: (root, language) => { recorded.set(root, language) },
      },
    })
  }

  it('records the choice in the workspace language store and materializes it', async () => {
    const recorded = new Map<string, 'latex' | 'typst'>()
    const definition = factoryWithStore(recorded)
    const root = tempDir('autoreport-record-')

    const typst = await definition.handler(invocation(`--language typst ${root}`))
    expect(typst.kind).toBe('success')
    if (typst.kind === 'success') {
      expect(typst.text).toContain('report language: typst (saved to settings)')
      expect(typst.text).toContain('+ Report/main.typ')
    }
    expect(recorded.get(root)).toBe('typst')
    const implicit = await definition.handler(invocation(root))
    expect(implicit.kind).toBe('success')
    if (implicit.kind === 'success') {
      expect(implicit.text).toContain('files written: 0')
      expect(implicit.text).toContain('report language: typst')
    }
  })
})

describe('validatePythonExecutableSetting', () => {
  it('accepts a detected executable without re-checking it', () => {
    expect(() => validatePythonExecutableSetting({
      defaultReportLanguage: 'latex',
      delegationWaitTimeoutMs: 1,
      pythonExecutable: '/not-a-real-python',
      pythonEnvironments: [{
        label: 'fake',
        executable: '/not-a-real-python',
        source: 'path',
        version: 'Python 3',
      }],
    })).not.toThrow()
  })

  it('rejects a custom path that is not a runnable interpreter', () => {
    expect(() => validatePythonExecutableSetting({
      defaultReportLanguage: 'latex',
      delegationWaitTimeoutMs: 1,
      pythonExecutable: '/definitely-missing-python',
    })).toThrow(/pythonExecutable/)
  })

  it('accepts __managed__ after creating the DSH-owned venv', () => {
    const root = tempDir('autoreport-validate-managed-')
    const dshHome = join(root, 'dsh')
    const bin = writeFakeVenvBootstrap(join(root, 'bootstrap'))
    expect(() => validatePythonExecutableSetting({
      defaultReportLanguage: 'latex',
      delegationWaitTimeoutMs: 1,
      pythonExecutable: '__managed__',
    }, dshHome, pathWithBin(bin))).not.toThrow()
  })
})
