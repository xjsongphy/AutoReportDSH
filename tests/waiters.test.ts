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

  it('cancels a running-child wait immediately and removes timers and its abort listener', async () => {
    const registry = new WaiterRegistry()
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    registry.noteChildActivity('child', 'running')
    const pending = registry.wait('task#1', { childSessionId: 'child', idleTimeoutMs: 100, hardTimeoutMs: 600_000 }, abort.signal)
    abort.abort()
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(registry.pendingKeys()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('cancels only the caller waiter when another caller waits on the same revision', async () => {
    const registry = new WaiterRegistry()
    const abort = new AbortController()
    const first = registry.wait('task#1', 1000, abort.signal)
    const second = registry.wait('task#1', 1000)
    abort.abort()
    await expect(first).resolves.toEqual({ status: 'cancelled' })
    expect(registry.pendingKeys()).toBe(1)
    registry.settle('task#1', { status: 'completed' })
    await expect(second).resolves.toEqual({ status: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not register a waiter for an already aborted signal', async () => {
    const registry = new WaiterRegistry()
    await expect(registry.wait('task#1', 1000, AbortSignal.abort())).resolves.toEqual({ status: 'cancelled' })
    expect(registry.pendingKeys()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['completed', 'timed_out', 'cancelled'] as const)('releases cancellation listeners after %s', async status => {
    const registry = new WaiterRegistry()
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const pending = registry.wait('task#1', 1000, abort.signal)
    if (status === 'timed_out') await vi.advanceTimersByTimeAsync(1000)
    else if (status === 'cancelled') registry.abandon('task#1')
    else registry.settle('task#1', { status })
    await expect(pending).resolves.toEqual({ status })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
