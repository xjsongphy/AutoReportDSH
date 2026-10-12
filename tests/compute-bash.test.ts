import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installComputeBashTool } from '../src/tools/compute-bash.js'

describe('compute bash', () => {
  it.skipIf(process.platform === 'win32').each([
    ['false | tail -n 1', 1],
    ["printf 'ok\\n' | tail -n 1", 0],
    ["false | tail -n 1 || printf 'handled\\n'", 0],
  ])('preserves pipeline exit status for %s', async (command, expectedExit) => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-pipefail-'))
    mkdirSync(join(root, 'Data', 'Processed'), { recursive: true })
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    const ctx = {
      get: (name: string) => name === 'shell' ? {
        sandboxMode: 'workspace-write', resolve: (request: unknown) => request,
        execute: async (request: { command: string }) => ({ result: async () => {
          const result = spawnSync('bash', ['-c', request.command], { cwd: root, encoding: 'utf8' })
          if (result.error) throw result.error
          return { exitCode: result.status, signal: result.signal, timedOut: false, aborted: false,
            stdout: { text: result.stdout }, stderr: { text: result.stderr }, sandbox: { enforcement: 'full' } }
        } }),
      } : name === 'shellEnv' ? { collect: () => ({}) }
        : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: join(root, 'Data', 'Processed') }) }
          : name === 'sandbox' ? { confine: async () => ({ enforcement: 'full' }) } : undefined,
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
    }
    try {
      installComputeBashTool(ctx as never, 'DATA_ANALYSIS', root)
      await expect(tool!.execute({ command, description: 'Check pipeline exit status' }, {
        agent: { session: { id: 'data', header: { cwd: root } } }, signal: new AbortController().signal,
      })).resolves.toMatchObject({ exitCode: expectedExit })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs only with full role-root confinement and exposes no escalation argument', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-compute-'))
    mkdirSync(join(root, 'Data', 'Processed'), { recursive: true })
    let tool: { parameters: { properties: Record<string, unknown> }; execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    let wrappedRoot = ''
    let command = ''
    const shell = {
      sandboxMode: 'workspace-write',
      resolve: (request: unknown) => request,
      execute: async (request: { command: string }) => ({ result: async () => {
        command = request.command
        return {
          exitCode: 0, signal: null, timedOut: false, aborted: false,
          stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        }
      } }),
    }
    const ctx = {
      get: (name: string) => name === 'shell' ? shell
        : name === 'shellEnv' ? { collect: () => ({}) }
          : name === 'sandboxPolicy'
            ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: join(root, 'Data', 'Processed') }) }
            : name === 'sandbox'
              ? { confine: async (_argv: unknown, policy: { workspaceRoot: string }) => {
            wrappedRoot = policy.workspaceRoot
            return { enforcement: 'full' }
          } }
              : undefined,
      get shell(): never { throw new Error('shell property read without injection') },
      get shellEnv(): never { throw new Error('shellEnv property read without injection') },
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
    }
    installComputeBashTool(ctx as never, 'DATA_ANALYSIS', root)
    expect(tool?.parameters.properties).not.toHaveProperty('sandbox_permissions')
    const result = await tool?.execute({ command: 'python analyze.py', description: 'Analyze data' }, {
      agent: { session: { id: 'data', header: { cwd: root } } }, signal: new AbortController().signal,
    }) as { exitCode: number }
    expect(result.exitCode).toBe(0)
    expect(command).toBe('set -o pipefail\npython analyze.py')
    expect(wrappedRoot).toBe(join(root, 'Data', 'Processed'))
  })

  it('rejects an unsandboxed shell before registering a tool', () => {
    expect(() => installComputeBashTool({ get: (name: string) => name === 'shell' ? { sandboxMode: undefined } : undefined } as never, 'PLOTTING'))
      .toThrow(/sandboxing DSH shell/)
  })

  it('rejects partial sandbox enforcement before running the command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-partial-shell-'))
    mkdirSync(join(root, 'Plots'))
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    let ran = false
    const ctx = {
      get: (name: string) => name === 'shell' ? { sandboxMode: 'workspace-write', resolve: (request: unknown) => request, execute: async () => { ran = true; return {} } }
        : name === 'shellEnv' ? { collect: () => ({}) }
          : name === 'sandboxPolicy'
        ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: join(root, 'Plots') }) }
          : name === 'sandbox' ? { confine: async () => ({ enforcement: 'partial' }) } : undefined,
      get shell(): never { throw new Error('shell property read without injection') },
      get shellEnv(): never { throw new Error('shellEnv property read without injection') },
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
    }
    installComputeBashTool(ctx as never, 'PLOTTING', root)
    await expect(tool?.execute({ command: 'python plot.py', description: 'Draw plot' }, {
      agent: { session: { id: 'plot', header: { cwd: root } } }, signal: new AbortController().signal,
    })).rejects.toThrow(/full DSH file-sandbox enforcement/)
    expect(ran).toBe(false)
  })
})
