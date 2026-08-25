import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { RoleBindingSnapshot } from '../src/workflow/events.js'

function binding(overrides: Partial<RoleBindingSnapshot> = {}): RoleBindingSnapshot {
  return {
    version: 1,
    role: 'THEORY',
    childSessionId: SessionId('child-1'),
    parentSessionId: SessionId('parent-1'),
    workflowId: 'wf-1',
    provisioning: 'reserved',
    ...overrides,
  }
}

describe('RoleRegistry (PLAN 2.3 first-call authorization)', () => {
  it('authorizes a RESERVED binding before any active transition', () => {
    const registry = new RoleRegistry()
    registry.registerReserved(binding())
    expect(registry.lookup('child-1')?.binding.role).toBe('THEORY')
    expect(registry.lookup('child-1')?.policy.writableRoots).toEqual(['Theory'])
  })

  it('fails closed on unknown children', () => {
    const registry = new RoleRegistry()
    expect(registry.lookup('nobody')).toBeUndefined()
  })

  it('revokes failed provisioning so the guard denies', () => {
    const registry = new RoleRegistry()
    registry.registerReserved(binding())
    expect(registry.revoke(SessionId('child-1'))).toBe(true)
    expect(registry.lookup('child-1')).toBeUndefined()
  })

  it('rebinds atomically: new child authorized, old child denied, same synchronous step', () => {
    const registry = new RoleRegistry()
    registry.registerReserved(binding({ childSessionId: SessionId('child-old'), role: 'PLOTTING' }))
    const replacement = binding({
      childSessionId: SessionId('child-new'),
      role: 'PLOTTING',
      supersedes: SessionId('child-old'),
    })
    registry.rebind('PLOTTING', SessionId('child-old'), replacement)
    expect(registry.lookup('child-new')?.binding.provisioning).toBe('reserved')
    expect(registry.lookup('child-old')).toBeUndefined()
  })

  it('refuses rebind against a foreign role and duplicate child ids', () => {
    const registry = new RoleRegistry()
    registry.registerReserved(binding({ role: 'THEORY' }))
    registry.registerReserved(binding({ childSessionId: SessionId('child-2'), role: 'REPORT' }))
    expect(() =>
      registry.rebind('REPORT', SessionId('child-1'), binding({ childSessionId: SessionId('child-3'), role: 'REPORT' })),
    ).toThrow(/bound to THEORY/)
    expect(() => registry.registerReserved(binding())).toThrow(/already registered/)
    expect(() => registry.registerReserved(binding({ provisioning: 'failed' }))).toThrow(/failed/)
  })
})
