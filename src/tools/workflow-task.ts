import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type AutoReportWorkflowRuntime from '../runtime.js'
import type { TaskSnapshot } from '../workflow/events.js'
import { delegationKey } from '../workflow/protocol.js'

const MAX_STEPS = 64
const MAX_STEP_LENGTH = 512

function runtimeOf(ctx: Context): AutoReportWorkflowRuntime | undefined {
  return ctx.autoreportWorkflow
}

function taskId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 256) {
    throw new Error('task_id must be a non-empty string up to 256 chars')
  }
  return raw.trim()
}

function steps(raw: unknown): Array<{ description: string; done?: boolean }> {
  if (!Array.isArray(raw) || raw.length > MAX_STEPS) throw new Error(`steps must contain at most ${MAX_STEPS} items`)
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`steps[${index}] must be an object`)
    const value = item as Record<string, unknown>
    if (typeof value.description !== 'string' || value.description.trim().length === 0 || value.description.length > MAX_STEP_LENGTH) {
      throw new Error(`steps[${index}].description must be a non-empty string up to ${MAX_STEP_LENGTH} chars`)
    }
    if (value.done !== undefined && typeof value.done !== 'boolean') throw new Error(`steps[${index}].done must be boolean`)
    return { description: value.description.trim(), ...(value.done === true ? { done: true } : {}) }
  })
}

function value(task: TaskSnapshot) {
  return {
    task_id: task.taskId,
    subject: task.subject,
    role: task.role,
    status: task.status,
    revision: task.revision,
    dependencies: [...task.dependencies],
    steps: task.steps.map(step => ({ ...step })),
    scopes: [...task.scopes],
    ...(task.blockedReason === undefined ? {} : { blocked_reason: task.blockedReason }),
    ...(task.failedReason === undefined ? {} : { failed_reason: task.failedReason }),
    ...(task.latestDelegationRevision === undefined ? {} : { latest_delegation_revision: task.latestDelegationRevision }),
  }
}

/** Install the MAIN-only durable AutoReport task-board tool. */
export function installWorkflowTaskTool(ctx: Context, hostCtx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'workflow_task',
    description: 'Read or maintain AutoReport’s durable report task board. Use update to replace a task checklist, cancel to stop a nonterminal task, and reopen to make a blocked, failed, or cancelled task dispatchable again. This is the report workflow task board, not generic todo_write.',
    parameters: {
      action: { type: 'string', required: true, enum: ['read', 'update', 'cancel', 'reopen'] },
      task_id: { type: 'string', description: 'Required for update, cancel, and reopen; optional for read.' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: { type: 'string', required: true }, done: { type: 'boolean' } } }, description: 'Replacement checklist; required for update.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      const runtime = runtimeOf(hostCtx)
      const agent = exec.agent as Agent | undefined
      if (runtime === undefined || agent === undefined || !runtime.isMainSession(agent.id)) {
        throw new Error('workflow_task requires an AutoReport MAIN session')
      }
      const session = agent.session
      const live = runtime.forSession(session)
      const action = args.action
      if (action === 'read') {
        if (args.task_id === undefined) return { tasks: [...live.state.projection().tasks.values()].map(value) }
        const task = live.state.getTask(taskId(args.task_id))
        if (task === undefined) throw new Error('unknown task_id')
        return { task: value(task) }
      }
      const current = live.state.getTask(taskId(args.task_id))
      if (current === undefined) throw new Error('unknown task_id')
      if (action === 'update') {
        const next = live.state.updateChecklist(current, steps(args.steps))
        runtime.commit(session, 'autoreport/task', next)
        return { status: 'updated', task: value(next) }
      }
      if (action === 'cancel') {
        if (current.status === 'completed' || current.status === 'cancelled') throw new Error(`task ${current.taskId} cannot be cancelled from ${current.status}`)
        const attempt = live.state.currentDelegation(current.taskId)
        if (attempt?.phase === 'dispatched' || attempt?.phase === 'waiting_for_child') {
          runtime.commit(session, 'autoreport/delegation', { ...attempt, phase: 'cancelled', reason: 'cancelled by MAIN', settledAt: Date.now() })
          live.waiters.settle(delegationKey(attempt.taskId, attempt.delegationRevision), { status: 'cancelled' })
        }
        const { blockedReason: _blocked, failedReason: _failed, ...rest } = current
        const next = { ...rest, status: 'cancelled' as const, revision: current.revision + 1 }
        runtime.commit(session, 'autoreport/task', next)
        return { status: 'cancelled', task: value(next) }
      }
      if (action === 'reopen') {
        if (!['blocked', 'failed', 'cancelled'].includes(current.status)) throw new Error(`task ${current.taskId} cannot be reopened from ${current.status}`)
        const { blockedReason: _blocked, failedReason: _failed, ...rest } = current
        const next = { ...rest, status: 'pending' as const, revision: current.revision + 1 }
        runtime.commit(session, 'autoreport/task', next)
        return { status: 'reopened', task: value(next) }
      }
      throw new Error(`unknown workflow_task action ${String(action)}`)
    },
    presentCall: args => ({ card: 'generic', title: `workflow_task ${String(args.action)}`, kind: 'other', rawInput: args }),
  }))
}
