import { describe, expect, it, vi } from 'vitest'
import { createPythonEnvironmentTool } from '../src/tools/python-environment.js'

function harness() {
  const request = vi.fn(async () => 'allowed-once' as const)
  const spawn = vi.fn(() => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: 'ok', nextOffset: 2, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
  }))
  const resolveExecutable = vi.fn(async (command: string) => {
    if (command === 'uv') throw new Error('uv missing')
    return command === 'python3' ? '/env/bin/python3' : command
  })
  const ctx = {
    get(name: string) {
      if (name === 'subprocess') return { spawn, resolveExecutable }
      if (name === 'shellEnv') return { collect: () => ({ DSH_AUTOREPORT_PYTHON: 'python3' }) }
      if (name === 'approval') return { request }
      return undefined
    },
  }
  return { tool: createPythonEnvironmentTool(ctx as never), request, spawn, resolveExecutable }
}

function execution() {
  return {
    agent: { id: 'main', session: { header: { cwd: '/workspace' } } },
    callId: 'call-install',
    signal: new AbortController().signal,
  }
}

describe('python_environment capability', () => {
  it('requires user approval before installing validated package names', async () => {
    const { tool, request, spawn, resolveExecutable } = harness()
    const result = await tool.execute({ action: 'install', packages: ['numpy', 'scipy>=1.12'] }, execution() as never) as {
      status: string
      packages: string[]
      stdout: string
    }
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.anything(),
      toolName: 'python_environment',
      reason: expect.stringContaining('numpy, scipy>=1.12'),
      callId: 'call-install',
    }))
    expect(resolveExecutable).toHaveBeenCalledWith('python3', expect.anything(), expect.anything())
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['/env/bin/python3', '-m', 'pip', 'install', 'numpy', 'scipy>=1.12'],
    }))
    expect(result).toMatchObject({ status: 'success', packages: ['numpy', 'scipy>=1.12'], stdout: 'ok' })
  })

  it('rejects URLs, paths, and option-shaped package arguments before asking for approval', async () => {
    const { tool, request, spawn } = harness()
    await expect(tool.execute({ action: 'install', packages: ['https://example.org/pkg.whl'] }, execution() as never))
      .rejects.toThrow(/package requirement/u)
    expect(request).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
