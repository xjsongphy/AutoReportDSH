import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPythonPackageTool } from '../src/tools/python-package-install.js'

describe('install_python_package input', () => {
  it('runs fixed package-manager argv only after approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-package-'))
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    let decision = 'rejected'
    let argv: readonly string[] = []
    const ctx = {
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
      get: (name: string) => name === 'autoreportWorkflow'
        ? { config: { workspaceRoot: root }, projectionFor: () => ({ meta: { settings: { pythonExecutable: '/usr/bin/python3' } } }) }
        : name === 'approval'
          ? { request: async () => decision }
          : name === 'subprocess'
            ? { spawn: (spec: { argv: readonly string[] }) => {
              argv = spec.argv
              return {
                done: Promise.resolve({ exitCode: 0, signal: null }),
                collected: { stdout: { readFrom: () => ({ text: 'installed' }) }, stderr: { readFrom: () => ({ text: '' }) } },
              }
            } }
            : undefined,
    }
    installPythonPackageTool(ctx as never)
    const exec = { agent: { session: { id: 'main', header: { cwd: root } } }, callId: 'call-1', signal: new AbortController().signal }
    await expect(tool?.execute({ package: 'pandas==2.2.3' }, exec)).rejects.toThrow(/rejected/)
    expect(argv).toEqual([])
    decision = 'allowed-once'
    await expect(tool?.execute({ package: 'pandas==2.2.3' }, exec)).resolves.toMatchObject({ status: 'success' })
    expect(argv).toEqual(['/usr/bin/python3', '-m', 'pip', 'install', 'pandas==2.2.3'])
  })

  it('uses uv pip when the frozen settings identify the managed environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-managed-package-'))
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    let argv: readonly string[] = []
    const ctx = {
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
      get: (name: string) => name === 'autoreportWorkflow'
        ? { config: { workspaceRoot: root }, projectionFor: () => ({ meta: { settings: {
          pythonExecutable: join(root, 'autoreport/venv/bin/python'), pythonManaged: true,
        } } }) }
        : name === 'approval'
          ? { request: async () => 'allowed-once' }
          : name === 'subprocess'
            ? { spawn: (spec: { argv: readonly string[] }) => {
              argv = spec.argv
              return {
                done: Promise.resolve({ exitCode: 0, signal: null }),
                collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
              }
            } }
            : undefined,
    }
    installPythonPackageTool(ctx as never)
    const exec = { agent: { session: { id: 'main', header: { cwd: root } } }, callId: 'call-1', signal: new AbortController().signal }
    await tool?.execute({ package: 'pandas' }, exec)
    expect(argv).toEqual(['uv', 'pip', 'install', '--python', join(root, 'autoreport/venv/bin/python'), 'pandas'])
  })
})
