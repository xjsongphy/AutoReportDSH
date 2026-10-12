/** Reversible host adapters for AutoReport-owned Agent and subagent cancellation. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentInterruptAuthority } from '@deepseek-ai/dsh-subagent'

interface CancellationOwner {
  owns(agent: Agent): boolean
  cancelling(agent: Agent, cause: AgentCancelCause): void
  interrupt(childId: SessionId, authority: SubagentInterruptAuthority): boolean
}

/**
 * Route the stock stop controls to resident handles while retaining upstream
 * behavior for ordinary sessions. The current harness has no cancel-request
 * event; these effect-owned adapters are removed when the plugin unloads.
 * @param ctx - host context owning the adapters.
 * @param owner - exact AutoReport ownership and workflow cancellation operations.
 */
export function installCancellationAdapters(ctx: Context, owner: CancellationOwner): void {
  const restorers = new Map<Agent, () => void>()
  const attach = (agent: Agent): void => {
    if (!owner.owns(agent) || restorers.has(agent)) return
    const original = agent.cancel
    const descriptor = Object.getOwnPropertyDescriptor(agent, 'cancel')
    const wrapped: Agent['cancel'] = (cause, options) => {
      try {
        owner.cancelling(agent, cause)
      } finally {
        original.call(agent, cause, options)
      }
    }
    agent.cancel = wrapped
    restorers.set(agent, () => {
      if (agent.cancel !== wrapped) return
      if (descriptor === undefined) Reflect.deleteProperty(agent, 'cancel')
      else Object.defineProperty(agent, 'cancel', descriptor)
    })
  }
  ctx.on('agent/created', ({ agent }) => {
    attach(agent)
    return undefined
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    restorers.get(agent)?.()
    restorers.delete(agent)
  }, { global: true })
  ctx.effect(() => () => {
    for (const restore of restorers.values()) restore()
    restorers.clear()
  }, 'autoreport.cancelAgents()')
  for (const agent of ctx.get('agents')?.list?.() ?? []) attach(agent)

  ctx.inject(['subagents'], subctx => {
    const facade = subctx.subagents
    const service = (facade as unknown as { [symbols.original]?: SubagentRuntime })[symbols.original] ?? facade
    const original = service.interrupt
    const descriptor = Object.getOwnPropertyDescriptor(service, 'interrupt')
    const wrapped: SubagentRuntime['interrupt'] = function (this: SubagentRuntime, childId, authority) {
      if (!owner.interrupt(childId, authority)) original.call(this, childId, authority)
    }
    subctx.effect(() => {
      service.interrupt = wrapped
      return () => {
        if (service.interrupt !== wrapped) return
        if (descriptor === undefined) Reflect.deleteProperty(service, 'interrupt')
        else Object.defineProperty(service, 'interrupt', descriptor)
      }
    }, 'autoreport.cancelSubagents()')
  })
}
