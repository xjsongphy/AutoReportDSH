import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  type AutoReportPythonEnvDeps,
  installAutoReportPythonEnv,
} from '../src/python-env.js'

function makeSession(id: string, cwd?: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: Date.now(),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

function makeExecution(session?: Session): ToolExecution {
  return session === undefined
    ? {} as ToolExecution
    : { agent: { session } } as ToolExecution
}

function registerResolver(ctx: Context): ReturnType<typeof vi.fn> {
  const resolve = vi.fn()
  const shellCtx = {
    get: (name: string) => name === 'shellEnv' ? {} : undefined,
    shellEnv: {
      register: (contributor: {
        name: string
        resolve: (execution: ToolExecution) => Record<string, string>
      }) => {
        resolve.mockImplementation(contributor.resolve)
        return () => {}
      },
    },
  } as unknown as Context
  Object.assign(ctx as object, shellCtx)
  return resolve
}

function baseDeps(overrides: Partial<AutoReportPythonEnvDeps> = {}): AutoReportPythonEnvDeps {
  return {
    ownsSession: () => false,
    snapshotPythonExecutable: () => undefined,
    hasWorkflowSnapshot: () => false,
    fallbackPythonExecutable: () => undefined,
    ...overrides,
  }
}

describe('installAutoReportPythonEnv', () => {
  it('no-ops when shellEnv is absent', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(installAutoReportPythonEnv(ctx, baseDeps())).toBeTypeOf('function')
  })

  it('registers DSH_AUTOREPORT_PYTHON from the configured snapshot executable', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    const session = makeSession('owned')
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: s => s.id === session.id,
      snapshotPythonExecutable: () => '/opt/venv/bin/python3',
      hasWorkflowSnapshot: () => true,
    }))
    expect(resolve(makeExecution(session))).toEqual({
      DSH_AUTOREPORT_PYTHON: '/opt/venv/bin/python3',
      DSH_AUTOREPORT_PYTHON_BIN: '/opt/venv/bin',
    })
  })

  it('returns no AutoReport keys for stock sessions', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    const stock = makeSession('stock', '/tmp/workspace')
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: () => false,
      fallbackPythonExecutable: () => '/opt/venv/bin/python3',
    }))
    expect(resolve(makeExecution(stock))).toEqual({})
  })

  it('returns no keys for agentless executions', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: () => true,
      snapshotPythonExecutable: () => '/opt/venv/bin/python3',
      hasWorkflowSnapshot: () => true,
    }))
    expect(resolve(makeExecution())).toEqual({})
  })

  it('prefers the frozen snapshot path over the compatibility fallback', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    const session = makeSession('owned')
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: s => s.id === session.id,
      snapshotPythonExecutable: () => '/opt/B/bin/python',
      hasWorkflowSnapshot: () => true,
      fallbackPythonExecutable: () => '/opt/A/bin/python',
    }))
    expect(resolve(makeExecution(session))).toEqual({
      DSH_AUTOREPORT_PYTHON: '/opt/B/bin/python',
      DSH_AUTOREPORT_PYTHON_BIN: '/opt/B/bin',
    })
  })

  it('uses the fallback only when no workflow snapshot exists yet', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    const session = makeSession('owned')
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: s => s.id === session.id,
      snapshotPythonExecutable: () => undefined,
      hasWorkflowSnapshot: () => false,
      fallbackPythonExecutable: () => '/opt/A/bin/python',
    }))
    expect(resolve(makeExecution(session))).toEqual({
      DSH_AUTOREPORT_PYTHON: '/opt/A/bin/python',
      DSH_AUTOREPORT_PYTHON_BIN: '/opt/A/bin',
    })
  })

  it('does not use the fallback when a snapshot exists without pythonExecutable', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    const session = makeSession('owned')
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: s => s.id === session.id,
      snapshotPythonExecutable: () => undefined,
      hasWorkflowSnapshot: () => true,
      fallbackPythonExecutable: () => '/python/A',
    }))
    expect(resolve(makeExecution(session))).toEqual({
      DSH_AUTOREPORT_PYTHON: 'python3',
    })
  })

  it('omits DSH_AUTOREPORT_PYTHON_BIN for bare python3', () => {
    const ctx = {} as Context
    const resolve = registerResolver(ctx)
    const session = makeSession('owned')
    installAutoReportPythonEnv(ctx, baseDeps({
      ownsSession: s => s.id === session.id,
      snapshotPythonExecutable: () => undefined,
      hasWorkflowSnapshot: () => true,
    }))
    expect(resolve(makeExecution(session))).toEqual({
      DSH_AUTOREPORT_PYTHON: 'python3',
    })
  })
})
