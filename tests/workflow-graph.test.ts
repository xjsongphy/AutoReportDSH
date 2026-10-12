import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { admitFirstTurn, assemble, disposeAssembled, execute, publish, waitUntil, type Assembled } from './helpers/assembled-host.js'
import { graphView, resultVersion } from '../src/workflow/graph.js'

let host: Assembled
beforeEach(async () => { host = await assemble(); admitFirstTurn(host) })
afterEach(async () => { await disposeAssembled(host) })
const task = (id: string, role = 'THEORY', dependencies: string[] = []) => ({ task_id: id, role, subject: `Work ${id}`, prompt: `Complete ${id}`, dependencies })
const call = (args: Record<string, unknown>) => execute(host.ctx, 'workflow_task', args, host.mainAgent, host.mainSession)
const state = () => host.runtime.forSession(host.mainSession).state
async function plan(tasks: ReturnType<typeof task>[]) {
  const result = await call({ action: 'plan', tasks })
  expect(result.isError, result.text).toBe(false)
  return result
}
function report(id: string, status: 'success' | 'blocked' = 'success', revision?: number) {
  const attempt = state().currentDelegation(id)!
  publish(host.ctx, host.mainSession, 'user/message', createUserMessage({
    source: { kind: 'subagent-report', form: 'relay', senderSessionId: attempt.childSessionId },
    content: [{ type: 'text', text: JSON.stringify({ task_id: id, delegation_revision: revision ?? attempt.delegationRevision, status,
      block_type: status === 'blocked' ? 'quality' : null, response: `Result ${id}: {N, 1}`, produced_files: [] }) }],
  }), { surfaceOp: 'append' })
}

