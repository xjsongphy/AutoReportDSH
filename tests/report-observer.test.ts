import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { WaiterRegistry } from '../src/workflow/waiters.js'
import type { DelegationSnapshot, TaskSnapshot } from '../src/workflow/events.js'
import { observeWorkflowMessage, recoverWorkflowReports } from '../src/workflow/report-observer.js'
import { installWorkflowReportTool } from '../src/tools/report-workflow.js'
import { workflowState } from './helpers/workflow-log.js'
import { sessionIn, workspaceForTests, workflowState } from './helpers/workflow-log.js'

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

/** Minimal specialist scope carrying only the report tool under test. */
function childReportContext(id: string) {
  const tools: { name: string }[] = []
  const sessionId = SessionId(id)
  const session = sessionIn(WORKSPACE, id, SessionId('parent'))
  const ctx = {
    agent: { id: sessionId, session },
    tools: {
      register: (tool: { name: string }) => {
        tools.push(tool)
        return () => {}
      },
    },
  } as unknown as Context
  return { ctx, agent: { id: sessionId, session }, tools }
}

function reportTool(tools: { name: string }[]) {
  const tool = tools.find(entry => entry.name === 'report_workflow') as
    | { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }
    | undefined
  if (tool === undefined) throw new Error('missing report_workflow')
  return tool
}

// A fresh workspace per test: fixtures reuse session ids, so a shared root
// would let one test's workflow log leak into the next.
let WORKSPACE = workspaceForTests('report-observer')
beforeEach(() => { WORKSPACE = workspaceForTests('report-observer') })

