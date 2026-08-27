import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { installAutoReportPythonEnv } from '../src/python-env.js'

describe('installAutoReportPythonEnv', () => {
  it('no-ops when shellEnv is absent', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(installAutoReportPythonEnv(ctx, () => '/opt/python')).toBeTypeOf('function')
  })

  it('registers DSH_AUTOREPORT_PYTHON from the configured executable', () => {
    const resolve = vi.fn()
    const ctx = {
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
    installAutoReportPythonEnv(ctx, () => '/opt/venv/bin/python3')
    expect(resolve({} as ToolExecution)).toEqual({
      DSH_AUTOREPORT_PYTHON: '/opt/venv/bin/python3',
      DSH_AUTOREPORT_PYTHON_BIN: '/opt/venv/bin',
    })
  })
})
