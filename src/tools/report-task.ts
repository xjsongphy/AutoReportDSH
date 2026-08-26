/**
 * MAIN-facing `report_task` tool (PLAN.md §2.6): the fixed-workflow task
 * board over the durable projection. Operations are exactly
 * create/dispatch/block/complete/fail/cancel/reopen/list/get — there is no
 * generic `claim`; ownership is fixed by the task's role at creation.
 *
 * Every mutation validates the status transition against the current
 * snapshot, appends the replacement through {@link appendWorkflowEvent}
 * (`ignorable: true`), and applies it to the live {@link WorkflowState}.
 * Dispatch records a NEW delegation revision in phase `dispatched`; transport
 * itself belongs to `send_to_agent` (roles-delegation phase).
 * @module
 */

import type { Session, SessionEvent, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SpecialistRole } from '../roles.js'
import { AUTOREPORT_SCHEMA_VERSION, type TaskStep } from '../workflow/events.js'
import { isSpecialistRole } from '../roles.js'
import { appendWorkflowEvent } from '../workflow/store.js'
import type { DelegationPhase, TaskSnapshot } from '../workflow/events.js'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { WorkflowState } from '../workflow/service.js'

/** Upper bound for task subject text. */
const MAX_SUBJECT = 256

/** Upper bound for block/fail reasons. */
const MAX_REASON = 2048

/** Workspace-relative scope each role's tasks produce files into. */
function roleToScope(role: SpecialistRole): string {
  if (role === 'DATA_ANALYSIS') return 'Data/Processed'
  if (role === 'PLOTTING') return 'Plots'
  if (role === 'REPORT') return 'Report'
  return 'Theory'
}

/**
 * Build the canonical checklist for create/dispatch inputs.
 * @param raw - optional model-supplied steps.
 * @returns normalized steps, or undefined when absent/empty.
 */
function toSteps(raw: unknown): TaskStep[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (raw.length > 64) throw new Error('checklist exceeds 64 steps')
  const steps = raw.map(entry => {
    const record = (entry ?? {}) as Record<string, unknown>
    const description = typeof record['description'] === 'string' ? record['description'].trim() : ''
    if (description.length === 0) throw new Error('checklist step description must be non-empty')
    if (description.length > 512) throw new Error('checklist step description exceeds 512 chars')
    return { description, done: record['done'] === true }
  })
  return steps.length === 0 ? undefined : steps
}

/**
 * Require and bound a reason string.
 * @param raw - model-supplied reason.
 * @param label - operation name for error messages.
 * @returns the trimmed reason.
 */
function requireReason(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error(`${label} requires a non-empty reason`)
  if (raw.length > MAX_REASON) throw new Error(`${label} reason exceeds ${MAX_REASON} chars`)
  return raw.trim()
}

/**
 * Compact list row shown to the model.
 * @param task - full snapshot.
 * @param latest - current delegation phase or undefined.
 * @returns compact summary object.
 */
function summarize(task: TaskSnapshot, latest?: DelegationPhase): Record<string, JsonValue> {
  return {
    task_id: task.taskId,
    subject: task.subject,
    role: task.role,
    status: task.status,
    open_steps: task.steps.filter(step => !step.done).length,
    ...(latest !== undefined ? { latest_phase: latest } : {}),
  }
}

/**
 * Evolve a snapshot without tripping exactOptionalPropertyTypes: only defined
 * replacement fields appear on the result.
 * @param previous - current snapshot.
 * @param patch - fields to replace; `undefined` values are omitted entirely.
 * @returns the replacement snapshot with an incremented mutation revision.
 */
function evolve(
  previous: TaskSnapshot,
  patch: Partial<Omit<TaskSnapshot, 'version' | 'taskId' | 'revision'>>,
): TaskSnapshot {
  const next: TaskSnapshot = { ...previous, ...patch, revision: previous.revision + 1 }
  return next
}

/**
 * Return a copy without the optional reason fields.
 * @param task - snapshot carrying possible reasons.
 * @returns a copy with blockedReason/failedReason absent.
 */
function clearReasons(task: TaskSnapshot): TaskSnapshot {
  const { blockedReason: _blocked, failedReason: _failed, ...rest } = task
  return rest
}

