/** Validate and stage graph edits before committing any task mutations. */
import type { TaskSnapshot } from './events.js'
import { AUTOREPORT_SCHEMA_VERSION } from './events.js'
import type { WorkflowState } from './service.js'
import { validateTaskGraph } from './graph.js'
import { WorkflowError, workflowRole, workflowSteps, workflowTaskId, workflowTaskIds, workflowText } from './errors.js'

/** Check action-specific fields rather than silently ignoring misplaced arguments. */
export function assertWorkflowFields(args: Record<string, unknown>, action: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(args).filter(key => args[key] !== undefined && key !== 'action' && !allowed.includes(key))
  if (unexpected.length > 0) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `workflow_task action=${action} does not accept ${unexpected.join(', ')}. Allowed fields: ${allowed.join(', ') || '(none)'}. Choose the appropriate action or remove those fields.`,
    { action, fields: unexpected, allowed_fields: allowed })
}

/** Build a whole batch supporting forward references, without mutating state on failure. */
export function planTasks(state: WorkflowState, input: unknown): TaskSnapshot[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', 'tasks must be an array of 1–64 task definitions; each needs role, subject and prompt.', { field: 'tasks', expected: '1–64 task definitions' })
  const entries = input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `tasks[${index}] must be a task definition object.`, { field: `tasks[${index}]`, actual: entry })
    const record = entry as Record<string, unknown>
    const extra = Object.keys(record).filter(key => !['task_id', 'role', 'subject', 'prompt', 'context', 'dependencies', 'steps'].includes(key))
    if (extra.length > 0) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `tasks[${index}] has unsupported fields ${extra.join(', ')}. Use task_id, role, subject, prompt, context, dependencies and steps.`, { field: `tasks[${index}]`, unexpected_fields: extra })
    return record
  })
  const occupied = new Set(state.projection().tasks.keys())
  for (const [index, entry] of entries.entries()) if (entry.task_id !== undefined) {
    const id = workflowTaskId(entry.task_id, `tasks[${index}].task_id`)
    if (occupied.has(id)) throw new WorkflowError('WORKFLOW_DUPLICATE_TASK', `tasks[${index}].task_id=${id} already exists or duplicates an earlier task in this plan. Use a new ID; use update/reopen to modify an existing task.`, { field: `tasks[${index}].task_id`, task_id: id })
    occupied.add(id)
  }
  let next = entries.some(entry => entry.task_id === undefined) ? Number(state.nextTaskId().slice(5)) : 1
  for (const id of occupied) {
    const numeric = /^task-(\d+)$/u.exec(id)
    if (numeric !== null) next = Math.max(next, Number(numeric[1]) + 1)
  }
  const tasks = entries.map((entry, index): TaskSnapshot => {
    let id: string
    if (entry.task_id === undefined) {
      while (occupied.has(`task-${next}`)) next++
      if (!Number.isSafeInteger(next)) throw new WorkflowError('WORKFLOW_TASK_ID_EXHAUSTED', `Automatic numeric task IDs exceed ${Number.MAX_SAFE_INTEGER}. Supply an explicit named tasks[${index}].task_id, such as task-theory.`, { field: `tasks[${index}].task_id` })
      id = `task-${next++}`
      occupied.add(id)
    } else id = workflowTaskId(entry.task_id, `tasks[${index}].task_id`)
    const role = workflowRole(entry.role, `tasks[${index}].role`)
    const dependencies = workflowTaskIds(entry.dependencies, `tasks[${index}].dependencies`)
    return { version: AUTOREPORT_SCHEMA_VERSION, taskId: id, role,
      subject: workflowText(entry.subject, `tasks[${index}].subject`, 256),
      prompt: workflowText(entry.prompt, `tasks[${index}].prompt`, 16_384),
      ...(entry.context === undefined ? {} : { context: workflowText(entry.context, `tasks[${index}].context`, 8192) }),
      dependencies, steps: workflowSteps(entry.steps, `tasks[${index}].steps`), status: 'pending', revision: 1,
      scopes: [role === 'DATA_ANALYSIS' ? 'Data/Processed' : role === 'PLOTTING' ? 'Plots' : role === 'REPORT' ? 'Report' : 'Theory'],
    }
  })
  const candidate = new Map(state.projection().tasks)
  for (const task of tasks) candidate.set(task.taskId, task)
  validateTaskGraph(candidate)
  return tasks
}

/** Stage editable task metadata, validating dependencies before state changes. */
export function updatePlannedTask(state: WorkflowState, task: TaskSnapshot, args: Record<string, unknown>): TaskSnapshot {
  const instructionChange = ['prompt', 'context', 'dependencies', 'subject'].some(field => args[field] !== undefined)
  if (instructionChange && (task.status === 'running' || task.status === 'completed')) throw new WorkflowError('WORKFLOW_TASK_NOT_EDITABLE', `Task ${task.taskId} is ${task.status}; its execution instructions and dependencies cannot be edited. ${task.status === 'running' ? 'Cancel the task, reopen it, then update.' : 'Reopen the completed task first; dependent results will be invalidated.'}`, { task_id: task.taskId, status: task.status, fields: ['prompt', 'context', 'dependencies', 'subject'].filter(field => args[field] !== undefined) })
  if (!['steps', 'prompt', 'context', 'dependencies', 'subject'].some(field => args[field] !== undefined)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `update for ${task.taskId} needs at least one of steps, prompt, context, dependencies or subject.`, { task_id: task.taskId, field: 'update' })
  const updated: TaskSnapshot = { ...task, version: AUTOREPORT_SCHEMA_VERSION, revision: task.revision + 1,
    ...(args.steps === undefined ? {} : { steps: workflowSteps(args.steps) }),
    ...(args.prompt === undefined ? {} : { prompt: workflowText(args.prompt, 'prompt', 16_384) }),
    ...(args.context === undefined ? {} : { context: workflowText(args.context, 'context', 8192) }),
    ...(args.subject === undefined ? {} : { subject: workflowText(args.subject, 'subject', 256) }),
    ...(args.dependencies === undefined ? {} : { dependencies: workflowTaskIds(args.dependencies, 'dependencies') }),
  }
  const candidate = new Map(state.projection().tasks)
  candidate.set(task.taskId, updated)
  validateTaskGraph(candidate)
  return updated
}
