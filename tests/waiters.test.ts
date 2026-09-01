import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WaiterRegistry, type WaiterOutcome } from '../src/workflow/waiters.js'

describe('WaiterRegistry (PLAN 2.4 wait semantics)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves on settle and clears the timeout', async () => {
    const registry = new WaiterRegistry()
    const promise = registry.wait('task-1#1', 1000)
    expect(registry.pendingKeys()).toBe(1)
    expect(registry.settle('task-1#1', { status: 'completed', response: 'done' })).toBe(true)
    await expect(promise).resolves.toEqual({ status: 'completed', response: 'done' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(registry.pendingKeys()).toBe(0)
  })

  it('is idempotent: a second settle finds nothing pending', async () => {
    const registry = new WaiterRegistry()
    const promise = registry.wait('task-2#1', 5000)
    expect(registry.settle('task-2#1', { status: 'failed' })).toBe(true)
    expect(registry.settle('task-2#1', { status: 'completed' })).toBe(false)
    await expect(promise).resolves.toEqual({ status: 'failed' })
  })

  it('produces timed_out without throwing when the bound elapses', async () => {
    const registry = new WaiterRegistry()
    const promise: Promise<WaiterOutcome> = registry.wait('task-3#2', 1500)
    const settled = promise.then(outcome => outcome.status)
    await vi.advanceTimersByTimeAsync(1600)
    await expect(settled).resolves.toBe('timed_out')
    // A late report after timeout settles nothing.
    expect(registry.settle('task-3#2', { status: 'completed' })).toBe(false)
  })

  it('pauses idle timeout while its child is running, then rearms it on idle', async () => {
    const registry = new WaiterRegistry()
    const pending = registry.wait('task-5#1', {
      childSessionId: 'child-5',
      idleTimeoutMs: 100,
      hardTimeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(90)
    registry.noteChildActivity('child-5', 'running')
    await vi.advanceTimersByTimeAsync(800)
    expect(registry.pendingKeys()).toBe(1)
    registry.noteChildActivity('child-5', 'idle')
    await vi.advanceTimersByTimeAsync(99)
    expect(registry.pendingKeys()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ status: 'timed_out' })
  })

  it('enforces the hard timeout even while the child remains running', async () => {
    const registry = new WaiterRegistry()
    registry.noteChildActivity('child-6', 'running')
    const pending = registry.wait('task-6#1', {
      childSessionId: 'child-6',
      idleTimeoutMs: 100,
      hardTimeoutMs: 250,
    })
    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toEqual({ status: 'timed_out' })
  })

  it('abandon resolves waiters as cancelled (shutdown path)', async () => {
    const registry = new WaiterRegistry()
    const promise = registry.wait('task-4#1', 60_000)
    registry.abandon('task-4#1')
    await expect(promise).resolves.toEqual({ status: 'cancelled' })
  })
})
