/** Task dependency validation, result-version checks and execution readiness. */
import type { SpecialistRole } from '../roles.js'
import type { DelegationSnapshot, TaskSnapshot } from './events.js'
import type { WorkflowState } from './service.js'
import { isOpenDelegation } from './protocol.js'
import { WorkflowError } from './errors.js'

/** Fetch a known task with a concrete recovery instruction. */
export function requireTask(state: WorkflowState, id: string, field = 'task_id'): TaskSnapshot {
  const task = state.getTask(id)
  if (task === undefined) throw new WorkflowError('WORKFLOW_UNKNOWN_TASK', `${field}=${id} does not name an existing task. Read workflow_task(action="graph") to find IDs, or plan this task before referencing it.`,
    { field, task_id: id, known_task_ids: [...state.projection().tasks.keys()] })
  return task
}

/** Current accepted result version, including pre-versioned completed records. */
export function resultVersion(task: TaskSnapshot): number {
  return task.resultVersion ?? (task.status === 'completed' ? task.latestDelegationRevision ?? 1 : 0)
}

/** Validate all references and produce a deterministic prerequisite-first ordering. */
export function validateTaskGraph(tasks: ReadonlyMap<string, TaskSnapshot>): string[] {
  for (const task of tasks.values()) for (const [index, dependency] of task.dependencies.entries()) {
    if (!tasks.has(dependency)) throw new WorkflowError('WORKFLOW_UNKNOWN_DEPENDENCY', `Task ${task.taskId} has unknown dependency ${dependency} at dependencies[${index}]. Add that task to this plan or use an existing task ID.`,
      { task_id: task.taskId, field: `dependencies[${index}]`, dependency_id: dependency })
    if (dependency === task.taskId) throw new WorkflowError('WORKFLOW_DEPENDENCY_CYCLE', `Task ${task.taskId} depends on itself. Remove ${dependency} from its dependencies.`,
      { task_id: task.taskId, field: `dependencies[${index}]`, cycle: [task.taskId, task.taskId] })
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const order: string[] = []
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id]
      throw new WorkflowError('WORKFLOW_DEPENDENCY_CYCLE', `Dependency cycle: ${cycle.join(' -> ')}. Remove or change one dependency edge in this cycle; no plan changes were saved.`, { cycle })
    }
    visiting.add(id)
    for (const dependency of tasks.get(id)!.dependencies) visit(dependency, [...path, id])
    visiting.delete(id)
    visited.add(id)
    order.push(id)
  }
  for (const id of tasks.keys()) visit(id, [])
  return order
}

interface ResultIssue {
  reason: string
  path: string[]
  rootStatus: string
  expectedVersion?: number
  actualVersion?: number
}

/** Verify completed results recursively, including restored version pins. */
function resultIssue(state: WorkflowState, task: TaskSnapshot, seen = new Set<string>()): ResultIssue | undefined {
  if (seen.has(task.taskId)) return { reason: `Dependency cycle through ${task.taskId}; repair the graph before using its results.`, path: [task.taskId], rootStatus: 'cycle' }
  const visited = new Set(seen).add(task.taskId)
  if (['blocked', 'failed', 'cancelled'].includes(task.status)) {
    return { reason: `Task ${task.taskId} is ${task.status}: ${task.blockedReason ?? task.failedReason ?? 'it has no usable completed result'}.`, path: [task.taskId], rootStatus: task.status }
  }
  const latest = state.currentDelegation(task.taskId)
  if (task.status === 'completed' && isOpenDelegation(latest)) return {
    reason: `Task ${task.taskId} has unfinished execution revision ${latest.delegationRevision} (${latest.phase}); its previously completed result cannot be used until this execution is reconciled.`,
    path: [task.taskId], rootStatus: 'running',
  }
  const pins = latest?.dependencyVersions
  for (const id of task.dependencies) {
    const dependency = state.getTask(id)
    if (dependency === undefined) return { reason: `Dependency ${id} of task ${task.taskId} is missing.`, path: [task.taskId, id], rootStatus: 'missing' }
    const issue = resultIssue(state, dependency, visited)
    if (issue !== undefined) return { ...issue, path: [task.taskId, ...issue.path] }
    if (task.status === 'completed' && pins !== undefined && pins[id] !== resultVersion(dependency)) {
      const expected = pins[id]
      return { reason: `Task ${task.taskId} consumed dependency ${id} result version ${expected ?? '(not recorded)'}, but its current result version is ${resultVersion(dependency)}. Rebuild ${task.taskId} before using this result.`,
        path: [task.taskId, id], rootStatus: 'completed', ...(expected === undefined ? {} : { expectedVersion: expected }), actualVersion: resultVersion(dependency) }
    }
  }
  if (task.status !== 'completed') return { reason: `Task ${task.taskId} is ${task.status}; a completed result is required.`, path: [task.taskId], rootStatus: task.status }
  if (task.staleReason !== undefined) return { reason: task.staleReason, path: [task.taskId], rootStatus: 'stale' }
  return undefined
}

