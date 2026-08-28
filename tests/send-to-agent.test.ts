import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import { WaiterRegistry } from '../src/workflow/waiters.js'
import type { Config } from '../src/config.js'
import {
  AUTOREPORT_SCHEMA_VERSION,
  type TaskSnapshot,
  type WorkflowMetaSnapshot,
} from '../src/workflow/events.js'
import { resolveWorkflowSettings, type WorkflowSettingsSnapshot } from '../src/settings.js'
import { createSendToAgentTool, type SendToAgentWorkflow } from '../src/tools/send-to-agent.js'

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: 600_000,
}

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    version: 1,
    taskId: 'task-1',
    subject: 'Derive Hamiltonian',
    role: 'THEORY',
    dependencies: [],
    status: 'pending',
    revision: 1,
    steps: [{ description: 'write derivation', done: false }],
    scopes: ['Theory'],
    ...overrides,
  }
}

/** Durable workflow event carrying a creation-time settings snapshot. */
function workflowMeta(settings: WorkflowSettingsSnapshot): WorkflowMetaSnapshot {
  return {
    version: AUTOREPORT_SCHEMA_VERSION,
    workflowId: 'wf-1',
    workspaceRoot: '/workspace',
    language: settings.reportLanguage,
    initialized: true,
    settings,
  }
}

function harness() {
  const session = Session.create(SessionId('main'))
  const state = WorkflowState.fromSession(session)
  const waiters = new WaiterRegistry()
  const roleRegistry = new RoleRegistry()
  const workflow: SendToAgentWorkflow = {
    roleRegistry,
    forSession: () => ({ state, waiters }),
    commit(target, type, data) {
      const event = appendWorkflowEvent(target, type, data)
      state.apply(event)
      return event
    },
  }
  workflow.commit(session, 'autoreport/task', task())
  const subagents = {
    startContinuable: vi.fn(async (spec: { childId?: SessionId }) => {
      expect(roleRegistry.lookup(spec.childId ?? '')?.binding.provisioning).toBe('reserved')
      return { childId: spec.childId, messageId: 'msg-start' }
    }),
    followup: vi.fn(async () => 'msg-followup'),
  }
  const tool = createSendToAgentTool({
    subagents,
    workflow,
    config: CONFIG,
    now: () => 1_700_000_000_000,
    childId: () => SessionId('child-theory'),
    persona: () => 'persona-text',
  })
  const exec = {
    agent: { id: session.id, session },
    signal: new AbortController().signal,
  }
  const call = (args: Record<string, unknown>) =>
    tool.execute(args as never, exec as never) as Promise<Record<string, unknown>>
  return { session, state, waiters, roleRegistry, workflow, subagents, call }
}

