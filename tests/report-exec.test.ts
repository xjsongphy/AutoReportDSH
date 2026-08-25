import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { IsolationBackend, IsolationRequest } from '../src/policy/isolation/index.js'
import { createReportExecTool } from '../src/tools/report-exec.js'

function binding(id: string): RoleBindingSnapshot {
  return {
    version: AUTOREPORT_SCHEMA_VERSION,
    role: 'DATA_ANALYSIS',
    childSessionId: SessionId(id),
    parentSessionId: SessionId('main'),
    workflowId: 'workflow-1',
    provisioning: 'reserved',
  }
}

function reader(text: string, lossy = false) {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy }) }
}

function harness(options: { isolationFailure?: Error; lossy?: boolean } = {}) {
  const sessionId = SessionId('data-agent')
  const session = { id: sessionId, header: { id: sessionId, cwd: '/workspace' } } as Session
  const registry = new RoleRegistry()
  registry.registerReserved(binding(session.id))
  let spawnSpec: SubprocessSpawnSpec | undefined
  let isolationRequest: IsolationRequest | undefined
  const runtime = {
    resolveExecutable: vi.fn(async (command: string) => `/resolved/${command}`),
    spawn: vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
      spawnSpec = spec
      return {
        pid: 10,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stdout: reader('out', options.lossy), stderr: reader('err') },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        waitForExit: async () => true,
      }
    }),
  } as unknown as SubprocessRuntime
  const isolation: IsolationBackend = {
    async wrap(request) {
      isolationRequest = request
      if (options.isolationFailure !== undefined) throw options.isolationFailure
      return { argv: ['/sandbox', '--', ...request.argv], env: { TMPDIR: request.tempRoot } }
    },
  }
  const removeTemp = vi.fn(async () => undefined)
  const tool = createReportExecTool({} as Context, {
    registry,
    subprocess: runtime,
    isolation,
    createTemp: async () => '/private/temp',
    removeTemp,
    maxOutputBytes: 100,
  })
  const exec = { agent: { id: session.id, session } as Agent, signal: new AbortController().signal }
  const call = (args: Record<string, unknown>) => Promise.resolve(tool.execute(args as never, exec as never))
  return { session, registry, runtime, call, removeTemp, get spawnSpec() { return spawnSpec }, get isolationRequest() { return isolationRequest } }
}

describe('report_exec', () => {
  it('uses DSH subprocess lifecycle with exact argv and role policy', async () => {
    const run = harness()
    const result = await run.call({ argv: ['python3', 'fit.py', '--quiet'], timeout_ms: 1000 }) as Record<string, unknown>
    expect(run.runtime.resolveExecutable).toHaveBeenCalledWith('python3', {}, expect.any(AbortSignal))
    expect(run.isolationRequest).toMatchObject({
      argv: ['/resolved/python3', 'fit.py', '--quiet'],
      cwd: '/workspace/Data',
      readableRoots: ['/workspace'],
      writableRoots: ['/workspace/Data/Processed'],
      tempRoot: '/private/temp',
    })
    expect(run.spawnSpec).toMatchObject({
      argv: ['/sandbox', '--', '/resolved/python3', 'fit.py', '--quiet'],
      cwd: '/workspace/Data',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
    })
    expect(result).toMatchObject({ exit_code: 0, stdout: 'out', stderr: 'err', truncated: false, timed_out: false })
    expect(run.removeTemp).toHaveBeenCalledWith('/private/temp')
  })

  it('fails closed when isolation is unavailable and still removes private temp', async () => {
    const run = harness({ isolationFailure: new Error('no sandbox') })
    await expect(run.call({ argv: ['python3'] })).rejects.toThrow('no sandbox')
    expect(run.runtime.spawn).not.toHaveBeenCalled()
    expect(run.removeTemp).toHaveBeenCalledWith('/private/temp')
  })

  it('denies unbound agents independently of the outer guard', async () => {
    const run = harness()
    run.registry.revoke(run.session.id)
    await expect(run.call({ argv: ['python3'] })).rejects.toThrow(/no valid specialist role/u)
    expect(run.runtime.resolveExecutable).not.toHaveBeenCalled()
  })

  it('bounds argv and reports lossy collection', async () => {
    const run = harness({ lossy: true })
    const result = await run.call({ argv: ['python3'] }) as Record<string, unknown>
    expect(result['truncated']).toBe(true)
    await expect(run.call({ argv: [] })).rejects.toThrow(/1-256 entries/u)
  })
})