/** Direct unmet prerequisites, including obsolete completed results and blocking paths. */
export function dependencyBlockers(state: WorkflowState, task: TaskSnapshot) {
  return task.dependencies.flatMap(id => {
    const dependency = state.getTask(id)
    const issue = dependency === undefined ? { reason: `Dependency ${id} is missing.`, path: [id], rootStatus: 'missing' } : resultIssue(state, dependency)
    if (issue === undefined) return []
    return [{ task_id: id, status: dependency?.status === 'completed' ? 'stale' : dependency?.status ?? 'missing',
      result_version: dependency === undefined ? 0 : resultVersion(dependency), blocking_chain: [task.taskId, ...issue.path],
      root_task_id: issue.path.at(-1)!, root_status: issue.rootStatus, reason: issue.reason,
      ...('expectedVersion' in issue && issue.expectedVersion !== undefined ? { expected_version: issue.expectedVersion } : {}),
      ...('actualVersion' in issue && issue.actualVersion !== undefined ? { actual_version: issue.actualVersion } : {}),
    }]
  })
}

/** Enforce prerequisites at dispatch and explain each violated dependency. */
export function assertDependenciesReady(state: WorkflowState, task: TaskSnapshot): void {
  const blockers = dependencyBlockers(state, task)
  if (blockers.length > 0) throw new WorkflowError('WORKFLOW_DEPENDENCY_NOT_READY', `Task ${task.taskId} cannot start: ${blockers.map(b => `dependency ${b.task_id} is ${b.status} (result version ${b.result_version}; path ${b.blocking_chain.join(' -> ')}; root ${b.root_task_id} is ${b.root_status}; ${b.reason})`).join('; ')}. Each dependency must be completed with a current result. Run/repair the prerequisite tasks first, then dispatch this task.`,
    { task_id: task.taskId, dependencies: blockers, required_status: 'completed' })
}

/** One unresolved execution occupying a specialist role. */
export function occupiedRole(state: WorkflowState, role: SpecialistRole): DelegationSnapshot | undefined {
  for (const task of state.projection().tasks.values()) {
    if (task.role !== role) continue
    const attempt = state.currentDelegation(task.taskId)
    if (isOpenDelegation(attempt)) return attempt
  }
  return undefined
}

/** Assert one-role admission, preserving the occupying task and revision in feedback. */
export function assertRoleAvailable(state: WorkflowState, role: SpecialistRole): void {
  const attempt = occupiedRole(state, role)
  if (attempt !== undefined) throw new WorkflowError('WORKFLOW_ROLE_BUSY', `Role ${role} already has work waiting for task ${attempt.taskId}, revision ${attempt.delegationRevision} (${attempt.phase}). A waiting timeout does not end execution. Wait for this task's report, or cancel it before reopening and redispatching; no new task was created.`,
    { role, occupying_task_id: attempt.taskId, delegation_revision: attempt.delegationRevision, phase: attempt.phase })
}

/** Pin the completed results consumed by one new attempt. */
export function dependencyVersions(state: WorkflowState, task: TaskSnapshot): Record<string, number> {
  assertDependenciesReady(state, task)
  return Object.fromEntries(task.dependencies.map(id => [id, resultVersion(requireTask(state, id))]))
}

