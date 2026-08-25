import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowState } from '../src/workflow/service.js'
import { createReportTaskTool } from '../src/tools/report-task.js'

/**
 * Drive the tool the way the pipeline would: a real in-memory session plus an
 * agent-shaped exec carrying it.
 */
function harness() {
  const session = Session.create(SessionId('wf-main'))
  const state = WorkflowState.fromSession(session)
  const tool = createReportTaskTool(state)
  const exec = { agent: { session }, signal: new AbortController().signal }
  const call = (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    Promise.resolve(tool.execute(args as never, exec as never) as Promise<Record<string, unknown>>)
  return { session, state, call }
}

describe('report_task operations', () => {
  it('create assigns monotonic ids, fixes ownership, and records the checklist', async () => {
    const { call, state } = harness()
    const first = await call({ operation: 'create', subject: 'Derive Hamiltonian', role: 'THEORY', steps: [{ description: 'write derivation' }] })
    const second = await call({ operation: 'create', subject: 'Fit data', role: 'DATA_ANALYSIS' })
    expect((first['task'] as { task_id: string }).task_id).toBe('task-1')
    expect((second['task'] as { task_id: string }).task_id).toBe('task-2')
    expect(state.getTask('task-1')?.steps).toEqual([{ description: 'write derivation', done: false }])
    expect(state.getTask('task-2')?.role).toBe('DATA_ANALYSIS')
  })

  it('enforces the transition matrix (no claim; complete needs child success)', async () => {
    const { call } = harness()
    await call({ operation: 'create', subject: 'Plot spectra', role: 'PLOTTING' })
    await expect(call({ operation: 'complete', task_id: 'task-1' })).rejects.toThrow(/undispatched/)
    const dispatched = await call({ operation: 'dispatch', task_id: 'task-1' })
    expect((dispatched['task'] as { latest_phase?: string }).latest_phase).toBe('dispatched')
    await expect(call({ operation: 'dispatch', task_id: 'task-1' })).rejects.toThrow(/running/)
    await expect(call({ operation: 'complete', task_id: 'task-1' })).rejects.toThrow(/current attempt is dispatched/)
  })

  it('block/fail require reasons; reopen only from blocked/failed/cancelled', async () => {
    const { call } = harness()
    await call({ operation: 'create', subject: 'Compile draft', role: 'REPORT' })
    await call({ operation: 'dispatch', task_id: 'task-1' })
    await expect(call({ operation: 'block', task_id: 'task-1' })).rejects.toThrow(/non-empty reason/)
    await call({ operation: 'block', task_id: 'task-1', reason: 'missing bibliography' })
    await expect(call({ operation: 'reopen', task_id: 'task-1' })).resolves.toBeTruthy()
    await expect(call({ operation: 'reopen', task_id: 'task-1' })).rejects.toThrow(/status pending/)
    await call({ operation: 'cancel', task_id: 'task-1' })
    await call({ operation: 'reopen', task_id: 'task-1' })
  })

  it('dispatch creates monotonic delegation revisions and updates the task snapshot', async () => {
    const { call, state } = harness()
    await call({ operation: 'create', subject: 'Analyze raw data', role: 'DATA_ANALYSIS' })
    await call({ operation: 'dispatch', task_id: 'task-1' })
    await call({ operation: 'block', task_id: 'task-1', reason: 'waiting on user' })
    await call({ operation: 'reopen', task_id: 'task-1' })
    await call({ operation: 'dispatch', task_id: 'task-1', steps: [{ description: 'fit model', done: true }] })
    const current = state.currentDelegation('task-1')
    expect(current?.delegationRevision).toBe(2)
    expect(current?.phase).toBe('dispatched')
    // Revision 1 stays as its own durable slot (stale-evidence home).
    expect(state.delegationAt('task-1', 1)?.phase).toBe('dispatched')
    expect(state.getTask('task-1')?.steps).toEqual([{ description: 'fit model', done: true }])
    expect(state.getTask('task-1')?.latestDelegationRevision).toBe(2)
  })

  it('validates dependencies and rejects non-specialist roles', async () => {
    const { call } = harness()
    await call({ operation: 'create', subject: 'Upstream', role: 'THEORY' })
    await expect(
      call({ operation: 'create', subject: 'Dependent', role: 'PLOTTING', dependencies: ['task-nope'] }),
    ).rejects.toThrow(/unknown dependency/)
    // MAIN is rejected at the parameter-schema enum boundary (never reaches execute).
    await expect(call({ operation: 'create', subject: 'Bad', role: 'MAIN' as never })).rejects.toThrow(/role/) 
  })
})