describe('workflow dependency graph', () => {
  it('plans forward references without dispatch and returns prerequisite-first order', async () => {
    await plan([task('task-plot', 'PLOTTING', ['task-data']), task('task-data', 'DATA_ANALYSIS', ['task-theory']), task('task-theory')])
    expect(host.startedSpecs).toHaveLength(0)
    const graph = graphView(state())
    expect(graph.topological_order).toEqual(['task-theory', 'task-data', 'task-plot'])
    expect(graph.ready_task_ids).toEqual(['task-theory'])
    expect(graph.tasks.find(t => t.task_id === 'task-plot')?.blockers[0]?.blocking_chain).toEqual(['task-plot', 'task-data', 'task-theory'])
  })

  it.each([
    { tasks: [task('task-a', 'THEORY', ['task-missing'])], text: 'task-missing', code: 'WORKFLOW_UNKNOWN_DEPENDENCY' },
    { tasks: [task('task-a', 'THEORY', ['task-a'])], text: 'depends on itself', code: 'WORKFLOW_DEPENDENCY_CYCLE' },
    { tasks: [task('task-a', 'THEORY', ['task-b']), task('task-b', 'DATA_ANALYSIS', ['task-a'])], text: 'task-a -> task-b -> task-a', code: 'WORKFLOW_DEPENDENCY_CYCLE' },
    { tasks: [task('task-a'), task('task-a')], text: 'tasks[1].task_id', code: 'WORKFLOW_DUPLICATE_TASK' },
    { tasks: [{ ...task('task-a'), dependencies: ['task-x', 'task-x'] }], text: 'dependencies[1]', code: 'WORKFLOW_INVALID_ARGUMENT' },
    { tasks: [{ ...task('task-a'), prompt: '' }], text: 'tasks[0].prompt', code: 'WORKFLOW_INVALID_ARGUMENT' },
  ])('rejects invalid plans atomically with specific feedback: $code/$text', async ({ tasks, text, code }) => {
    const result = await call({ action: 'plan', tasks })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(text)
    expect(result.text).toContain(code)
    expect(state().projection().tasks.size).toBe(0)
    expect(host.startedSpecs).toHaveLength(0)
  })

  it('rejects dependency edits introducing a cycle and preserves the old graph', async () => {
    await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
    const result = await call({ action: 'update', task_id: 'task-a', dependencies: ['task-b'] })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('task-a -> task-b -> task-a')
    expect(state().getTask('task-a')?.dependencies).toEqual([])
    expect(state().getTask('task-a')?.revision).toBe(1)
  })

  it('dispatch failure explains the particular unmet dependency, status and path', async () => {
    await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
    const result = await execute(host.ctx, 'send_to_agent', { role: 'DATA_ANALYSIS', task_id: 'task-b', wait: false }, host.mainAgent, host.mainSession)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('dependency task-a is pending')
    expect(result.text).toContain('task-b -> task-a')
    expect(result.text).toContain('WORKFLOW_DEPENDENCY_NOT_READY')
    expect(state().currentDelegation('task-b')).toBeUndefined()
  })

  it('runs dependencies automatically and serializes independent tasks sharing a role', async () => {
    await plan([task('task-a'), task('task-other'), task('task-b', 'DATA_ANALYSIS', ['task-a']), task('task-c', 'PLOTTING', ['task-b'])])
    const started = await call({ action: 'run', task_ids: ['task-c', 'task-other'] })
    expect(started.isError, started.text).toBe(false)
    expect(host.startedSpecs).toHaveLength(1)
    expect(state().getTask('task-a')?.status).toBe('running')
    expect(state().getTask('task-other')?.status).toBe('pending')
    report('task-a')
    await waitUntil(() => state().getTask('task-b')?.status === 'running' && state().getTask('task-other')?.status === 'running')
    expect(state().currentDelegation('task-b')?.dependencyVersions).toEqual({ 'task-a': 1 })
    report('task-b')
    await waitUntil(() => state().getTask('task-c')?.status === 'running')
    report('task-other')
    report('task-c')
    await waitUntil(() => state().projection().meta?.scheduler?.enabled === false)
    expect([...state().projection().tasks.values()].every(t => t.status === 'completed')).toBe(true)
    expect(host.startedSpecs).toHaveLength(3) // one retained THEORY child, DATA_ANALYSIS and PLOTTING
  })

  it('wait any/all observes reports without extra dispatches and exposes dependency blockage', async () => {
    await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS'), task('task-c', 'PLOTTING', ['task-a'])])
    await call({ action: 'run' })
    const any = call({ action: 'wait', task_ids: ['task-a', 'task-b'], mode: 'any', timeout_ms: 5000 })
    const all = call({ action: 'wait', task_ids: ['task-a', 'task-b'], mode: 'all', timeout_ms: 5000 })
    report('task-a', 'blocked')
    expect((await any).value).toMatchObject({ status: 'settled', mode: 'any' })
    const blocked = await call({ action: 'wait', task_ids: ['task-c'], timeout_ms: 5000 })
    expect(blocked.value).toMatchObject({ status: 'settled', results: [ { task_id: 'task-c', blockers: [ { task_id: 'task-a', status: 'blocked' } ] } ] })
    report('task-b')
    expect((await all).value).toMatchObject({ status: 'settled', mode: 'all' })
    expect(state().currentDelegation('task-a')?.delegationRevision).toBe(1)
    expect(state().currentDelegation('task-c')).toBeUndefined()
  })

  it('wait timeout/abort does not mutate tasks or disable scheduling', async () => {
    await plan([task('task-a')])
    await call({ action: 'run' })
    const before = state().getTask('task-a')
    const expired = await call({ action: 'wait', task_ids: ['task-a'], timeout_ms: 10 })
    expect(expired.value).toMatchObject({ status: 'timeout' })
    const abort = new AbortController()
    const wait = host.runtime.coordinator.wait(host.mainSession, ['task-a'], 'all', 5000, abort.signal)
    abort.abort()
    expect(await wait).toMatchObject({ status: 'cancelled', wait_cancelled: true })
    expect(state().getTask('task-a')).toBe(before)
    expect(state().projection().meta?.scheduler?.enabled).toBe(true)
  })

  it('pause prevents future admission, while run resumes pending nodes', async () => {
    await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
    await call({ action: 'run' })
    await call({ action: 'pause' })
    report('task-a')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(state().getTask('task-b')?.status).toBe('pending')
    await call({ action: 'run' })
    expect(state().getTask('task-b')?.status).toBe('running')
  })

  it('reopening an upstream result invalidates descendants and rejects obsolete late reports', async () => {
    await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a']), task('task-c', 'PLOTTING', ['task-b'])])
    await call({ action: 'run' })
    report('task-a')
    await waitUntil(() => state().getTask('task-b')?.status === 'running')
    report('task-b')
    await waitUntil(() => state().getTask('task-c')?.status === 'running')
    const oldAttempt = state().currentDelegation('task-c')!
    await call({ action: 'pause' })
    const changed = await call({ action: 'reopen', task_id: 'task-a' })
    expect(changed.isError, changed.text).toBe(false)
    expect(state().getTask('task-b')).toMatchObject({ status: 'pending', resultVersion: 1 })
    expect(state().getTask('task-c')?.staleReason).toContain('task-a -> task-b -> task-c')
    expect(state().currentDelegation('task-c')?.phase).toBe('stale')
    report('task-c', 'success', oldAttempt.delegationRevision)
    expect(state().getTask('task-c')?.status).toBe('pending')
    await call({ action: 'run' })
    report('task-a')
    await waitUntil(() => state().getTask('task-b')?.status === 'running')
    expect(resultVersion(state().getTask('task-a')!)).toBe(2)
    expect(state().currentDelegation('task-b')?.dependencyVersions).toEqual({ 'task-a': 2 })
    report('task-b')
    await waitUntil(() => state().getTask('task-c')?.status === 'running')
    expect(state().currentDelegation('task-c')?.delegationRevision).toBe(2)
  })

  it('reports wrong-action fields and optimistic revision conflicts without writes', async () => {
    await plan([task('task-a')])
    const wrong = await call({ action: 'read', task_id: 'task-a', dependencies: ['task-a'] })
    expect(wrong.text).toContain('read does not accept dependencies')
    const stale = await call({ action: 'update', task_id: 'task-a', expected_revision: 99, prompt: 'new' })
    expect(stale.text).toContain('expected revision 99, actual revision 1')
    expect(state().getTask('task-a')?.prompt).toBe('Complete task-a')
  })
})

