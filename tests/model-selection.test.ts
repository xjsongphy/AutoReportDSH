import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { Config } from '../src/config.js'
import { installSpecialistModelSelection } from '../src/tools/report-router.js'

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: 600_000,
  executionTimeoutMs: 600_000,
}

describe('specialist model selection', () => {
  it('uses DSH agent-scoped selection for a configured specialist route', async () => {
    const listeners = new Map<string, (...args: never[]) => unknown>()
    const child = {
      agent: { id: SessionId('child-selection') },
      on: (event: string, listener: (...args: never[]) => unknown) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
    } as unknown as Context

    const dispose = installSpecialistModelSelection(child, {
      roleRegistry: new RoleRegistry(),
      config: {
        ...CONFIG,
        specialistModel: {
          provider: 'specialist',
          model: 'reasoning-model',
          reasoningEffort: 'high',
        },
      },
      workflowForChild: () => undefined,
    })

    expect(dispose).toBeTypeOf('function')
    const assemble = listeners.get('system-prompt/assemble')!
    const assembled = await assemble(
      {} as never,
      {} as never,
      (async () => ({ variables: { provider: 'main', model: 'main-model' } })) as never,
    )
    expect(assembled).toMatchObject({ variables: { provider: 'specialist', model: 'reasoning-model' } })

    const request = listeners.get('agent/request')!
    const routed = await request(
      {} as never,
      (async () => ({ provider: 'main', model: 'main-model', reasoningEffort: 'low' })) as never,
    )
    expect(routed).toEqual({ provider: 'specialist', model: 'reasoning-model', reasoningEffort: 'high' })
    dispose?.()
    expect(listeners.size).toBe(0)
  })
})