describe('send_to_agent', () => {
  it('dispatches without a prior report_task when task_id is omitted', async () => {
    const session = Session.create(SessionId('main'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    const roleRegistry = new RoleRegistry()
    const workflow: SendToAgentWorkflow = {
      roleRegistry,
      forSession: () => ({ state, waiters }),
      commit(target, type, data) {
        const event = appendWorkflowEvent(target, type, data)
        state.apply(event)
        return event
      },
    }
    const subagents = {
      startContinuable: vi.fn(async (spec: { childId?: SessionId }) => ({
        childId: spec.childId,
        messageId: 'msg-auto',
      })),
      followup: vi.fn(),
    }
    const tool = createSendToAgentTool({
      subagents,
      workflow,
      config: CONFIG,
      childId: () => SessionId('child-auto'),
      persona: () => 'p',
    })
    const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
    const result = await tool.execute({
      role: 'PLOTTING',
      prompt: 'Plot the fit results',
      wait: false,
    } as never, exec as never) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'delegated', task_id: 'task-1', delegation_revision: 1 })
    expect(state.getTask('task-1')).toMatchObject({
      subject: 'Plot the fit results',
      role: 'PLOTTING',
      status: 'running',
      scopes: ['Plots'],
    })
    expect(subagents.startContinuable).toHaveBeenCalledOnce()
  })

  it('rebinds and starts fresh when followup is NOT_RESUMABLE', async () => {
    const session = Session.create(SessionId('main'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    const roleRegistry = new RoleRegistry()
    const workflow: SendToAgentWorkflow = {
      roleRegistry,
      forSession: () => ({ state, waiters }),
      commit(target, type, data) {
        const event = appendWorkflowEvent(target, type, data)
        state.apply(event)
        return event
      },
    }
    workflow.commit(session, 'autoreport/task', task())
    const ids = [SessionId('child-a'), SessionId('child-b')]
    const subagents = {
      startContinuable: vi.fn(async (spec: { childId?: SessionId }) => {
        if (spec.childId === 'child-b') {
          return { childId: spec.childId, messageId: 'msg-rebind' }
        }
        return { childId: spec.childId, messageId: 'msg-start' }
      }),
      followup: vi.fn(async () => {
        const error = Object.assign(new Error('not resumable'), { code: 'NOT_RESUMABLE' })
        throw error
      }),
    }
    const tool = createSendToAgentTool({
      subagents,
      workflow,
      config: CONFIG,
      childId: () => ids.shift() ?? SessionId('child-overflow'),
      persona: () => 'p',
    })
    const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
    const call = (args: Record<string, unknown>) => tool.execute(args as never, exec as never)
    await call({ role: 'THEORY', task_id: 'task-1', prompt: 'first', wait: false })
    workflow.commit(session, 'autoreport/delegation', {
      ...state.currentDelegation('task-1')!,
      phase: 'completed',
      settledAt: 2,
    })
    await expect(call({ role: 'THEORY', task_id: 'task-1', prompt: 'second', wait: false }))
      .resolves.toMatchObject({ status: 'delegated', delegation_revision: 2, message_id: 'msg-rebind' })
    expect(subagents.followup).toHaveBeenCalledOnce()
    expect(subagents.startContinuable).toHaveBeenCalledTimes(2)
    expect(state.bindingForRole('THEORY')?.childSessionId).toBe('child-b')
    expect(state.currentDelegation('task-1')?.childSessionId).toBe('child-b')
  })

  it('reserves the child id before startContinuable and returns immediately when wait is false', async () => {
    const { call, state, roleRegistry, subagents } = harness()
    const result = await call({
      role: 'THEORY',
      task_id: 'task-1',
      prompt: 'Derive H',
      wait: false,
    })
    expect(result).toMatchObject({
      status: 'delegated',
      task_id: 'task-1',
      delegation_revision: 1,
      message_id: 'msg-start',
    })
    expect(subagents.startContinuable).toHaveBeenCalledOnce()
    const startSpec = subagents.startContinuable.mock.calls[0]?.[0] as {
      request?: { toolFilter?: { deny?: readonly string[] } }
    }
    // DSH applies this inherited-tool restriction in the child's creation
    // window; the role guard remains the execution authority.
    expect(startSpec.request?.toolFilter).toEqual({
      deny: ['send_to_agent', 'ask_user_question'],
    })
    expect(roleRegistry.lookup('child-theory')?.binding.provisioning).toBe('active')
    expect(state.currentDelegation('task-1')?.phase).toBe('waiting_for_child')
    expect(state.currentDelegation('task-1')?.acceptedMessageId).toBe('msg-start')
    expect(state.bindingForRole('THEORY')?.childSessionId).toBe('child-theory')
  })

  it('followups an already-active child on the next dispatch', async () => {
    const { call, subagents, state, session, workflow } = harness()
    await call({ role: 'THEORY', task_id: 'task-1', prompt: 'first', wait: false })
    const current = state.currentDelegation('task-1')
    expect(current).toBeDefined()
    workflow.commit(session, 'autoreport/delegation', { ...current!, phase: 'completed', settledAt: 1 })
    const next = await call({ role: 'THEORY', task_id: 'task-1', prompt: 'retry', wait: false })
    expect(subagents.startContinuable).toHaveBeenCalledOnce()
    expect(subagents.followup).toHaveBeenCalledOnce()
    expect(next).toMatchObject({ status: 'delegated', delegation_revision: 2, message_id: 'msg-followup' })
  })

  it('revokes a reserved binding when startContinuable fails', async () => {
    const { call, roleRegistry, state, subagents } = harness()
    subagents.startContinuable.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(call({ role: 'THEORY', task_id: 'task-1', prompt: 'Derive H', wait: false }))
      .rejects.toThrow(/spawn failed/)
    expect(roleRegistry.lookup('child-theory')).toBeUndefined()
    expect(state.bindingForRole('THEORY')?.provisioning).toBe('failed')
    expect(state.currentDelegation('task-1')?.phase).toBe('failed')
  })

  it('rebinds a failed role onto a new reserved child id', async () => {
    const session = Session.create(SessionId('main'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    const roleRegistry = new RoleRegistry()
    const workflow: SendToAgentWorkflow = {
      roleRegistry,
      forSession: () => ({ state, waiters }),
      commit(target, type, data) {
        const event = appendWorkflowEvent(target, type, data)
        state.apply(event)
        return event
      },
    }
    workflow.commit(session, 'autoreport/task', task())
    const ids = [SessionId('child-a'), SessionId('child-b')]
    const subagents = {
      startContinuable: vi.fn(async (spec: { childId?: SessionId }) => {
        if (spec.childId === 'child-a') throw new Error('first start failed')
        expect(roleRegistry.lookup('child-a')).toBeUndefined()
        expect(roleRegistry.lookup('child-b')?.binding.provisioning).toBe('reserved')
        return { childId: spec.childId, messageId: 'msg-b' }
      }),
      followup: vi.fn(),
    }
    const tool = createSendToAgentTool({
      subagents,
      workflow,
      config: CONFIG,
      childId: () => ids.shift() ?? SessionId('child-overflow'),
      persona: () => 'p',
    })
    const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
    const call = (args: Record<string, unknown>) => tool.execute(args as never, exec as never)
    await expect(call({ role: 'THEORY', task_id: 'task-1', prompt: 'one', wait: false })).rejects.toThrow(/first start failed/)
    await expect(call({ role: 'THEORY', task_id: 'task-1', prompt: 'two', wait: false }))
      .resolves.toMatchObject({ status: 'delegated', message_id: 'msg-b' })
    expect(state.bindingForRole('THEORY')?.childSessionId).toBe('child-b')
    expect(state.bindingForRole('THEORY')?.supersedes).toBe('child-a')
  })

  it('waits on the delegation waiter and maps a completed report to success', async () => {
    const { call, waiters } = harness()
    const pending = call({
      role: 'THEORY',
      task_id: 'task-1',
      prompt: 'Derive H',
      wait: true,
      timeout_ms: 5_000,
    })
    await vi.waitFor(() => expect(waiters.pendingKeys()).toBe(1))
    waiters.settle('task-1#1', { status: 'completed', response: 'H written', producedFiles: ['Theory/formulas.md'] })
    await expect(pending).resolves.toEqual({
      status: 'success',
      task_id: 'task-1',
      delegation_revision: 1,
      response: 'H written',
      produced_files: ['Theory/formulas.md'],
    })
  })

  it('records a durable timeout when wait:true elapses with no report', async () => {
    const { call, state } = harness()
    await expect(call({
      role: 'THEORY',
      task_id: 'task-1',
      prompt: 'Derive H',
      timeout_ms: 20,
    })).resolves.toMatchObject({ status: 'timeout', task_id: 'task-1' })
    expect(state.currentDelegation('task-1')?.phase).toBe('timed_out')
  })

  it('rejects a second wait while the current attempt is still waiting_for_child', async () => {
    const { call } = harness()
    await call({ role: 'THEORY', task_id: 'task-1', prompt: 'first', wait: false })
    await expect(call({ role: 'THEORY', task_id: 'task-1', prompt: 'overlap', wait: false }))
      .rejects.toThrow(/already has work waiting/)
  })

  it('rejects completed tasks, missing dependencies, and role mismatch', async () => {
    const { call, workflow, session } = harness()
    workflow.commit(session, 'autoreport/task', task({
      taskId: 'task-2',
      role: 'PLOTTING',
      status: 'pending',
      dependencies: ['task-1'],
      scopes: ['Plots'],
    }))
    await expect(call({ role: 'PLOTTING', task_id: 'task-2', prompt: 'plot', wait: false }))
      .rejects.toThrow(/dependency/)
    workflow.commit(session, 'autoreport/task', task({ status: 'completed', revision: 2 }))
    await expect(call({ role: 'THEORY', task_id: 'task-1', prompt: 'again', wait: false }))
      .rejects.toThrow(/cannot be dispatched/)
    await expect(call({ role: 'REPORT', task_id: 'task-1', prompt: 'wrong', wait: false }))
      .rejects.toThrow(/belongs to THEORY/)
  })

  it('routes the child through the snapshot specialist model and wait bound when present', async () => {
    const session = Session.create(SessionId('main'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    const roleRegistry = new RoleRegistry()
    const workflow: SendToAgentWorkflow = {
      roleRegistry,
      forSession: () => ({ state, waiters }),
      commit(target, type, data) {
        const event = appendWorkflowEvent(target, type, data)
        state.apply(event)
        return event
      },
    }
    workflow.commit(session, 'autoreport/task', task())
    workflow.commit(session, 'autoreport/workflow', workflowMeta(resolveWorkflowSettings({
      override: { specialistModel: { provider: 'route-provider', model: 'route-model' }, delegationWaitTimeoutMs: 30 },
    })))
    const startContinuable = vi.fn(async (spec: { childId?: SessionId; request?: { agentOptions?: unknown } }) => ({ childId: spec.childId, messageId: 'msg-snap' }))
    const tool = createSendToAgentTool({
      subagents: { startContinuable, followup: vi.fn(async () => 'msg-f') },
      workflow,
      // Composition route must be IGNORED while a snapshot exists.
      config: { ...CONFIG, specialistModel: { provider: 'stale-provider', model: 'stale-model' } },
      childId: () => SessionId('child-snap'),
      persona: () => 'p',
    })
    const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
    // No explicit timeout_ms: the snapshot's bound drives the wait.
    await expect(tool.execute({ role: 'THEORY', task_id: 'task-1', prompt: 'x' } as never, exec as never))
      .resolves.toMatchObject({ status: 'timeout' })
    expect(startContinuable.mock.calls[0]?.[0]?.request?.agentOptions).toEqual({ provider: 'route-provider', model: 'route-model' })
    expect(state.currentDelegation('task-1')?.phase).toBe('timed_out')
    expect(state.currentDelegation('task-1')?.reason).toContain('30ms')
  })

  it('passes no agentOptions when the snapshot records explicit Main inheritance', async () => {
    const session = Session.create(SessionId('main'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    const roleRegistry = new RoleRegistry()
    const workflow: SendToAgentWorkflow = {
      roleRegistry,
      forSession: () => ({ state, waiters }),
      commit(target, type, data) {
        const event = appendWorkflowEvent(target, type, data)
        state.apply(event)
        return event
      },
    }
    workflow.commit(session, 'autoreport/task', task())
    workflow.commit(session, 'autoreport/workflow', workflowMeta(resolveWorkflowSettings({})))
    const startContinuable = vi.fn(async (spec: { childId?: SessionId; request?: { agentOptions?: unknown } }) => ({ childId: spec.childId, messageId: 'msg-inherit' }))
    const tool = createSendToAgentTool({
      subagents: { startContinuable, followup: vi.fn(async () => 'msg-f') },
      workflow,
      config: { ...CONFIG, specialistModel: { provider: 'comp-provider', model: 'comp-model' } },
      childId: () => SessionId('child-inherit'),
      persona: () => 'p',
    })
    const exec = { agent: { id: session.id, session }, signal: new AbortController().signal }
    await tool.execute({ role: 'THEORY', task_id: 'task-1', prompt: 'x', wait: false } as never, exec as never)
    expect(startContinuable.mock.calls[0]?.[0]?.request?.agentOptions).toBeUndefined()
  })
})