it('graph inspection lists live waits and releases them after completion, timeout, abort and reset', async () => {
  await plan([task('task-a')])
  await call({ action: 'run' })
  const waiting = host.runtime.coordinator.wait(host.mainSession, ['task-a'], 'all', 5000, new AbortController().signal)
  expect(host.runtime.coordinator.inspect(host.mainSession).waits.graph).toMatchObject([{ task_ids: ['task-a'], mode: 'all' }])
  report('task-a')
  expect(await waiting).toMatchObject({ status: 'settled', settled_task_ids: ['task-a'], pending_task_ids: [] })
  expect(host.runtime.coordinator.inspect(host.mainSession).waits.graph).toHaveLength(0)
  await call({ action: 'reopen', task_id: 'task-a' })
  const timeout = host.runtime.coordinator.wait(host.mainSession, ['task-a'], 'all', 10, new AbortController().signal)
  expect(await timeout).toMatchObject({ status: 'timeout', pending_task_ids: ['task-a'] })
  expect(host.runtime.coordinator.inspect(host.mainSession).waits.graph).toHaveLength(0)
  const abort = new AbortController()
  const cancelled = host.runtime.coordinator.wait(host.mainSession, ['task-a'], 'all', 5000, abort.signal)
  abort.abort()
  expect(await cancelled).toMatchObject({ status: 'cancelled' })
  expect(host.runtime.coordinator.inspect(host.mainSession).waits.graph).toHaveLength(0)
  const reset = host.runtime.coordinator.wait(host.mainSession, ['task-a'], 'all', 5000, new AbortController().signal)
  await host.runtime.resetWorkflow(host.mainSession)
  expect(await reset).toMatchObject({ status: 'cancelled' })
  expect(host.runtime.coordinator.inspect(host.mainSession).waits.graph).toHaveLength(0)
})

