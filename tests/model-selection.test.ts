import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { Config } from '../src/config.js'
import { installSpecialistModelSelection } from '../src/tools/report-router.js'
import type { WorkflowSettingsSnapshot } from '../src/settings.js'

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationIdleTimeoutMs: 60_000,
  delegationWaitTimeoutMs: 600_000,
}

function workflowWithSettings(settings: WorkflowSettingsSnapshot) {
  return {
    runtime: {
      state: {
        projection: () => ({ meta: { settings } }),
      },
    },
  }
}

function childContext() {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
  const child = {
    agent: { id: SessionId('child-selection') },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const remaining = (listeners.get(event) ?? []).filter(entry => entry !== listener)
        if (remaining.length === 0) listeners.delete(event)
        else listeners.set(event, remaining)
      }
    },
  } as unknown as Context
  async function invoke(event: string, terminal: () => Promise<unknown>): Promise<unknown> {
    const list = listeners.get(event) ?? []
    let index = list.length
    const next = async (): Promise<unknown> => {
      index -= 1
      const listener = list[index]
      if (listener === undefined) return terminal()
      if (event === 'system-prompt/assemble') {
        return listener({} as never, {} as never, next)
      }
      return listener({} as never, next)
    }
    return next()
  }
  return { child, invoke, listeners }
}

describe('specialist model selection', () => {
  it('uses DSH agent-scoped selection from the frozen workflow snapshot, then releases it', async () => {
    const { child, invoke } = childContext()

    const dispose = installSpecialistModelSelection(child, {
      roleRegistry: new RoleRegistry(),
      config: CONFIG,
      workflowForChild: () => workflowWithSettings({
        reportLanguage: 'latex',
        specialistModel: {
          inheritMain: false,
          provider: 'specialist',
          model: 'reasoning-model',
          reasoningEffort: 'high',
        },
        delegationWaitTimeoutMs: 600_000,
      }) as never,
    })

    expect(dispose).toBeTypeOf('function')
    const assembled = await invoke(
      'system-prompt/assemble',
      async () => ({ variables: { provider: 'main', model: 'main-model' } }),
    )
    expect(assembled).toMatchObject({ variables: { provider: 'specialist', model: 'reasoning-model' } })

    const routed = await invoke(
      'agent/request',
      async () => ({ provider: 'main', model: 'main-model', reasoningEffort: 'low' }),
    )
    expect(routed).toEqual({ provider: 'specialist', model: 'reasoning-model', reasoningEffort: 'high' })

    const assembledAgain = await invoke(
      'system-prompt/assemble',
      async () => ({ variables: { provider: 'main', model: 'main-model' } }),
    )
    expect(assembledAgain).toMatchObject({ variables: { provider: 'main', model: 'main-model' } })
    dispose?.()
  })

  it('releases the snapshot pin when the first agent request throws', async () => {
    const { child, invoke } = childContext()

    const dispose = installSpecialistModelSelection(child, {
      roleRegistry: new RoleRegistry(),
      config: CONFIG,
      workflowForChild: () => workflowWithSettings({
        reportLanguage: 'latex',
        specialistModel: {
          inheritMain: false,
          provider: 'specialist',
          model: 'reasoning-model',
          reasoningEffort: 'high',
        },
        delegationWaitTimeoutMs: 600_000,
      }) as never,
    })

    await invoke(
      'system-prompt/assemble',
      async () => ({ variables: { provider: 'main', model: 'main-model' } }),
    )
    await expect(invoke('agent/request', async () => {
      throw new Error('first request failed')
    })).rejects.toThrow(/first request failed/)

    const assembledAgain = await invoke(
      'system-prompt/assemble',
      async () => ({ variables: { provider: 'main', model: 'main-model' } }),
    )
    expect(assembledAgain).toMatchObject({ variables: { provider: 'main', model: 'main-model' } })

    const routedAgain = await invoke(
      'agent/request',
      async () => ({ provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
    )
    expect(routedAgain).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'low' })
    dispose?.()
  })

  it('does not install a route when the snapshot inherits Main', () => {
    const { child, listeners } = childContext()

    const dispose = installSpecialistModelSelection(child, {
      roleRegistry: new RoleRegistry(),
      config: {
        ...CONFIG,
        specialistModel: { provider: 'stale-provider', model: 'stale-model' },
      },
      workflowForChild: () => workflowWithSettings({
        reportLanguage: 'latex',
        specialistModel: { inheritMain: true },
        delegationWaitTimeoutMs: 600_000,
      }) as never,
    })

    expect(dispose).toBeUndefined()
    expect(listeners.size).toBe(0)
  })

  it('does not fall back to composition config when no snapshot exists', () => {
    const { child, listeners } = childContext()

    const dispose = installSpecialistModelSelection(child, {
      roleRegistry: new RoleRegistry(),
      config: {
        ...CONFIG,
        specialistModel: { provider: 'composition', model: 'stale' },
      },
      workflowForChild: () => undefined,
    })

    expect(dispose).toBeUndefined()
    expect(listeners.size).toBe(0)
  })
})
