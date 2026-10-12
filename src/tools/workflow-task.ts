/** MAIN's graph planning, inspection, scheduling, waiting and task repair tool. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskSnapshot } from '../workflow/events.js'
import { AUTOREPORT_SCHEMA_VERSION } from '../workflow/events.js'
import { delegationKey, isOpenDelegation } from '../workflow/protocol.js'
import { graphView, requireTask, resultVersion, taskView } from '../workflow/graph.js'
import { WorkflowError, workflowInteger, workflowTaskId, workflowTaskIds } from '../workflow/errors.js'
import { assertWorkflowFields, planTasks, updatePlannedTask } from '../workflow/planning.js'
import { WORKFLOW_TASK_SECTION, WORKFLOW_TASK_SYSTEM_PROMPT } from './prompt.js'
import { genericCall } from './presentation.js'

/** Register graph ownership and repair policy beside the workflow tool. */
export function installWorkflowTaskGuidance(ctx: Context): () => void {
  return ctx.systemPrompt.section({
    name: WORKFLOW_TASK_SECTION,
    order: ctx.systemPrompt.getSectionOrder('TOOL_REPORT'),
    text: ({ scope }) => ctx.tools.get('workflow_task', scope) === undefined ? '' : WORKFLOW_TASK_SYSTEM_PROMPT,
  })
}

const ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ['task_id'], graph: [], plan: ['tasks'],
  update: ['task_id', 'steps', 'prompt', 'context', 'subject', 'dependencies', 'expected_revision'],
  run: ['task_ids'], pause: [], wait: ['task_ids', 'mode', 'timeout_ms'],
  cancel: ['task_id', 'expected_revision'], reopen: ['task_id', 'expected_revision'],
}
const ACTIONS = ['read', 'graph', 'plan', 'update', 'run', 'pause', 'wait', 'cancel', 'reopen'] as const