it('startup failure is exposed on the failed task and its dependent blocking chain', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
  host.ctx.subagents.startContinuable = async () => { throw new Error('provider unavailable for task-a') }
  const started = await call({ action: 'run', task_ids: ['task-b'] })
  expect(started.isError, started.text).toBe(false)
  expect(state().getTask('task-a')?.failedReason).toContain('provider unavailable for task-a')
  const downstream = graphView(state()).tasks.find(t => t.task_id === 'task-b')!
  expect(downstream.readiness).toBe('dependency_blocked')
  expect(downstream.blockers[0]).toMatchObject({ root_task_id: 'task-a', root_status: 'failed', blocking_chain: ['task-b', 'task-a'] })
  const wait = await call({ action: 'wait', task_ids: ['task-b'], timeout_ms: 5000 })
  expect(wait.value).toMatchObject({ status: 'settled', settled_task_ids: ['task-b'] })
})

it('checklist edits do not obsolete accepted dependency results', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
  await call({ action: 'run' })
  report('task-a')
  await waitUntil(() => state().getTask('task-b')?.status === 'running')
  const updated = await call({ action: 'update', task_id: 'task-a', steps: [{ description: 'review recorded', done: true }] })
  expect(updated.isError).toBe(false)
  expect(state().getTask('task-a')?.resultVersion).toBe(1)
  expect(state().currentDelegation('task-b')?.phase).toBe('waiting_for_child')
  report('task-b')
  expect(state().getTask('task-b')?.status).toBe('completed')
})

it('workflow snapshots recover saved prompts, dependencies and accepted result versions', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
  await call({ action: 'run' })
  report('task-a')
  await waitUntil(() => state().getTask('task-b')?.status === 'running')
  report('task-b')
  await waitUntil(() => state().projection().meta?.scheduler?.enabled === false)
  const { WorkflowState } = await import('../src/workflow/service.js')
  const { workflowRecords } = await import('./helpers/workflow-log.js')
  const recovered = WorkflowState.fromRecords(workflowRecords(host.mainSession, host.home))
  expect(recovered.getTask('task-b')).toMatchObject({ prompt: 'Complete task-b', dependencies: ['task-a'], status: 'completed', resultVersion: 1 })
  expect(recovered.currentDelegation('task-b')?.dependencyVersions).toEqual({ 'task-a': 1 })
  expect(graphView(recovered).topological_order).toEqual(['task-a', 'task-b'])
})

it.each([
  { args: { action: 'wait', task_ids: [] }, text: 'task_ids' },
  { args: { action: 'wait', task_ids: ['task-a', 'task-a'] }, text: 'task_ids[1]' },
  { args: { action: 'wait', task_ids: ['task-missing'] }, text: 'task-missing' },
  { args: { action: 'run', task_ids: ['task-missing'] }, text: 'task-missing' },
  { args: { action: 'wait', task_ids: ['task-a'], timeout_ms: -1 }, text: 'between 1 and 900000 milliseconds' },
  { args: { action: 'update', task_id: 'task-a', steps: [{ description: '' }] }, text: 'steps[0].description' },
  { args: { action: 'update', task_id: 'task-a', dependencies: ['task-missing'] }, text: 'task-missing' },
])('conditional argument error identifies the specific field or ID: $text', async ({ args, text }) => {
  await plan([task('task-a')])
  const before = state().getTask('task-a')
  const result = await call(args)
  expect(result.isError).toBe(true)
  expect(result.text).toContain(text)
  expect(state().getTask('task-a')).toBe(before)
  expect(host.startedSpecs).toHaveLength(0)
})

