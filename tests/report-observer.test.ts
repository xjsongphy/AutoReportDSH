import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { WaiterRegistry } from '../src/workflow/waiters.js'
import type { DelegationSnapshot, TaskSnapshot } from '../src/workflow/events.js'
import { observeWorkflowMessage } from '../src/workflow/report-observer.js'

function seedWaiting(session: Session, state: WorkflowState, revision = 1): DelegationSnapshot {
  const task: TaskSnapshot = {
    version: 1,
    taskId: 'task-7',
    subject: 'Analyze',
    role: 'DATA_ANALYSIS',
    dependencies: [],
    status: 'running',
    revision: 1,
    steps: [],
    scopes: ['Data/Processed'],
    latestDelegationRevision: revision,
  }
  const waiting: DelegationSnapshot = {
    version: 1,
    taskId: 'task-7',
    delegationRevision: revision,
    role: 'DATA_ANALYSIS',
    childSessionId: SessionId('child-da'),
    acceptedMessageId: 'msg-out',
    phase: 'waiting_for_child',
    dispatchedAt: 10,
  }
  state.apply(appendWorkflowEvent(session, 'autoreport/task', task))
  state.apply(appendWorkflowEvent(session, 'autoreport/delegation', waiting))
  return waiting
}

function observe(session: Session, state: WorkflowState, waiters: WaiterRegistry, event: Parameters<typeof observeWorkflowMessage>[1]) {
  observeWorkflowMessage(session, event, {
    state,
    waiters,
    commit: (type, data) => {
      state.apply(appendWorkflowEvent(session, type, data))
    },
  })
}

describe('report observer', () => {
  it('folds a valid success report into completed and settles the waiter', async () => {
    const session = Session.create(SessionId('parent'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const pending = waiters.wait('task-7#1', 5_000)
    const envelope = {
      task_id: 'task-7',
      delegation_revision: 1,
      status: 'success',
      block_type: null,
      response: 'processed.csv written',
      produced_files: ['Data/Processed/out.csv'],
    }
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('completed')
    expect(state.currentDelegation('task-7')?.reportMessageId).toBe(String(event.data.id))
    await expect(pending).resolves.toMatchObject({ status: 'completed', response: 'processed.csv written' })
  })

  it('keeps a late report as stale evidence without completing the current revision', () => {
    const session = Session.create(SessionId('parent'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state, 1)
    seedWaiting(session, state, 2)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'late',
        produced_files: [],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.delegationAt('task-7', 1)?.phase).toBe('stale')
    expect(state.currentDelegation('task-7')?.delegationRevision).toBe(2)
    expect(state.currentDelegation('task-7')?.phase).toBe('waiting_for_child')
  })

  it('is idempotent for a duplicate transport message id', () => {
    const session = Session.create(SessionId('parent'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const message = createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'once',
        produced_files: [],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    })
    const first = session.append('user/message', message, { surfaceOp: 'append' })
    observe(session, state, waiters, first)
    const settledAt = state.currentDelegation('task-7')?.settledAt
    observe(session, state, waiters, first)
    expect(state.currentDelegation('task-7')?.phase).toBe('completed')
    expect(state.currentDelegation('task-7')?.settledAt).toBe(settledAt)
  })

  it('turns a malformed child report into an explicit quality failure', async () => {
    const session = Session.create(SessionId('parent'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const pending = waiters.wait('task-7#1', 5_000)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not-json' }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('failed')
    expect(state.currentDelegation('task-7')?.reason).toMatch(/invalid workflow report/)
    await expect(pending).resolves.toMatchObject({ status: 'failed' })
  })

  it('fails the current attempt when the child settles without a workflow report', async () => {
    const session = Session.create(SessionId('parent'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const pending = waiters.wait('task-7#1', 5_000)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'child ended' }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'child cancelled',
        senderSessionId: SessionId('child-da'),
      },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('failed')
    expect(state.currentDelegation('task-7')?.reason).toBe('child cancelled')
    await expect(pending).resolves.toMatchObject({ status: 'failed', response: 'child cancelled' })
  })

  it('ignores reports from an unbound child', () => {
    const session = Session.create(SessionId('parent'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'spoofed',
        produced_files: [],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('other-child') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('waiting_for_child')
  })
})
