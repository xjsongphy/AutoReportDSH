/** Dependency-aware graph scheduling, result invalidation and independent waits. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { createSendToAgentTool } from '../tools/send-to-agent.js'
import { AUTOREPORT_SCHEMA_VERSION, type TaskSnapshot } from './events.js'
import type { WorkflowRecord } from './store.js'
import { graphView, requireTask, resultVersion, taskView, validateTaskGraph } from './graph.js'
import { delegationKey, isOpenDelegation } from './protocol.js'
import { WorkflowError } from './errors.js'

interface Driver {
  abort: AbortController
  dirty: boolean
  done: Promise<void>
}

/** Owns scheduler activity separately from the MAIN Agent's turn and local waits. */
export class WorkflowCoordinator {
  private readonly drivers = new Map<string, Driver>()
  private readonly parents = new Map<string, Agent>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly pendingNotifications = new Set<string>()
  private readonly teardown = new AbortController()
  private readonly waits = new Map<string, { wait_id: string; parent_session_id: string; task_ids: string[]; mode: 'any' | 'all'; started_at: number; deadline: number }>()
  private readonly cancelWaits = new Map<string, () => void>()
  private readonly invalidating = new Set<string>()
  private readonly resetting = new Set<string>()

  constructor(private readonly ctx: Context, private readonly runtime: AutoReportWorkflowRuntime) {}

  /** Observe committed snapshots; input invalidation is durable before waits/pumps run. */
  afterCommit(session: Session, record: WorkflowRecord, previousTask?: TaskSnapshot): void {
    if (record.type !== 'autoreport/task' && record.type !== 'autoreport/delegation' && record.type !== 'autoreport/workflow') return
    if (record.type === 'autoreport/task' && previousTask !== undefined && !this.invalidating.has(String(session.id))) {
      const changed = previousTask.status === 'completed' && record.data.status !== 'completed'
        || record.data.status === 'completed' && resultVersion(previousTask) > 0 && resultVersion(previousTask) !== resultVersion(record.data)
      if (changed) this.invalidateDependents(session, record.data.taskId)
    }
    const key = String(session.id)
    if (this.pendingNotifications.has(key)) return
    this.pendingNotifications.add(key)
    queueMicrotask(() => {
      this.pendingNotifications.delete(key)
      if (this.teardown.signal.aborted || this.resetting.has(key)) return
      for (const listener of [...(this.listeners.get(key) ?? [])]) listener()
      this.requestPump(session)
    })
  }

  /** Mark descendants obsolete, stop obsolete running attempts, and preserve old reports. */
  private invalidateDependents(session: Session, upstream: string): void {
    const live = this.runtime.forSession(session)
    const paths = new Map<string, string[]>([[upstream, [upstream]]])
    const queue = [upstream]
    for (const id of queue) for (const task of live.state.projection().tasks.values()) {
      if (paths.has(task.taskId) || !task.dependencies.includes(id)) continue
      paths.set(task.taskId, [...paths.get(id)!, task.taskId])
      queue.push(task.taskId)
    }
    this.invalidating.add(String(session.id))
    try {
      for (const [id, path] of paths) {
        if (id === upstream) continue
        const task = live.state.getTask(id)!
        if (task.latestDelegationRevision === undefined && resultVersion(task) === 0) continue
        const reason = `Upstream task ${upstream} changed; dependency path ${path.join(' -> ')}. Result of ${id} is obsolete and must be rebuilt after its dependencies complete.`
        const attempt = live.state.currentDelegation(id)
        if (isOpenDelegation(attempt)) {
          this.runtime.commit(session, 'autoreport/delegation', { ...attempt, phase: 'stale', reason, settledAt: Date.now() })
          live.waiters.settle(delegationKey(id, attempt.delegationRevision), { status: 'failed', response: reason })
        }
        this.runtime.commit(session, 'autoreport/task', {
          ...task, version: AUTOREPORT_SCHEMA_VERSION, staleReason: reason,
          status: task.status === 'running' || task.status === 'completed' ? 'pending' : task.status,
          revision: task.revision + 1,
        })
        if (isOpenDelegation(attempt)) this.runtime.stopTaskExecution(attempt)
      }
    } finally {
      this.invalidating.delete(String(session.id))
    }
  }