it('detects obsolete completed results from recovered version pins before dispatch or waiting', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a']), task('task-c', 'PLOTTING', ['task-b'])])
  await call({ action: 'run', task_ids: ['task-b'] })
  report('task-a')
  await waitUntil(() => state().getTask('task-b')?.status === 'running')
  report('task-b')
  await waitUntil(() => state().projection().meta?.scheduler?.enabled === false)
  // Simulate restored snapshots where the upstream result was replaced before
  // the process recorded descendant invalidation.
  const previous = state().getTask('task-a')!
  state().apply({ type: 'autoreport/task', seq: 999, time: Date.now(), data: { ...previous, resultVersion: 2, revision: previous.revision + 1 } })
  const graph = graphView(state())
  expect(graph.tasks.find(t => t.task_id === 'task-b')).toMatchObject({ status: 'completed', readiness: 'stale' })
  const downstream = graph.tasks.find(t => t.task_id === 'task-c')!
  expect(downstream.readiness).toBe('dependency_blocked')
  expect(downstream.blockers[0]).toMatchObject({ task_id: 'task-b', expected_version: 1, actual_version: 2 })
  const refused = await execute(host.ctx, 'send_to_agent', { role: 'PLOTTING', task_id: 'task-c', wait: false }, host.mainAgent, host.mainSession)
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('consumed dependency task-a result version 1')
  expect(refused.text).toContain('current result version is 2')
  const waited = await call({ action: 'wait', task_ids: ['task-b', 'task-c'], mode: 'all', timeout_ms: 1000 })
  expect(waited.value).toMatchObject({ status: 'settled', settled_task_ids: ['task-b', 'task-c'], results: [{ readiness: 'stale' }, { readiness: 'dependency_blocked' }] })
  await call({ action: 'run', task_ids: ['task-c'] })
  expect(state().getTask('task-b')?.status).toBe('running')
  expect(state().currentDelegation('task-b')?.dependencyVersions).toEqual({ 'task-a': 2 })
  expect(state().currentDelegation('task-b')?.delegationRevision).toBe(2)
})

it('completion after a restored pending revision invalidates old dependent results', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
  await call({ action: 'run' })
  report('task-a')
  await waitUntil(() => state().getTask('task-b')?.status === 'running')
  report('task-b')
  await waitUntil(() => state().projection().meta?.scheduler?.enabled === false)
  const prior = state().getTask('task-a')!
  state().apply({ type: 'autoreport/task', seq: 999, time: Date.now(), data: { ...prior, status: 'pending' } })
  host.runtime.commit(host.mainSession, 'autoreport/task', { ...prior, resultVersion: 2, revision: prior.revision + 1 })
  expect(state().getTask('task-b')).toMatchObject({ status: 'pending', resultVersion: 1 })
  expect(state().getTask('task-b')?.staleReason).toContain('task-a -> task-b')
})

it('first accepted results do not invalidate or mutate never-executed planned tasks', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
  await call({ action: 'run', task_ids: ['task-a'] })
  const planned = state().getTask('task-b')!
  report('task-a')
  await waitUntil(() => state().projection().meta?.scheduler?.enabled === false)
  expect(state().getTask('task-b')).toBe(planned)
  expect(state().getTask('task-b')?.staleReason).toBeUndefined()
})

it('numeric task IDs reserve automatic allocation and unsafe numeric IDs are rejected', async () => {
  const planned = await call({ action: 'plan', tasks: [task('task-100'), { role: 'DATA_ANALYSIS', subject: 'Auto', prompt: 'Automatic ID' }] })
  expect(planned.isError, planned.text).toBe(false)
  expect(state().getTask('task-101')).toBeDefined()
  const bad = await call({ action: 'plan', tasks: [task('task-999999999999999999999999')] })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('tasks[0].task_id')
  expect(bad.text).toContain('positive safe integer or a named ID')
  expect(state().projection().tasks.size).toBe(2)
})

