import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { CoordinatorMessageSource, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type AutoReportWorkflowRuntime from '../runtime.js'
import type { Config } from '../config.js'
import { isSpecialistRole, rolePolicy, type SpecialistRole } from '../roles.js'
import { loadSpecialistPersona } from '../personas.js'
import {
  AUTOREPORT_SCHEMA_VERSION,
  type DelegationSnapshot,
  type RoleBindingSnapshot,
  type TaskSnapshot,
} from '../workflow/events.js'
import type { WorkflowSettingsSnapshot } from '../settings.js'
import { delegationKey } from '../workflow/protocol.js'

const MAX_PROMPT = 16_384
const MAX_CONTEXT = 8_192
const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 900_000

/** Workflow surface `send_to_agent` actually calls. */
export type SendToAgentWorkflow = Pick<AutoReportWorkflowRuntime, 'roleRegistry' | 'forSession' | 'commit'>

/** Dependencies used by the fixed-role delegation tool. */
export interface SendToAgentDependencies {
  readonly subagents: Pick<SubagentRuntime, 'startContinuable' | 'followup'>
  readonly workflow: SendToAgentWorkflow
  readonly config: Config
  readonly now?: () => number
  readonly childId?: () => SessionId
  readonly persona?: (role: SpecialistRole) => string
}

function text(raw: unknown, name: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error(`${name} must be non-empty`)
  if (raw.length > max) throw new Error(`${name} exceeds ${max} chars`)
  return raw.trim()
}

function taskBriefing(
  task: TaskSnapshot,
  revision: number,
  prompt: string,
  context: string | undefined,
): string {
  const policy = rolePolicy(task.role)
  const checklist = task.steps.length === 0
    ? '(no checklist supplied)'
    : task.steps.map(step => `${step.done ? '[x]' : '[ ]'} ${step.description}`).join('\n')
  return [
    `AutoReport task ${task.taskId}, delegation revision ${revision}`,
    `Role: ${task.role}`,
    `Task subject: ${task.subject}`,
    `Writable roots: ${policy.writableRoots.join(', ')}`,
    'All other workspace paths are read-only. Network access is denied.',
    `Checklist:\n${checklist}`,
    `Goal:\n${prompt}`,
    ...(context === undefined ? [] : [`Explicit user constraints:\n${context}`]),
    'Finish by calling report_workflow with this exact task_id and delegation_revision.',
  ].join('\n\n')
}

function nextAttempt(task: TaskSnapshot, runtime: ReturnType<AutoReportWorkflowRuntime['forSession']>): number {
  const current = runtime.state.currentDelegation(task.taskId)
  if (current?.phase === 'dispatched' && current.acceptedMessageId === undefined) return current.delegationRevision
  if (current?.phase === 'waiting_for_child') throw new Error(`task ${task.taskId} already has work waiting for its child`)
  return (current?.delegationRevision ?? 0) + 1
}

function ensureTaskDispatchable(task: TaskSnapshot, role: SpecialistRole, state: ReturnType<AutoReportWorkflowRuntime['forSession']>['state']): void {
  if (task.role !== role) throw new Error(`task ${task.taskId} belongs to ${task.role}, not ${role}`)
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new Error(`task ${task.taskId} cannot be dispatched from status ${task.status}`)
  }
  for (const dependency of task.dependencies) {
    if (state.getTask(dependency)?.status !== 'completed') throw new Error(`task dependency ${dependency} is not completed`)
  }
}

function normalizeTimeout(raw: unknown, fallback: number): number {
  const value = raw === undefined ? fallback : raw
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
  }
  return value
}

/**
 * Resolve the child `agentOptions` from the durable settings snapshot,
 * falling back to composition defaults ONLY when no snapshot is on the
 * workflow event. `{ inheritMain: true }` passes no route so DSH gives the
 * child the Main selection. DSH's `AgentOptions` surface carries provider and
 * model only, which seeds the child descriptor. The global AutoReport child
 * setup router applies the complete
 * snapshot selection (including reasoning effort) through DSH's scoped
 * `installModelSelection()` seam before the child is published.
 */