describe('report observer', () => {
  it('folds a valid success report into completed and settles the waiter', async () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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
    expect(state.getTask('task-7')?.status).toBe('completed')
    expect(state.currentDelegation('task-7')?.reportMessageId).toBe(String(event.data.id))
    await expect(pending).resolves.toMatchObject({ status: 'completed', response: 'processed.csv written' })
  })

  it('settles wait:true from the report delivery inbox splice before MAIN consumes it', async () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const pending = waiters.wait('task-7#1', 5_000)
    const message = createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'delivered before parent step',
        produced_files: ['Theory/theory.md'],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    })
    const event = session.append('agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [message],
    })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('completed')
    await expect(pending).resolves.toMatchObject({ status: 'completed', response: 'delivered before parent step' })

    // When the queued message later enters the chat surface, its identity
    // prevents a duplicate workflow event or a second waiter settlement.
    const surfaced = session.append('user/message', message, { surfaceOp: 'append' })
    observe(session, state, waiters, surfaced)
    expect(state.currentDelegation('task-7')?.reportMessageId).toBe(String(message.id))
  })

  it('keeps a late report as stale evidence without completing the current revision', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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

  it('accepts a valid report after this same revision timed out', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    const waiting = seedWaiting(session, state)
    state.apply(appendWorkflowEvent(session, 'autoreport/delegation', {
      ...waiting,
      phase: 'timed_out',
      reason: 'idle timeout',
      settledAt: 20,
    }))
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'finished after Main resumed',
        produced_files: ['Data/Processed/out.csv'],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('completed')
    expect(state.getTask('task-7')?.status).toBe('completed')
  })

  it('ignores a later delivery with a different message id after a terminal report is accepted', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'once',
        produced_files: [],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, first)
    const settledAt = state.currentDelegation('task-7')?.settledAt
    const taskRevision = state.getTask('task-7')?.revision
    const second = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'twice',
        produced_files: ['Data/Processed/other.csv'],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, second)
    expect(state.currentDelegation('task-7')?.phase).toBe('completed')
    expect(state.currentDelegation('task-7')?.reportMessageId).toBe(String(first.data.id))
    expect(state.currentDelegation('task-7')?.settledAt).toBe(settledAt)
    expect(state.currentDelegation('task-7')?.report?.response).toBe('once')
    expect(state.getTask('task-7')?.revision).toBe(taskRevision)
  })

  it('recovers a waiting attempt from a logged delivery that never produced autoreport/delegation', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const warm = workflowState(session)
    seedWaiting(session, warm)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'survived the crash',
        produced_files: ['Data/Processed/out.csv'],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    const cold = workflowState(session)
    expect(cold.currentDelegation('task-7')?.phase).toBe('waiting_for_child')
    recoverWorkflowReports(session, {
      state: cold,
      waiters: new WaiterRegistry(),
      commit: (type, data) => {
        cold.apply(appendWorkflowEvent(session, type, data))
      },
    })
    expect(cold.currentDelegation('task-7')?.phase).toBe('completed')
    expect(cold.currentDelegation('task-7')?.report?.response).toBe('survived the crash')
    expect(cold.getTask('task-7')?.status).toBe('completed')
  })

  it('is idempotent for a duplicate transport message id', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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

  it('marks the task blocked when the child reports blocked', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'blocked',
        block_type: 'missing_data',
        response: 'need raw CSV',
        produced_files: [],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.currentDelegation('task-7')?.phase).toBe('blocked')
    expect(state.getTask('task-7')?.status).toBe('blocked')
    expect(state.getTask('task-7')?.blockedReason).toBe('need raw CSV')
  })

  it('marks the task failed for an invalid child report', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)
    const event = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not-json' }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, event)
    expect(state.getTask('task-7')?.status).toBe('failed')
    expect(state.getTask('task-7')?.failedReason).toMatch(/invalid workflow report/)
  })

  it('does not change the task when a stale report arrives', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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
    expect(state.getTask('task-7')?.status).toBe('running')
  })

  it('turns a malformed child report into an explicit quality failure', async () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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

  it('delivers the canonical produced_files sent to MAIN even when a later artifact lands before folding', async () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    seedWaiting(session, state)

    // Artifact A is observed before the child reports; its description is
    // current so a success report is not rejected as stale.
    state.apply(appendWorkflowEvent(session, 'autoreport/artifact', {
      version: 1,
      path: 'Data/Processed/a.csv',
      producedBy: 'DATA_ANALYSIS',
      origin: 'process',
      status: 'created',
      recordedAt: 20,
      taskId: 'task-7',
      delegationKey: 'task-7#1',
    }))
    state.apply(appendWorkflowEvent(session, 'autoreport/file-note', {
      version: 1,
      path: 'Data/Processed/a.csv',
      description: 'current output',
      descriptionUpdatedAt: 25,
      producedBy: 'DATA_ANALYSIS',
    }))

    const sendMessage = vi.fn(async () => 'report-msg')
    const child = childReportContext('child-da')
    const runtime = { workflowForChild: () => ({ runtime: { state } }) }
    const host = {
      ctx: {
        subagents: { sendMessage },
        get: (name: string) => name === 'autoreportWorkflow' ? runtime : undefined,
      } as unknown as Context,
      sendMessage,
    }
    installWorkflowReportTool(child.ctx, host.ctx, 'DATA_ANALYSIS')

    // The model's own claim (a forged path) must not reach MAIN; the tool
    // sends the observed set instead.
    await reportTool(child.tools).execute({
      task_id: 'task-7',
      delegation_revision: 1,
      status: 'success',
      response: 'wrote a.csv',
      produced_files: ['Data/Processed/forged.csv'],
    }, { agent: child.agent, signal: new AbortController().signal })
    expect(sendMessage).toHaveBeenCalledOnce()
    const content = sendMessage.mock.calls[0]?.[2] as { type: string; text: string }[]
    expect(JSON.parse(content[1]?.text ?? '{}')).toMatchObject({
      produced_files: ['Data/Processed/a.csv'],
    })

    // Artifact B lands after the report was sent but before the parent
    // observer folds the delivered message.
    state.apply(appendWorkflowEvent(session, 'autoreport/artifact', {
      version: 1,
      path: 'Data/Processed/b.csv',
      producedBy: 'DATA_ANALYSIS',
      origin: 'process',
      status: 'created',
      recordedAt: 30,
      taskId: 'task-7',
      delegationKey: 'task-7#1',
    }))

    const delivered = session.append('user/message', createUserMessage({
      content,
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    observe(session, state, waiters, delivered)

    // The durable report mirrors the canonical envelope MAIN received, not a
    // recomputation from the later projection.
    expect(state.currentDelegation('task-7')?.phase).toBe('completed')
    expect(state.currentDelegation('task-7')?.report?.produced_files).toEqual(['Data/Processed/a.csv'])
  })

  it('ignores reports from an unbound child', () => {
    const session = sessionIn(WORKSPACE, 'parent')
    const state = workflowState(session)
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