it('an edited pending dependency expands the active scheduler scope instead of silently stalling', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS')])
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const ensure = host.runtime.ensureResidentRole.bind(host.runtime)
  host.runtime.ensureResidentRole = async (...args) => { entered.resolve(); await gate.promise; return ensure(...args) }
  const running = call({ action: 'run', task_ids: ['task-a'] })
  try {
    await entered.promise
    const changed = await call({ action: 'update', task_id: 'task-a', dependencies: ['task-b'] })
    expect(changed.isError, changed.text).toBe(false)
    gate.resolve()
    const result = await running
    expect(result.isError, result.text).toBe(false)
    expect(state().getTask('task-b')?.status).toBe('running')
    expect(state().getTask('task-a')?.status).toBe('pending')
    expect(state().currentDelegation('task-a')).toBeUndefined()
    expect(state().projection().meta?.scheduler?.taskIds).toContain('task-b')
    report('task-b')
    await waitUntil(() => state().getTask('task-a')?.status === 'running')
    expect(state().currentDelegation('task-a')?.dependencyVersions).toEqual({ 'task-b': 1 })
  } finally {
    gate.resolve()
    host.runtime.ensureResidentRole = ensure
  }
})

it('reopen pauses admission so the agent can edit instructions before a rerun starts', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a']), task('task-c', 'PLOTTING', ['task-b'])])
  await call({ action: 'run' })
  report('task-a')
  await waitUntil(() => state().getTask('task-b')?.status === 'running')
  const reopened = await call({ action: 'reopen', task_id: 'task-a' })
  expect(reopened.value).toMatchObject({ scheduler_paused: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(state().getTask('task-a')?.status).toBe('pending')
  expect(state().projection().meta?.scheduler?.enabled).toBe(false)
  expect(state().currentDelegation('task-a')?.delegationRevision).toBe(1)
  const updated = await call({ action: 'update', task_id: 'task-a', prompt: 'Revised instructions' })
  expect(updated.isError, updated.text).toBe(false)
  await call({ action: 'run' })
  expect(state().getTask('task-a')?.status).toBe('running')
  expect(state().currentDelegation('task-a')?.delegationRevision).toBe(2)
})

it('reset drains pending admission, rejects new operations and does not reload the old graph', async () => {
  await plan([task('task-a')])
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const ensure = host.runtime.ensureResidentRole.bind(host.runtime)
  host.runtime.ensureResidentRole = async (...args) => { entered.resolve(); await gate.promise; return ensure(...args) }
  const running = call({ action: 'run' })
  try {
    await entered.promise
    const resetting = host.runtime.resetWorkflow(host.mainSession)
    const planDuring = await call({ action: 'plan', tasks: [task('task-extra')] })
    expect(planDuring.isError).toBe(true)
    expect(planDuring.text).toContain('WORKFLOW_RESETTING')
    expect(planDuring.text).toContain('Wait for /reset to complete')
    const dispatchDuring = await execute(host.ctx, 'send_to_agent', { role: 'THEORY', task_id: 'task-a', wait: false }, host.mainAgent, host.mainSession)
    expect(dispatchDuring.isError).toBe(true)
    expect(dispatchDuring.text).toContain('WORKFLOW_RESETTING')
    gate.resolve()
    await Promise.all([running, resetting])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(state().projection().tasks.size).toBe(0)
    expect(state().projection().delegations.size).toBe(0)
    expect(host.startedSpecs).toHaveLength(0)
    expect((await call({ action: 'plan', tasks: [task('task-new')] })).isError).toBe(false)
  } finally {
    gate.resolve()
    host.runtime.ensureResidentRole = ensure
  }
})

it('dependency failures retain a machine-routable code and model-visible actual/required state', async () => {
  await plan([task('task-a'), task('task-b', 'DATA_ANALYSIS', ['task-a'])])
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const result = await host.ctx.tools.execute({ callId: ToolCallId('dependency-feedback'), name: 'send_to_agent',
    arguments: { role: 'DATA_ANALYSIS', task_id: 'task-b', wait: false }, agent: host.mainAgent, signal: new AbortController().signal })
  expect(result.isError).toBe(true)
  expect(result.error?.info?.code).toBe('WORKFLOW_DEPENDENCY_NOT_READY')
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(text).toContain('dependency task-a is pending')
  expect(text).toContain('required_status')
  expect(text).toContain('task-b -> task-a')
  expect(state().currentDelegation('task-b')).toBeUndefined()
})
