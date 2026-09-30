import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installComputeBashTool } from '../src/tools/compute-bash.js'

describe('compute bash', () => {
  it('runs only with full role-root confinement and exposes no escalation argument', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-compute-'))
    mkdirSync(join(root, 'Data', 'Processed'), { recursive: true })
    let tool: { parameters: { properties: Record<string, unknown> }; execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    let wrappedRoot = ''
    let command = ''
    const shell = {
      sandboxMode: 'workspace-write',
      resolve: (request: unknown) => request,
      run: async (request: { command: string }) => {
        command = request.command
        return {
          exitCode: 0, signal: null, timedOut: false, aborted: false,
          stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        }
      },
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
    expect(command).toBe('python analyze.py')
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
      get: (name: string) => name === 'shell' ? { sandboxMode: 'workspace-write', resolve: (request: unknown) => request, run: async () => { ran = true; return {} } }
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