  /** Start/resume the requested tasks and their prerequisites; planning alone never starts work. */
  async run(parent: Agent, requested?: readonly string[]) {
    this.assertAvailable(parent.session)
    const live = this.runtime.forSession(parent.session)
    validateTaskGraph(live.state.projection().tasks)
    const initial = requested ?? [...live.state.projection().tasks.keys()]
    if (initial.length === 0) throw new WorkflowError('WORKFLOW_EMPTY_PLAN', 'No tasks are planned. Use workflow_task(action="plan", tasks=[...]) before run.', { action: 'run' })
    const selected = new Set<string>()
    const include = (id: string): void => {
      if (selected.has(id)) return
      const task = requireTask(live.state, id, 'task_ids')
      selected.add(id)
      for (const dependency of task.dependencies) include(dependency)
    }
    for (const id of initial) include(id)
    for (const id of live.state.projection().meta?.scheduler?.enabled === true ? live.state.projection().meta!.scheduler!.taskIds : []) selected.add(id)
    const missing = [...selected].filter(id => {
      const task = requireTask(live.state, id)
      return (task.status === 'pending' || taskView(live.state, task).readiness === 'stale') && task.prompt === undefined
    })
    if (missing.length > 0) throw new WorkflowError('WORKFLOW_MISSING_PROMPT', `Tasks ${missing.join(', ')} have no saved prompt (legacy records). Reopen completed tasks if rebuilding them, then set each prompt with workflow_task(action="update", task_id=..., prompt=...) before run.`, { task_ids: missing, field: 'prompt' })
    const meta = live.state.projection().meta
    if (meta === undefined) throw new WorkflowError('WORKFLOW_NOT_INITIALIZED', 'Initialize the AutoReport workflow before enabling scheduling.', { action: 'run' })
    // Reconcile persisted completed/running rows whose consumed inputs became
    // obsolete before descendant invalidation was recorded (e.g. a restart).
    for (const id of validateTaskGraph(live.state.projection().tasks)) {
      if (!selected.has(id)) continue
      const task = requireTask(live.state, id)
      const view = taskView(live.state, task)
      if (view.readiness !== 'stale') continue
      const attempt = live.state.currentDelegation(id)
      const reason = view.stale_reason ?? `Task ${id} has obsolete dependency results.`
      if (isOpenDelegation(attempt)) {
        this.runtime.commit(parent.session, 'autoreport/delegation', { ...attempt, phase: 'stale', reason, settledAt: Date.now() })
        live.waiters.settle(delegationKey(id, attempt.delegationRevision), { status: 'failed', response: reason })
      }
      this.runtime.commit(parent.session, 'autoreport/task', { ...task, version: AUTOREPORT_SCHEMA_VERSION, status: 'pending', resultVersion: resultVersion(task), staleReason: reason, revision: task.revision + 1 })
      if (isOpenDelegation(attempt)) this.runtime.stopTaskExecution(attempt)
    }
    this.parents.set(String(parent.id), parent)
    this.runtime.commit(parent.session, 'autoreport/workflow', { ...meta, version: AUTOREPORT_SCHEMA_VERSION, scheduler: { enabled: true, taskIds: [...selected] } })
    await this.requestPump(parent.session, parent)
    return { status: 'scheduled', selected_task_ids: [...(live.state.projection().meta?.scheduler?.taskIds ?? selected)],
      running_task_ids: [...selected].filter(id => isOpenDelegation(live.state.currentDelegation(id))), ...this.inspect(parent.session) }
  }

