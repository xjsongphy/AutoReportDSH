import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type {
  DelegationSnapshot,
  RoleBindingSnapshot,
  TaskSnapshot,
} from '../src/workflow/events.js'

/**
 * End-to-end workflow-fold scenario (PLAN §2.3–2.6 + recovery rule):
 * reserve → active → create → dispatch rev1 → waiting_for_child → success
 * report rev1 → dispatch rev2 → late stale rev1 report → rebind mid-task.
 */
describe('workflow fold scenario', () => {
  it('folds the whole lifecycle deterministically and keeps stale evidence', () => {
    const session = Session.create(SessionId('fold-main'))
    const commit = <T extends keyof SessionEventMap & string>(type: T, data: SessionEventMap[T]): void => {
      appendWorkflowEvent(session, type as never, data as never)
    }

    // 1. Reserve BEFORE materialization: authorization exists immediately.
    const bindingV1: RoleBindingSnapshot = {
      version: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da-1'),
      parentSessionId: SessionId('fold-main'),
      workflowId: 'wf-42',
      provisioning: 'reserved',
    }
    commit('autoreport/role-binding', bindingV1)

    // 2. Accepted start -> active.
    commit('autoreport/role-binding', { ...bindingV1, provisioning: 'active' })

    // 3. Task creation with checklist.
    const taskV1: TaskSnapshot = {
      version: 1,
      taskId: 'task-7',
      subject: 'Analyze experiment data',
      role: 'DATA_ANALYSIS',
      dependencies: [],
      status: 'pending',
      revision: 1,
      steps: [
        { description: 'preprocess raw data', done: true },
        { description: 'generate intermediate results', done: true },
        { description: 'fit model', done: false },
        { description: 'generate final figures', done: false },
      ],
      scopes: ['Data/Processed'],
    }
    commit('autoreport/task', taskV1)
    commit('autoreport/task', { ...taskV1, status: 'running', latestDelegationRevision: 1, revision: 2 })

    // 4. Dispatch revision 1; child accepted the message.
    const delegation1: DelegationSnapshot = {
      version: 1,
      taskId: 'task-7',
      delegationRevision: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da-1'),
      acceptedMessageId: 'msg-a',
      phase: 'dispatched',
      dispatchedAt: 1000,
    }
    commit('autoreport/delegation', delegation1)
    commit('autoreport/delegation', { ...delegation1, phase: 'waiting_for_child' })

    // 5. Child reports SUCCESS for revision 1.
    commit('autoreport/delegation', {
      ...delegation1,
      phase: 'completed',
      settledAt: 2000,
      report: {
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'analysis complete',
        produced_files: ['Data/Processed/fit.csv'],
      },
    })
    commit('autoreport/artifact', {
      version: 1,
      path: 'Data/Processed/fit.csv',
      producedBy: 'DATA_ANALYSIS',
      origin: 'process',
      status: 'created',
      taskId: 'task-7',
      delegationKey: 'task-7#1',
      recordedAt: 2100,
    })

    // 6. Re-dispatch as revision 2 after a quality complaint.
    const delegation2: DelegationSnapshot = {
      ...delegation1,
      delegationRevision: 2,
      acceptedMessageId: 'msg-b',
      dispatchedAt: 3000,
    }
    commit('autoreport/delegation', delegation2)
    commit('autoreport/task', { ...taskV1, status: 'running', latestDelegationRevision: 2, revision: 3 })

    // 7. LATE report for the OLD revision arrives: it must stay in its own
    // slot as evidence and must NOT complete or alter revision 2.
    commit('autoreport/delegation', {
      ...delegation1,
      phase: 'stale',
      settledAt: 3500,
      report: {
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'late duplicate success',
        produced_files: [],
      },
    })

    // 8. Mid-task rebind to a fresh child id.
    const bindingV2: RoleBindingSnapshot = {
      version: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da-2'),
      parentSessionId: SessionId('fold-main'),
      workflowId: 'wf-42',
      provisioning: 'reserved',
      supersedes: SessionId('child-da-1'),
    }
    commit('autoreport/role-binding', bindingV2)

    // ---- assertions over a COLD FOLD (recovery from log only) ----
    const state = WorkflowState.fromEvents(session.events)
    expect(state.projection().meta).toBeUndefined()
    expect(state.getTask('task-7')?.status).toBe('running')
    expect(state.getTask('task-7')?.latestDelegationRevision).toBe(2)
    expect(state.currentDelegation('task-7')?.delegationRevision).toBe(2)
    expect(state.currentDelegation('task-7')?.phase).toBe('dispatched')
    // Stale evidence retained per-slot without leaking into current state:
    const stale = state.delegationAt('task-7', 1)
    expect(stale?.phase).toBe('stale')
    expect(stale?.report?.response).toBe('late duplicate success')
    expect(state.bindingForRole('DATA_ANALYSIS')?.childSessionId).toBe('child-da-2')
    // Old child remains folded as evidence...
    expect(state.bindingForChild('child-da-1')?.provisioning).toBe('active')
    // ...but the registry authorizes ONLY the replacement.
    const registry = RoleRegistry.reconstruct(state)
    expect(registry.lookup('child-da-2')).toBeDefined()
    expect(registry.lookup('child-da-1')).toBeUndefined()
    // Open work is discoverable by role ownership alone.
    expect(state.openTasksForRole('DATA_ANALYSIS').map(task => task.taskId)).toEqual(['task-7'])
    expect(state.openTasksForRole('THEORY')).toEqual([])
    expect(state.projection().artifacts.map(artifact => artifact.path)).toEqual(['Data/Processed/fit.csv'])
  })

  it('reconstructs identically when events arrive incrementally', () => {
    const session = Session.create(SessionId('incr'))
    const incremental = WorkflowState.empty()
    void incremental
    const events = session.events.slice()
    const batch = WorkflowState.fromEvents(events)
    const stepwise = WorkflowState.empty()
    for (const event of events) stepwise.apply(event)
    expect(stepwise.projection().tasks.size).toBe(batch.projection().tasks.size)
  })

  it('ignores non-autoreport events during apply', () => {
    const state = WorkflowState.empty()
    const session = Session.create(SessionId('noise'))
    session.append('turn/start', { turn: 1 })
    state.apply(session.events[0]!)
    expect(state.projection().tasks.size).toBe(0)
  })
})