/**
 * Create the `report_task` tool bound to one workflow state. Mutations commit
 * through real session events (`ignorable: true`) and apply to the state, so
 * tests drive plain in-memory Sessions and production wires MAIN's session.
 * @param state - live projection the tool reads and updates.
 * @returns the tool definition for `ctx.tools.register`.
 */
export function createReportTaskTool(
  stateSource: WorkflowState | ((session: Session) => WorkflowState),
): ToolDefinition {
  return defineTool({
    name: 'report_task',
    description:
      'AutoReport task board. Create report tasks for fixed specialist roles '
      + '(THEORY, DATA_ANALYSIS, PLOTTING, REPORT), dispatch them as numbered delegation attempts, '
      + 'and track completion. There is no claim operation: a task belongs to the role it was created for. '
      + 'complete() succeeds only after the owning child reported success for the current attempt.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: ['create', 'dispatch', 'block', 'complete', 'fail', 'cancel', 'reopen', 'list', 'get'],
        description: 'Task-board operation.',
      },
      task_id: { type: 'string', description: 'Target task id (required except for create/list).' },
      subject: { type: 'string', description: 'create: short imperative subject.' },
      role: {
        type: 'string',
        enum: ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'],
        description: 'create: owning specialist role.',
      },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'create: task ids that must complete first.',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', required: true },
            done: { type: 'boolean' },
          },
        },
        description: 'create/dispatch: bounded checklist of concrete deliverables.',
      },
      reason: { type: 'string', description: 'block/fail: why the task is blocked or failed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'object', additionalProperties: true },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    execute(args, exec) {
      const session: Session | undefined = exec.agent?.session
      if (session === undefined) throw new Error('report_task requires an owning agent session')
      const state = typeof stateSource === 'function' ? stateSource(session) : stateSource
      const requireTask = (raw: unknown): TaskSnapshot => {
        const taskId = typeof raw === 'string' ? raw : ''
        const task = state.getTask(taskId)
        if (task === undefined) throw new Error(`unknown task ${taskId === '' ? '(missing task_id)' : taskId}`)
        return task
      }
      const resolveChildId = (role: SpecialistRole): SessionId | undefined => state.bindingForRole(role)?.childSessionId
      const commit = <T extends keyof SessionEventMap & string>(type: T, data: SessionEventMap[T]): void => {
        const logged: SessionEvent<T> = appendWorkflowEvent(session, type as never, data as never)
        state.apply(logged as SessionEvent<SessionEventType>)
      }

      switch (args.operation) {
        case 'create': {
          const subject = typeof args.subject === 'string' ? args.subject.trim() : ''
          if (subject.length === 0 || subject.length > MAX_SUBJECT) {
            throw new Error(`create requires a subject of 1–${MAX_SUBJECT} chars`)
          }
          const role = args.role
          if (!isSpecialistRole(role)) throw new Error('create requires a specialist role')
          const dependencies = Array.isArray(args.dependencies) ? args.dependencies.map(String) : []
          for (const dependency of dependencies) {
            if (state.getTask(dependency) === undefined) throw new Error(`unknown dependency ${dependency}`)
          }
          const steps = toSteps(args.steps)
          const taskId = state.nextTaskId()
          const snapshot: TaskSnapshot = {
            version: AUTOREPORT_SCHEMA_VERSION,
            taskId,
            subject,
            role,
            dependencies,
            status: 'pending',
            revision: 1,
            ...(steps !== undefined ? { steps } : { steps: [] }),
            scopes: [roleToScope(role)],
          }
          commit('autoreport/task', snapshot)
          return Promise.resolve({ ok: true, task: summarize(snapshot, undefined) })
        }
        case 'dispatch': {
          const previous = requireTask(args.task_id)
          if (previous.status !== 'pending' && previous.status !== 'blocked' && previous.status !== 'failed') {
            throw new Error(`cannot dispatch a task in status ${previous.status}; reopen cancelled tasks first`)
          }
          const revision = (state.currentDelegation(previous.taskId)?.delegationRevision ?? 0) + 1
          const childSessionId = resolveChildId(previous.role)
          commit('autoreport/delegation', {
            version: AUTOREPORT_SCHEMA_VERSION,
            taskId: previous.taskId,
            delegationRevision: revision,
            role: previous.role,
            ...(childSessionId !== undefined ? { childSessionId } : { childSessionId: '' as SessionId }),
            phase: 'dispatched',
            dispatchedAt: Date.now(),
          })
          const steps = toSteps(args.steps)
          const cleared = clearReasons(previous)
          const updated: TaskSnapshot = {
            ...cleared,
            status: 'running',
            latestDelegationRevision: revision,
            ...(steps !== undefined ? { steps } : {}),
          }
          commit('autoreport/task', updated)
          return Promise.resolve({ ok: true, task: summarize(updated, 'dispatched') })
        }
        case 'block': {
          const previous = requireTask(args.task_id)
          if (previous.status !== 'running') throw new Error(`cannot block a task in status ${previous.status}`)
          const updated = evolve(previous, { status: 'blocked', blockedReason: requireReason(args.reason, 'block') })
          commit('autoreport/task', updated)
          return Promise.resolve({ ok: true, task: summarize(updated, undefined) })
        }
        case 'complete': {
          const previous = requireTask(args.task_id)
          const current = state.currentDelegation(previous.taskId)
          if (current?.phase !== 'completed') {
            throw new Error(
              `cannot complete: current attempt is ${current?.phase ?? 'undispatched'}; wait for the child's success report`,
            )
          }
          const updated = clearReasons({ ...previous, status: 'completed' })
          commit('autoreport/task', updated)
          return Promise.resolve({ ok: true, task: summarize(updated, current.phase) })
        }
        case 'fail': {
          const previous = requireTask(args.task_id)
          if (previous.status !== 'running') throw new Error(`cannot fail a task in status ${previous.status}`)
          const updated = evolve(previous, { status: 'failed', failedReason: requireReason(args.reason, 'fail') })
          commit('autoreport/task', updated)
          return Promise.resolve({ ok: true, task: summarize(updated, undefined) })
        }
        case 'cancel': {
          const previous = requireTask(args.task_id)
          if (previous.status === 'completed' || previous.status === 'cancelled') {
            throw new Error(`cannot cancel a task in status ${previous.status}`)
          }
          const updated = evolve(previous, { status: 'cancelled' })
          commit('autoreport/task', updated)
          return Promise.resolve({ ok: true, task: summarize(updated, undefined) })
        }
        case 'reopen': {
          const previous = requireTask(args.task_id)
          if (previous.status !== 'blocked' && previous.status !== 'failed' && previous.status !== 'cancelled') {
            throw new Error(`cannot reopen a task in status ${previous.status}`)
          }
          const updated = clearReasons({ ...previous, status: 'pending' })
          commit('autoreport/task', updated)
          return Promise.resolve({ ok: true, task: summarize(updated, undefined) })
        }
        case 'list': {
          const tasks = [...state.projection().tasks.values()].map(task =>
            summarize(task, state.currentDelegation(task.taskId)?.phase),
          )
          return Promise.resolve({ ok: true, tasks })
        }
        case 'get': {
          const task = requireTask(args.task_id)
          const latest = state.currentDelegation(task.taskId)?.phase
          const plain: Record<string, JsonValue> = JSON.parse(
            JSON.stringify({ ...task, ...(latest !== undefined ? { latest_phase: latest } : {}) }),
          ) as Record<string, JsonValue>
          return Promise.resolve({ ok: true, task: plain })
        }
        default:
          throw new Error(`unknown operation ${String(args.operation)}`)
      }
    },
    presentCall: args => ({ card: 'generic', title: `report_task ${String(args.operation)}`, kind: 'other', rawInput: args }),
  })
}

export const name = 'autoreportdsh-report-task'
export const inject = ['tools', 'autoreportWorkflow']

/** Register `report_task` in the AutoReport Main preset scope. */
export function apply(ctx: import('@deepseek-ai/cordis').Context): void {
  ctx.tools.register(createReportTaskTool(session => ctx.autoreportWorkflow.forSession(session).state))
}