  /** Inspect dependency edges, active role instances and graph/attempt waits. */
  inspect(session: Session) {
    const live = this.runtime.forSession(session)
    const graph = graphView(live.state)
    const tasks = graph.topological_order.map(id => this.inspectTask(session, requireTask(live.state, id)))
    return { ...graph, tasks,
      ready_task_ids: tasks.filter(task => task.readiness === 'ready').map(task => task.task_id),
      waiting_task_ids: tasks.filter(task => task.readiness === 'waiting_dependencies' || task.readiness === 'role_busy').map(task => task.task_id),
      role_activities: [...live.state.projection().bindingsByRole.values()].map(binding => ({ role: binding.role, child_session_id: String(binding.childSessionId), activity: this.runtime.liveAgent(binding.childSessionId)?.status ?? 'inactive' })),
      waits: { graph: [...this.waits.values()].filter(wait => wait.parent_session_id === String(session.id)), delegation_keys: live.waiters.pendingDelegations() },
    }
  }

  /** Combine logical readiness with the retained Agent's actual driver activity. */
  inspectTask(session: Session, task: TaskSnapshot) {
    const state = this.runtime.forSession(session).state
    const view = taskView(state, task)
    const binding = state.bindingForRole(task.role)
    const activity = binding === undefined ? 'inactive' : this.runtime.liveAgent(binding.childSessionId)?.status ?? 'inactive'
    return { ...view, role_activity: activity,
      readiness: view.readiness === 'ready' && activity === 'running' ? 'role_busy' : view.readiness,
      ...(view.readiness === 'ready' && activity === 'running' ? { waiting_reason: `Role ${task.role} Agent ${binding!.childSessionId} is still running or draining; admission waits for idle.` } : {}),
    }
  }

  /** Pause future admission; current specialist executions are preserved. */
  pause(session: Session): void {
    this.drivers.get(String(session.id))?.abort.abort(new Error('workflow scheduling paused'))
    const meta = this.runtime.forSession(session).state.projection().meta
    if (meta?.scheduler?.enabled) this.runtime.commit(session, 'autoreport/workflow', { ...meta, scheduler: { ...meta.scheduler, enabled: false } })
  }

  /** Wake scheduling after a child's driver becomes idle or MAIN is restored. */
  requestPump(session: Session, suppliedParent?: Agent): Promise<void> {
    if (this.teardown.signal.aborted || this.resetting.has(String(session.id)) || !this.runtime.isMainSession(session.id)) return Promise.resolve()
    const meta = this.runtime.forSession(session).state.projection().meta
    if (meta?.scheduler?.enabled !== true) return Promise.resolve()
    const parent = suppliedParent ?? this.ctx.get('agents')?.get(session.id) ?? this.parents.get(String(session.id))
    if (parent === undefined) return Promise.resolve()
    const key = String(session.id)
    const existing = this.drivers.get(key)
    if (existing !== undefined) {
      if (existing.abort.signal.aborted) return existing.done.then(() => this.requestPump(session, parent))
      existing.dirty = true
      return existing.done
    }
    const driver: Driver = { abort: new AbortController(), dirty: true, done: Promise.resolve() }
    this.drivers.set(key, driver)
    driver.done = Promise.resolve().then(async () => {
      while (driver.dirty && !driver.abort.signal.aborted && !this.teardown.signal.aborted) {
        driver.dirty = false
        await this.pump(parent, driver.abort.signal)
      }
    }).finally(() => {
      if (this.drivers.get(key) === driver) this.drivers.delete(key)
    })
    // Event-triggered callers do not await this promise. Contain unexpected
    // scheduler faults and expose them through the owning graph scope.
    void driver.done.catch(error => {
      if (driver.abort.signal.aborted || this.teardown.signal.aborted) return
      const current = this.runtime.forSession(session).state.projection().meta
      if (current?.scheduler?.enabled) this.runtime.commit(session, 'autoreport/workflow', { ...current, scheduler: { ...current.scheduler, enabled: false } })
      this.ctx.logger.warn('AutoReport scheduler for %s failed: %s', key, String(error))
    })
    return driver.done
  }

