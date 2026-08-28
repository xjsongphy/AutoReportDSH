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

describe('specialist model selection', () => {
  it('uses DSH agent-scoped selection from the frozen workflow snapshot', async () => {
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

  it('does not install a route when the snapshot inherits Main', () => {
    const child = {
      agent: { id: SessionId('child-inherit') },
      on: () => () => {},
    } as unknown as Context

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
  })

  it('does not fall back to composition config when no snapshot exists', () => {
    const child = {
      agent: { id: SessionId('child-missing-snapshot') },
      on: () => () => {},
    } as unknown as Context

    const dispose = installSpecialistModelSelection(child, {
      roleRegistry: new RoleRegistry(),
      config: {
        ...CONFIG,
        specialistModel: { provider: 'composition', model: 'stale' },
      },
      workflowForChild: () => undefined,
    })

    expect(dispose).toBeUndefined()
  })
})