/** Explain obsolete inputs before accepting an attempt's report. */
export function staleDependencyReason(state: WorkflowState, attempt: DelegationSnapshot): string | undefined {
  for (const [id, expected] of Object.entries(attempt.dependencyVersions ?? {})) {
    const dependency = state.getTask(id)
    const issue = dependency === undefined ? undefined : resultIssue(state, dependency)
    if (dependency === undefined || issue !== undefined || resultVersion(dependency) !== expected) {
      return `Task ${attempt.taskId} revision ${attempt.delegationRevision} consumed dependency ${id} result version ${expected}, but it is now ${dependency?.status ?? 'missing'} at result version ${dependency === undefined ? 0 : resultVersion(dependency)}.${issue === undefined ? '' : ` Blocking input: ${issue.reason} Path ${issue.path.join(' -> ')}.`} Rebuild this task after the dependency is completed; this report cannot complete the task.`
    }
  }
  return undefined
}

/** Model-facing task status including why it cannot execute. */
export function taskView(state: WorkflowState, task: TaskSnapshot) {
  const blockers = dependencyBlockers(state, task)
  const occupied = occupiedRole(state, task.role)
  const attempt = state.currentDelegation(task.taskId)
  const obsolete = task.status === 'completed' ? resultIssue(state, task)?.reason : attempt === undefined ? undefined : staleDependencyReason(state, attempt)
  const readiness = (task.status === 'completed' || task.status === 'running') && obsolete !== undefined ? 'stale' : task.status !== 'pending' ? task.status : blockers.some(blocker => blocker.status === 'stale' || ['blocked', 'failed', 'cancelled', 'missing', 'stale', 'cycle'].includes(blocker.root_status)) ? 'dependency_blocked' : blockers.length > 0 ? 'waiting_dependencies'
    : occupied !== undefined ? 'role_busy' : task.prompt === undefined ? 'missing_prompt' : 'ready'
  return {
    task_id: task.taskId, subject: task.subject, role: task.role, status: task.status, revision: task.revision,
    dependencies: [...task.dependencies], steps: task.steps.map(step => ({ description: step.description, done: step.done })), scopes: [...task.scopes],
    result_version: resultVersion(task), readiness, blockers,
    ...(task.prompt === undefined ? {} : { prompt: task.prompt }),
    ...(task.context === undefined ? {} : { context: task.context }),
    ...(task.blockedReason === undefined ? {} : { blocked_reason: task.blockedReason }),
    ...(task.failedReason === undefined ? {} : { failed_reason: task.failedReason }),
    ...(task.staleReason === undefined && obsolete === undefined ? {} : { stale_reason: task.staleReason ?? obsolete! }),
    ...(task.latestDelegationRevision === undefined ? {} : { latest_delegation_revision: task.latestDelegationRevision }),
    ...(attempt === undefined ? {} : { execution: { delegation_revision: attempt.delegationRevision, phase: attempt.phase, child_session_id: String(attempt.childSessionId), dependency_versions: { ...attempt.dependencyVersions } } }),
    ...(occupied === undefined ? {} : { role_occupied_by: { task_id: occupied.taskId, delegation_revision: occupied.delegationRevision } }),
  }
}

/** Graph inspection separates ready nodes, resource occupancy and prerequisite waits. */
export function graphView(state: WorkflowState) {
  const order = validateTaskGraph(state.projection().tasks)
  const tasks = order.map(id => taskView(state, requireTask(state, id)))
  return { tasks, topological_order: order,
    edges: tasks.flatMap(task => task.dependencies.map(dependency => ({ prerequisite: dependency, dependent: task.task_id }))),
    ready_task_ids: tasks.filter(task => task.readiness === 'ready').map(task => task.task_id),
    waiting_task_ids: tasks.filter(task => task.readiness === 'waiting_dependencies' || task.readiness === 'role_busy').map(task => task.task_id),
    blocked_task_ids: tasks.filter(task => ['blocked', 'failed', 'cancelled', 'dependency_blocked', 'missing_prompt', 'stale'].includes(task.readiness)).map(task => task.task_id),
    scheduler: { enabled: state.projection().meta?.scheduler?.enabled ?? false, task_ids: [...(state.projection().meta?.scheduler?.taskIds ?? [])] },
  }
}