  private async pump(parent: Agent, signal: AbortSignal): Promise<void> {
    const live = this.runtime.forSession(parent.session)
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) throw new WorkflowError('WORKFLOW_SERVICE_UNAVAILABLE', 'The subagents service is unavailable; restore it before running the graph.')
    const llm = this.ctx.get('llm')
    const tool = createSendToAgentTool({
      subagents, workflow: this.runtime, config: this.runtime.config,
      assertAvailable: session => this.assertAvailable(session),
      resident: {
        ensure: (agent, role, creationSignal) => this.runtime.ensureResidentRole(agent, role, creationSignal),
        deliver: (agent, id, content, source, deliverySignal) => this.runtime.deliverResidentChild(agent, id, content, source, deliverySignal),
      },
      deliverChild: (agent, id, content, source, deliverySignal) => this.runtime.deliverChild(agent, id, content, source, deliverySignal),
      ...(llm === undefined ? {} : { llm }),
    })
    const meta = live.state.projection().meta!
    if (signal.aborted || meta.scheduler?.enabled !== true) return
    const selected = new Set(meta.scheduler?.taskIds ?? [])
    const include = (id: string): void => {
      for (const dependency of requireTask(live.state, id).dependencies) {
        if (selected.has(dependency)) continue
        selected.add(dependency)
        include(dependency)
      }
    }
    for (const id of [...selected]) include(id)
    if (selected.size !== meta.scheduler?.taskIds.length) this.runtime.commit(parent.session, 'autoreport/workflow', {
      ...meta, scheduler: { enabled: true, taskIds: [...selected] },
    })
    for (const id of validateTaskGraph(live.state.projection().tasks)) {
      if (signal.aborted || live.state.projection().meta?.scheduler?.enabled !== true) return
      if (!selected.has(id)) continue
      const task = requireTask(live.state, id)
      if (taskView(live.state, task).readiness !== 'ready') continue
      const binding = live.state.bindingForRole(task.role)
      if (binding !== undefined && this.runtime.liveAgent(binding.childSessionId)?.status === 'running') continue
      try {
        await tool.execute({ role: task.role, task_id: id, expected_revision: task.revision, wait: false }, { agent: parent, signal } as never)
      } catch (error: unknown) {
        if (signal.aborted) return
        if (error instanceof WorkflowError && ['WORKFLOW_ROLE_BUSY', 'WORKFLOW_TASK_CHANGED', 'WORKFLOW_DEPENDENCY_NOT_READY'].includes(error.code)) continue
        const latest = requireTask(live.state, id)
        this.runtime.commit(parent.session, 'autoreport/task', { ...latest, status: 'failed', failedReason: error instanceof Error ? error.message : String(error), revision: latest.revision + 1 })
      }
    }
    const all = (live.state.projection().meta?.scheduler?.taskIds ?? []).map(id => requireTask(live.state, id))
    if (all.every(task => task.status === 'completed' || task.status === 'cancelled')) this.pause(parent.session)
  }

  /** Await graph results without creating messages, attempts or scheduler activity. */
  wait(session: Session, ids: readonly string[], mode: 'any' | 'all', timeoutMs: number, callerSignal: AbortSignal) {
    this.assertAvailable(session)
    const live = this.runtime.forSession(session)
    validateTaskGraph(live.state.projection().tasks)
    for (const id of ids) requireTask(live.state, id, 'task_ids')
    const signal = AbortSignal.any([callerSignal, this.teardown.signal])
    const waitId = randomUUID()
    return new Promise<ReturnType<WorkflowCoordinator['waitResult']>>(resolve => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const key = String(session.id)
      const settle = (status: 'settled' | 'timeout' | 'cancelled'): void => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waits.delete(waitId)
        this.cancelWaits.delete(waitId)
        this.listeners.get(key)?.delete(check)
        if (this.listeners.get(key)?.size === 0) this.listeners.delete(key)
        resolve(this.waitResult(session, ids, mode, status, waitId))
      }
      const check = (): void => {
        const terminal = ids.map(id => {
          const task = requireTask(live.state, id)
          return ['completed', 'blocked', 'failed', 'cancelled', 'stale', 'dependency_blocked'].includes(taskView(live.state, task).readiness)
        })
        if (mode === 'all' ? terminal.every(Boolean) : terminal.some(Boolean)) settle('settled')
      }
      const onAbort = (): void => settle('cancelled')
      if (signal.aborted) { settle('cancelled'); return }
      let listeners = this.listeners.get(key)
      if (listeners === undefined) { listeners = new Set(); this.listeners.set(key, listeners) }
      listeners.add(check)
      this.waits.set(waitId, { wait_id: waitId, parent_session_id: String(session.id), task_ids: [...ids], mode, started_at: Date.now(), deadline: Date.now() + timeoutMs })
      this.cancelWaits.set(waitId, onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => settle('timeout'), timeoutMs)
      check()
    })
  }

  private waitResult(session: Session, ids: readonly string[], mode: 'any' | 'all', status: 'settled' | 'timeout' | 'cancelled', waitId: string) {
    const state = this.runtime.forSession(session).state
    const results = ids.map(id => taskView(state, requireTask(state, id)))
    const settled = results.filter(task => ['completed', 'blocked', 'failed', 'cancelled', 'dependency_blocked', 'stale'].includes(task.readiness)).map(task => task.task_id)
    return { status, mode, wait_id: waitId, wait_cancelled: status === 'cancelled', settled_task_ids: settled,
      pending_task_ids: ids.filter(id => !settled.includes(id)), all_succeeded: results.every(task => task.readiness === 'completed'),
      reason: status === 'timeout' ? 'Only this wait expired; execution is preserved. Review pending_task_ids and use another wait, pause scheduling, or cancel specific tasks.'
        : status === 'cancelled' ? 'This wait was cancelled. Waiting cancellation alone does not cancel task execution; MAIN stop and graph reset perform their own cancellation.'
          : 'The requested targets settled; inspect results for completed, blocked, failed, cancelled or stale outcomes.', results }
  }

  /** Cancel listeners and unpublished admission, then await all scheduler workers. */
  async dispose(): Promise<void> {
    this.teardown.abort(new Error('workflow coordinator disposed'))
    for (const driver of this.drivers.values()) driver.abort.abort(this.teardown.signal.reason)
    await Promise.allSettled([...this.drivers.values()].map(driver => driver.done))
    this.listeners.clear()
    this.drivers.clear()
    this.parents.clear()
  }

  /** Resolve local waits before deleting the task graph they inspect. */
  async resetSession(session: Session): Promise<void> {
    this.assertAvailable(session)
    this.resetting.add(String(session.id))
    try {
      this.pause(session)
      for (const wait of [...this.waits.values()]) if (wait.parent_session_id === String(session.id)) this.cancelWaits.get(wait.wait_id)?.()
      this.parents.delete(String(session.id))
      const driver = this.drivers.get(String(session.id))
      if (driver !== undefined) await Promise.allSettled([driver.done])
    } catch (error: unknown) {
      this.resetting.delete(String(session.id))
      throw error
    }
  }

  /** Release the reset barrier only after the old log and cached graph are gone. */
  finishReset(session: Session): void {
    this.resetting.delete(String(session.id))
  }

  /** Reject graph requests during reset with an explicit retry condition. */
  assertAvailable(session: Session): void {
    if (this.resetting.has(String(session.id))) throw new WorkflowError('WORKFLOW_RESETTING', `Workflow for session ${session.id} is being reset. Wait for /reset to complete, then inspect the new graph before retrying; no task or revision was created.`, { session_id: String(session.id), recovery: 'wait for reset completion' })
  }

  /** Stop using a disposed MAIN identity without erasing the durable scheduling scope. */
  forgetParent(agent: Agent): void {
    if (this.parents.get(String(agent.id)) !== agent) return
    this.parents.delete(String(agent.id))
    this.drivers.get(String(agent.id))?.abort.abort(new Error('MAIN activation disposed'))
  }
}
