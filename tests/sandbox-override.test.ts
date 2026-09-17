import { describe, expect, it } from 'vitest'
import { installSandboxOverride, SANDBOX_OVERRIDE_PROBE } from '../src/policy/sandbox-override.js'

interface FakeSession {
  id: string
  header?: { cwd?: string }
}

interface FakeRequest {
  session?: FakeSession
}

function fakePolicy(workspaceRoot: string) {
  const calls: FakeRequest[] = []
  return {
    calls,
    resolve(request: FakeRequest = {}) {
      calls.push(request)
      return { mode: 'workspace-write' as const, workspaceRoot }
    },
  }
}

/** Role roots keyed by session id; `undefined` models a stock session. */
const ROLE_ROOTS: Record<string, string | undefined> = {
  's-main': '/experiment/Outline',
  's-data': '/experiment/Data/Processed',
}

function roleRootOf(session: FakeSession): string | undefined {
  return ROLE_ROOTS[String(session.id)]
}

const PROBE_ROOT = '/experiment/Outline'

describe('installSandboxOverride', () => {
  it('routes an AutoReport-owned session to the root its callback returns', () => {
    const policy = fakePolicy('/experiment')
    installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT })

    expect(policy.resolve({ session: { id: 's-main' } }).workspaceRoot).toBe('/experiment/Outline')
    expect(policy.resolve({ session: { id: 's-data' } }).workspaceRoot).toBe(
      '/experiment/Data/Processed',
    )
  })

  it('keeps every other resolved field of the base policy', () => {
    const policy = fakePolicy('/experiment')
    installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT })

    const resolved = policy.resolve({ session: { id: 's-main' } })
    expect(resolved.mode).toBe('workspace-write')
  })

  it('leaves stock sessions untouched', () => {
    const policy = fakePolicy('/experiment')
    installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT })

    expect(policy.resolve({ session: { id: 'stock-session' } })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/experiment',
    })
  })

  it('passes through when resolved without a session', () => {
    const policy = fakePolicy('/experiment')
    installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT })

    expect(policy.resolve()).toEqual({ mode: 'workspace-write', workspaceRoot: '/experiment' })
    expect(policy.resolve({})).toEqual({ mode: 'workspace-write', workspaceRoot: '/experiment' })
  })

  it('is idempotent: a second install does not wrap again', () => {
    const policy = fakePolicy('/experiment')
    installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT })
    installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT })

    policy.resolve({ session: { id: 's-main' } })
    // One owned-session base call per resolve (the session-less install-time
    // probe aside): the second install must not stack wrappers.
    expect(policy.calls.filter(request => request.session?.id === 's-main'))
      .toHaveLength(1)
  })

  it('never consults the role callback for the synthetic probe', () => {
    const policy = fakePolicy('/experiment')
    const consulted: string[] = []
    installSandboxOverride(policy, {
      roleRootOf: session => (consulted.push(String(session.id)), roleRootOf(session)),
      probeRoot: PROBE_ROOT,
    })

    const probe = policy.resolve({ session: { id: SANDBOX_OVERRIDE_PROBE } })
    expect(probe.workspaceRoot).toBe(PROBE_ROOT)
    expect(consulted).toEqual([])
  })

  it('fails loud when the service rejects the wrap (frozen object)', () => {
    const policy = Object.freeze(fakePolicy('/experiment'))
    expect(() =>
      installSandboxOverride(policy, { roleRootOf, probeRoot: PROBE_ROOT }),
    ).toThrow(/sandbox/)
  })
})
