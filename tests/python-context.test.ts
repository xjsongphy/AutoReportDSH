import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  installAutoReportPythonContext,
  renderPythonContext,
  type AutoReportPythonContextDeps,
} from '../src/python-context.js'

function makeSession(id: string, cwd?: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(id),
    createdAt: Date.now(),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

function baseDeps(overrides: Partial<AutoReportPythonContextDeps> = {}): AutoReportPythonContextDeps {
  return {
    ownsSession: () => false,
    roleOf: () => 'MAIN',
    snapshotPythonExecutable: () => undefined,
    ...overrides,
  }
}

describe('renderPythonContext', () => {
  it('deterministically renders selection, guidance, and ownership rules', () => {
    const first = renderPythonContext('/opt/miniconda3/envs/lab/bin/python', 'Conda · lab', 'DATA_ANALYSIS')
    const second = renderPythonContext('/opt/miniconda3/envs/lab/bin/python', 'Conda · lab', 'DATA_ANALYSIS')
    expect(first).toBe(second)
    expect(first).toContain('# Python environment')
    expect(first).toContain('/opt/miniconda3/envs/lab/bin/python')
    expect(first).toContain('compute shell resolves `python` and `python3`')
  })

  it('is empty when nothing is known so the snapshot contributes nothing', () => {
    expect(renderPythonContext('', undefined, 'MAIN')).toBe('')
  })

  it('changes text when the environment changes (host snapshot diff then appends)', () => {
    const before = renderPythonContext('/opt/miniconda3/envs/a/bin/python', 'Conda · a', 'MAIN')
    const after = renderPythonContext('/opt/miniconda3/envs/b/bin/python', 'Conda · b', 'MAIN')
    expect(before).not.toBe(after)
  })
})

describe('installAutoReportPythonContext', () => {
  it('no-ops when systemPrompt is absent', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(installAutoReportPythonContext(ctx, baseDeps())).toBeTypeOf('function')
  })

  it('registers a context that renders owned sessions and skips foreign ones', () => {
    const owned = makeSession('owned')
    const foreign = makeSession('foreign')
    let registered: { name: string; text: (assemble: unknown) => string } | undefined
    const ctx = {
      get: (name: string) => name === 'systemPrompt'
        ? {
            context: (entry: { name: string; text: (assemble: unknown) => string }) => {
              registered = entry
              return () => {}
            },
            getContextOrder: () => 110,
          }
        : undefined,
    } as unknown as Context
    const dispose = installAutoReportPythonContext(ctx, baseDeps({
      ownsSession: session => session === owned,
      roleOf: () => 'DATA_ANALYSIS',
      snapshotPythonExecutable: session => session === owned ? '/work/.venv/bin/python' : undefined,
    }))
    expect(dispose).toBeTypeOf('function')
    expect(registered?.name).toBe('autoreport:python-environment')
    const ownedText = registered!.text({ agent: { session: owned } })
    expect(ownedText).toContain('/work/.venv/bin/python')
    expect(registered!.text({ agent: { session: foreign } })).toBe('')
    expect(registered!.text({})).toBe('')
    dispose()
  })
})