function childAgentOptions(
  snapshot: WorkflowSettingsSnapshot | undefined,
  fallbackRoute: Config['specialistModel'],
): { provider: string; model: string } | undefined {
  const selection = snapshot?.specialistModel
  if (selection !== undefined) {
    return selection.inheritMain ? undefined : { provider: selection.provider, model: selection.model }
  }
  return fallbackRoute === undefined ? undefined : { provider: fallbackRoute.provider, model: fallbackRoute.model }
}

/**
 * Create the fixed-role `send_to_agent` tool over DSH continuable messaging.
 * @param deps - DSH transport, workflow runtime, and plugin config.
 * @returns model-facing tool definition.
 */
export function createSendToAgentTool(deps: SendToAgentDependencies): ToolDefinition {
  const now = deps.now ?? Date.now
  const mintChild = deps.childId ?? (() => SessionId(randomUUID()))
  const persona = deps.persona ?? loadSpecialistPersona

  return defineTool({
    name: 'send_to_agent',
    description: 'Dispatch one durable AutoReport task to its fixed specialist role. Defaults to waiting for a structured workflow report.',
    parameters: {
      role: { type: 'string', required: true, enum: ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] },
      task_id: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      context: { type: 'string' },
      wait: { type: 'boolean', description: 'Wait for success/blocked/timeout; default true.' },
      timeout_ms: { type: 'number', description: 'Bounded wait in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: { status: { type: 'string', required: true }, task_id: { type: 'string', required: true }, delegation_revision: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const parent = exec.agent as Agent | undefined
      if (parent === undefined) throw new Error('send_to_agent requires an owning Main agent')
      const role = args.role
      if (!isSpecialistRole(role)) throw new Error('role must name an AutoReport specialist')
      const prompt = text(args.prompt, 'prompt', MAX_PROMPT)
      const context = args.context === undefined ? undefined : text(args.context, 'context', MAX_CONTEXT)
      const parentSession: Session = parent.session
      const live = deps.workflow.forSession(parentSession)
      const taskId = text(args.task_id, 'task_id', 256)
      const task = live.state.getTask(taskId)
      if (task === undefined) throw new Error(`unknown task ${taskId}`)
      ensureTaskDispatchable(task, role, live.state)
      const revision = nextAttempt(task, live)

      let binding = live.state.bindingForRole(role)
      let firstStart = binding === undefined || binding.provisioning === 'failed'
      // The workflow's creation-time snapshot outranks composition config;
      // composition applies only when the event predates snapshots.
      const settings = live.state.projection().meta?.settings
      if (firstStart) {
        const previousBinding = binding
        const newChild = mintChild()
        const reservation: RoleBindingSnapshot = {
          version: AUTOREPORT_SCHEMA_VERSION,
          role,
          childSessionId: newChild,
          parentSessionId: parent.id,
          workflowId: live.state.projection().meta?.workflowId ?? String(parent.id),
          provisioning: 'reserved',
          ...(previousBinding === undefined ? {} : { supersedes: previousBinding.childSessionId }),
        }
        deps.workflow.commit(parentSession, 'autoreport/role-binding', reservation)
        if (previousBinding !== undefined && deps.workflow.roleRegistry.lookup(previousBinding.childSessionId) !== undefined) {
          deps.workflow.roleRegistry.rebind(role, previousBinding.childSessionId, reservation)
        } else {
          deps.workflow.roleRegistry.registerReserved(reservation)
        }
        binding = reservation
      } else if (binding !== undefined && deps.workflow.roleRegistry.lookup(binding.childSessionId) === undefined) {
        deps.workflow.roleRegistry.registerReserved(binding)
      }
      if (binding === undefined) throw new Error(`no role binding available for ${role}`)

      const dispatched: DelegationSnapshot = {
        version: AUTOREPORT_SCHEMA_VERSION,
        taskId,
        delegationRevision: revision,
        role,
        childSessionId: binding.childSessionId,
        phase: 'dispatched',
        dispatchedAt: now(),
      }
      deps.workflow.commit(parentSession, 'autoreport/delegation', dispatched)
      if (task.status !== 'running' || task.latestDelegationRevision !== revision) {
        deps.workflow.commit(parentSession, 'autoreport/task', {
          ...task,
          status: 'running',
          revision: task.revision + 1,
          latestDelegationRevision: revision,
        })
      }

      const bound = binding
      const content: ContentBlock[] = [{ type: 'text', text: taskBriefing(task, revision, prompt, context) }]
      let acceptedMessageId: string
      try {
        if (firstStart) {
          const agentOptions = childAgentOptions(settings, deps.config.specialistModel)
          const accepted = await deps.subagents.startContinuable({
            provider: 'spawn',
            label: `AutoReport ${role}`,
            childId: bound.childSessionId,
            request: {
              prompt: content,
              parent,
              ...(agentOptions === undefined ? {} : { agentOptions }),
              maxDepth: 1,
              persona: persona(role),
              toolFilter: { deny: ['send_to_agent', 'report_task', 'ask_user_question'] },
            },
            signal: exec.signal,
          })
          acceptedMessageId = String(accepted.messageId)
          deps.workflow.roleRegistry.markActive(bound.childSessionId)
          const active: RoleBindingSnapshot = { ...bound, provisioning: 'active' }
          deps.workflow.commit(parentSession, 'autoreport/role-binding', active)
          binding = active
          firstStart = false
        } else {
          const source: CoordinatorMessageSource = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }
          acceptedMessageId = String(await deps.subagents.followup(parent, bound.childSessionId, content, {
            source,
            signal: exec.signal,
          }))
        }
      } catch (error: unknown) {
        if (bound.provisioning === 'reserved') {
          deps.workflow.roleRegistry.revoke(bound.childSessionId)
          deps.workflow.commit(parentSession, 'autoreport/role-binding', { ...bound, provisioning: 'failed' })
        }
        deps.workflow.commit(parentSession, 'autoreport/delegation', {
          ...dispatched,
          phase: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          settledAt: now(),
        })
        throw error
      }

      const waiting: DelegationSnapshot = { ...dispatched, acceptedMessageId, phase: 'waiting_for_child' }
      deps.workflow.commit(parentSession, 'autoreport/delegation', waiting)
      const wait = args.wait !== false
      if (!wait) {
        return {
          status: 'delegated',
          task_id: taskId,
          delegation_revision: revision,
          message_id: acceptedMessageId,
        }
      }

      const timeoutMs = normalizeTimeout(args.timeout_ms, settings?.executionTimeoutMs ?? deps.config.executionTimeoutMs)
      const outcome = await live.waiters.wait(delegationKey(taskId, revision), timeoutMs)
      if (outcome.status === 'timed_out') {
        const current = live.state.delegationAt(taskId, revision)
        if (current?.phase === 'waiting_for_child') {
          deps.workflow.commit(parentSession, 'autoreport/delegation', {
            ...current,
            phase: 'timed_out',
            reason: `no workflow report within ${timeoutMs}ms`,
            settledAt: now(),
          })
        }
      }
      const result = {
        status: outcome.status === 'completed' ? 'success' : outcome.status === 'timed_out' ? 'timeout' : outcome.status,
        task_id: taskId,
        delegation_revision: revision,
        ...(outcome.response === undefined ? {} : { response: outcome.response }),
        ...(outcome.blockType === undefined ? {} : { block_type: outcome.blockType }),
        ...(outcome.producedFiles === undefined ? {} : { produced_files: [...outcome.producedFiles] }),
      }
      return result
    },
    presentCall: args => ({ card: 'generic', title: `send_to_agent ${String(args.role)}`, kind: 'other', rawInput: args }),
  })
}

export const name = 'autoreportdsh-send-to-agent'
export const inject = ['tools', 'subagents', 'autoreportWorkflow']

/** Register `send_to_agent` in the AutoReport Main preset scope. */
export function apply(ctx: import('@deepseek-ai/cordis').Context): void {
  ctx.tools.register(createSendToAgentTool({
    subagents: ctx.subagents,
    workflow: ctx.autoreportWorkflow,
    config: ctx.autoreportWorkflow.config,
  }))
}
