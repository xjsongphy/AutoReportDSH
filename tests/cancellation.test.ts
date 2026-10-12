import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installCancellationAdapters } from '../src/cancellation.js'

function agent(id: string): Agent {
  return { id: SessionId(id), cancel: vi.fn() } as unknown as Agent
}

describe('effect-owned cancellation adapters', () => {
  it('routes only owned agents and resident interrupts, delegates other targets, and restores methods on unload', async () => {
    const ctx = new Context()
    const owned = agent('owned')
    const ordinary = agent('ordinary')
    const originalCancel = owned.cancel
    const originalInterrupt = vi.fn()
    const subagents = { interrupt: originalInterrupt }
    ctx.provide('agents', { list: () => [owned, ordinary] } as never)
    ctx.provide('subagents', subagents as never)
    const cancelling = vi.fn()
    const interrupt = vi.fn((id: string) => id === 'resident')
    const fiber = ctx.plugin(pluginCtx => {
      installCancellationAdapters(pluginCtx, {
        owns: target => target === owned,
        cancelling,
        interrupt,
      })
    })
    await fiber
    owned.cancel({ kind: 'user' }, { keepInbox: true })
    ordinary.cancel({ kind: 'user' })
    expect(cancelling.mock.calls).toEqual([[owned, { kind: 'user' }]])
    expect(originalCancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    ctx.subagents.interrupt(SessionId('resident'), { kind: 'user', parentSessionId: owned.id })
    expect(originalInterrupt).not.toHaveBeenCalled()
    ctx.subagents.interrupt(SessionId('stock'), { kind: 'user', parentSessionId: ordinary.id })
    expect(originalInterrupt).toHaveBeenCalledWith('stock', { kind: 'user', parentSessionId: ordinary.id })
    await fiber.dispose()
    expect(owned.cancel).toBe(originalCancel)
    expect(subagents.interrupt).toBe(originalInterrupt)
  })

  it('restores a disposed Agent and attaches a later owned Agent', async () => {
    const ctx = new Context()
    const cancelling = vi.fn()
    const fiber = ctx.plugin(pluginCtx => installCancellationAdapters(pluginCtx, {
      owns: () => true, cancelling, interrupt: () => false,
    }))
    await fiber
    const child = agent('later')
    const original = child.cancel
    ctx.emit('agent/created', { agent: child } as never)
    child.cancel({ kind: 'parent' })
    expect(cancelling).toHaveBeenCalledWith(child, { kind: 'parent' })
    ctx.emit('agent/disposed', { agent: child } as never)
    expect(child.cancel).toBe(original)
    await fiber.dispose()
  })

  it('still aborts the Agent if durable workflow cancellation fails', async () => {
    const ctx = new Context()
    const owned = agent('owned')
    const original = owned.cancel
    ctx.provide('agents', { list: () => [owned] } as never)
    const fiber = ctx.plugin(pluginCtx => installCancellationAdapters(pluginCtx, {
      owns: () => true,
      cancelling: () => { throw new Error('workflow log write failed') },
      interrupt: () => false,
    }))
    await fiber
    expect(() => owned.cancel({ kind: 'user' })).toThrow('workflow log write failed')
    expect(original).toHaveBeenCalledWith({ kind: 'user' }, undefined)
    await fiber.dispose()
  })
})