/** Install MAIN-only workflow graph operations; conditional arguments are checked explicitly. */
export function installWorkflowTaskTool(ctx: Context, hostCtx: Context): () => void {
  installWorkflowTaskGuidance(ctx)
  return ctx.tools.register(defineTool({
    name: 'workflow_task',
    description: [
      'Plan, inspect and run the AutoReport task dependency graph. Only MAIN owns graph changes; specialists report results through report_workflow.',
      'plan accepts tasks (1–64 definitions) with role, subject, prompt, optional task_id/context/dependencies/steps. Use explicit task-* IDs for edges within a batch; forward references in that batch are supported. The complete graph is validated before any task is created. Planning does not start work.',
      'graph returns prerequisite-first order, readiness, exact unmet dependencies and role occupancy. read returns one task with task_id or the whole board without it.',
      'run optionally selects task_ids; it includes their prerequisites and automatically dispatches ready pending nodes as results arrive, with one active task per role. Calling run on an enabled scheduler extends its scope; pause first to replace that scope. Omit task_ids to run the whole plan. No fixed role chain is inferred.',
      'pause stops future automatic dispatch without cancelling current executions. MAIN conversation stop pauses scheduling and cancels current work.',
      'wait requires nonempty task_ids, mode any/all (default all), and optional timeout_ms in milliseconds. It only waits for results; it never dispatches or adds revisions. Prerequisite failure is returned with its blocking path. Timeout/cancelled wait preserves task execution.',
      'update requires task_id and at least one editable field. steps may change during execution; prompt/context/subject/dependencies cannot change on running or completed tasks. Use expected_revision to guard concurrent plan edits.',
      'cancel stops a nonterminal task and its active execution. reopen permits blocked/failed/cancelled/completed tasks to be rebuilt without replacing their specialist Session, and pauses future admission so instructions can be updated before run resumes it. Reopening completed upstream work invalidates all dependent results, stopping obsolete downstream attempts. Accepted results are versioned; late obsolete reports cannot restore freshness.',
      'Wrong fields, unknown IDs, duplicate IDs, cycles and unmet dependencies return their exact field/task/status/path and recovery instructions. Invalid requests make no graph changes.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'plan, graph, read, update, run, pause, wait, cancel or reopen.' },
      task_id: { type: 'string', description: 'One existing task ID for read/update/cancel/reopen.' },
      tasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        task_id: { type: 'string', description: 'Optional new task-* ID. Omit for an auto-generated task-N ID.' },
        role: { type: 'string', enum: ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] },
        subject: { type: 'string' }, prompt: { type: 'string' }, context: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' }, done: { type: 'boolean' } } } },
      } }, description: 'plan only: 1–64 task definitions. role, subject and prompt are required; dependencies reference existing or same-batch task IDs.' },
      task_ids: { type: 'array', items: { type: 'string' }, description: 'run scope or required wait targets; duplicates and unknown IDs are rejected.' },
      mode: { type: 'string', enum: ['any', 'all'], description: 'wait only: any first settled target or all targets. Default all.' },
      timeout_ms: { type: 'number', description: 'wait only: 1–900000 milliseconds. Default workflow hard wait budget. Expiry does not stop work.' },
      expected_revision: { type: 'number', description: 'update/cancel/reopen only: expected task mutation revision from read/graph.' },
      subject: { type: 'string', description: 'update only: replacement task subject.' },
      prompt: { type: 'string', description: 'update only: saved instructions, at most 16384 characters.' },
      context: { type: 'string', description: 'update only: explicit user constraints, at most 8192 characters.' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'update only: complete replacement prerequisite task IDs, validated for unknown IDs, duplicates, self-edges and cycles.' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' }, done: { type: 'boolean' } } }, description: 'update only: complete replacement checklist, at most 64 entries, descriptions at most 512 characters.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      const runtime = hostCtx.autoreportWorkflow
      const agent = exec.agent as Agent | undefined
      if (runtime === undefined || agent === undefined || !runtime.isMainSession(agent.id)) {
        throw new WorkflowError('WORKFLOW_UNAUTHORIZED', `workflow_task requires an AutoReport MAIN session; current session is ${agent?.id ?? '(missing)'}. Specialists use report_workflow; ordinary conversations cannot edit this graph.`, { session_id: agent === undefined ? null : String(agent.id) })
      }
      const session = agent.session
      runtime.coordinator.assertAvailable(session)
      const live = runtime.forSession(session)
      const action = args.action
      const allowed = ACTION_FIELDS[action]
      if (allowed === undefined) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `action=${String(action)} is unsupported. Choose ${Object.keys(ACTION_FIELDS).join(', ')}.`, { field: 'action', actual: action })
      assertWorkflowFields(args, action, allowed)
      if (action === 'graph') return runtime.coordinator.inspect(session)
      if (action === 'read') {
        if (args.task_id === undefined) return { tasks: [...live.state.projection().tasks.values()].map(task => runtime.coordinator.inspectTask(session, task)) }
        return { task: runtime.coordinator.inspectTask(session, requireTask(live.state, workflowTaskId(args.task_id))) }
      }
      if (action === 'plan') {
        const planned = planTasks(live.state, args.tasks)
        for (const task of planned) runtime.commit(session, 'autoreport/task', task)
        return { status: 'planned', created_task_ids: planned.map(task => task.taskId), ...graphView(live.state) }
      }
      if (action === 'run') return runtime.coordinator.run(agent, args.task_ids === undefined ? undefined : workflowTaskIds(args.task_ids, 'task_ids', true))
      if (action === 'pause') {
        runtime.coordinator.pause(session)
        return { status: 'paused', ...runtime.coordinator.inspect(session) }
      }
      if (action === 'wait') {
        const ids = workflowTaskIds(args.task_ids, 'task_ids', true)
        const mode = args.mode ?? 'all'
        if (mode !== 'any' && mode !== 'all') throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `mode=${String(mode)} must be any or all.`, { field: 'mode', actual: mode })
        const timeout = workflowInteger(args.timeout_ms, 'timeout_ms', live.state.projection().meta?.settings?.delegationWaitTimeoutMs ?? runtime.config.delegationWaitTimeoutMs)
        return runtime.coordinator.wait(session, ids, mode, timeout, exec.signal)
      }
      const current = requireTask(live.state, workflowTaskId(args.task_id))
      if (args.expected_revision !== undefined) {
        const expected = workflowInteger(args.expected_revision, 'expected_revision', 1, Number.MAX_SAFE_INTEGER)
        if (current.revision !== expected) throw new WorkflowError('WORKFLOW_TASK_CHANGED', `Task ${current.taskId} changed: expected revision ${expected}, actual revision ${current.revision}. Read the task and retry using the current revision.`, { task_id: current.taskId, expected_revision: expected, actual_revision: current.revision })
      }
      if (action === 'update') {
        const next = updatePlannedTask(live.state, current, args)
        runtime.commit(session, 'autoreport/task', next)
        return { status: 'updated', task: taskView(live.state, next) }
      }
      if (action === 'cancel') {
        if (current.status === 'completed' || current.status === 'cancelled') throw new WorkflowError('WORKFLOW_INVALID_TRANSITION', `Task ${current.taskId} cannot be cancelled from ${current.status}. ${current.status === 'completed' ? 'Reopen it to revise its result and invalidate downstream tasks.' : 'It is already cancelled; reopen it to resume work.'}`, { task_id: current.taskId, status: current.status })
        const attempt = live.state.currentDelegation(current.taskId)
        if (isOpenDelegation(attempt)) {
          runtime.commit(session, 'autoreport/delegation', { ...attempt, phase: 'cancelled', reason: `cancelled by MAIN: task ${current.taskId}`, settledAt: Date.now() })
          live.waiters.settle(delegationKey(attempt.taskId, attempt.delegationRevision), { status: 'cancelled' })
        }
        const { blockedReason: _blocked, failedReason: _failed, ...rest } = current
        const next = { ...rest, status: 'cancelled' as const, revision: current.revision + 1 }
        runtime.commit(session, 'autoreport/task', next)
        if (attempt !== undefined) runtime.stopTaskExecution(attempt)
        return { status: 'cancelled', task: taskView(live.state, next) }
      }
      if (!['blocked', 'failed', 'cancelled', 'completed'].includes(current.status)) throw new WorkflowError('WORKFLOW_INVALID_TRANSITION', `Task ${current.taskId} cannot be reopened from ${current.status}. Reopen accepts blocked, failed, cancelled or completed tasks; ${current.status === 'running' ? 'cancel the active execution first.' : 'a pending task can already be updated or run.'}`, { task_id: current.taskId, status: current.status })
      const { blockedReason: _blocked, failedReason: _failed, staleReason: _stale, ...rest } = current
      const next: TaskSnapshot = { ...rest, version: AUTOREPORT_SCHEMA_VERSION, status: 'pending', revision: current.revision + 1, resultVersion: resultVersion(current) }
      runtime.coordinator.pause(session)
      runtime.commit(session, 'autoreport/task', next)
      return { status: 'reopened', scheduler_paused: true, next_action: 'Update the task if needed, then run the desired graph scope to resume scheduling.', task: taskView(live.state, next), invalidated_task_ids: [...live.state.projection().tasks.values()].filter(task => task.staleReason !== undefined).map(task => task.taskId) }
    },
    presentCall: args => genericCall(`workflow_task ${String(args.action)}`, args.task_id ?? args.task_ids?.join(', ')),
  }))
}
