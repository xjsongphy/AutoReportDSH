import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { CoordinatorMessageSource } from '../messages.js'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type AutoReportWorkflowRuntime from '../runtime.js'
import type { Config } from '../config.js'
import { DSH_ROLE_ESCAPE_TOOL_NAMES, rolePolicy, type SpecialistRole } from '../roles.js'
import { loadSpecialistPersona } from '../personas.js'
import {
  AUTOREPORT_SCHEMA_VERSION,
  type DelegationSnapshot,
  type RoleBindingSnapshot,
  type TaskSnapshot,
} from '../workflow/events.js'
import type { WorkflowSettingsSnapshot } from '../settings.js'
import { roleHandoffText } from '../workflow/file-notes.js'
import { delegationKey, isOpenDelegation } from '../workflow/protocol.js'
import type { WaiterOutcome } from '../workflow/waiters.js'
import { residentToolFilter } from '../subagent-descriptor.js'
import { SEND_TO_AGENT_SECTION, SEND_TO_AGENT_SYSTEM_PROMPT } from './prompt.js'
import { genericCall } from './presentation.js'
import { assertDependenciesReady, assertRoleAvailable, dependencyVersions, requireTask } from '../workflow/graph.js'
import { WorkflowError, workflowInteger, workflowRole, workflowSteps, workflowTaskIds, workflowText } from '../workflow/errors.js'

const MAX_PROMPT = 16_384
const MAX_CONTEXT = 8_192
const MAX_SUBJECT = 256
const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 900_000
/** Fallbacks used only when composition supplies no wait budgets. */
const DEFAULT_HARD_TIMEOUT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

/** Workflow surface `send_to_agent` actually calls. */
export type SendToAgentWorkflow = Pick<AutoReportWorkflowRuntime, 'roleRegistry' | 'forSession' | 'commit'>

/** Dependencies used by the fixed-role delegation tool. */
export interface SendToAgentDependencies {
  /** Admission barrier owned by the live workflow runtime (e.g. during reset). */
  readonly assertAvailable?: (session: Session) => void
  readonly subagents: Pick<SubagentRuntime, 'startContinuable'>
  /**
   * Host delivery onto a manager-owned continuable child (the unified-steer
   * seam; the former `SubagentRuntime.followup` wrapper is gone upstream).
   */
  readonly deliverChild: (parent: Agent, childSessionId: SessionId, content: ContentBlock[], source: CoordinatorMessageSource, signal: AbortSignal) => Promise<string>
  /** Resident AutoReport roles are addressed directly; legacy continuables remain supported. */
  readonly resident?: {
    ensure: (parent: Agent, role: SpecialistRole, signal: AbortSignal) => Promise<Agent | undefined>
    deliver: (
      parent: Agent,
      childSessionId: SessionId,
      content: ContentBlock[],
      source: CoordinatorMessageSource,
      signal: AbortSignal,
    ) => Promise<string | undefined>
  }
  readonly workflow: SendToAgentWorkflow
  readonly config: Config
  /**
   * Host LLM adapter registry. When present, an explicit frozen specialist
   * route whose provider no adapter serves fails the dispatch BEFORE any
   * durable state is committed, instead of a child dying on its first turn
   * with NO_ADAPTER while a wait=true caller sits out the idle timeout.
   */
  readonly llm?: { readonly listProviders: () => ReadonlyArray<{ readonly id: string }> }
  readonly now?: () => number
  readonly childId?: () => SessionId
  readonly persona?: (role: SpecialistRole) => string
}

function text(raw: unknown, name: string, max: number): string {
  return workflowText(raw, name, max)
}

/** Workspace-relative scope each role's tasks produce files into. */
function roleToScope(role: SpecialistRole): string {
  if (role === 'DATA_ANALYSIS') return 'Data/Processed'
  if (role === 'PLOTTING') return 'Plots'
  if (role === 'REPORT') return 'Report'
  return 'Theory'
}

function taskBriefing(
  task: TaskSnapshot,
  revision: number,
  prompt: string,
  context: string | undefined,
  handoff: string | undefined,
): string {
  const policy = rolePolicy(task.role)
  const checklist = task.steps.length === 0
    ? '(no checklist supplied)'
    : task.steps.map(step => `${step.done ? '[x]' : '[ ]' } ${step.description}`).join('\n')
  return [
    `AutoReport task ${task.taskId}, delegation revision ${revision}`,
    `Role: ${task.role}`,
    'Read scope: the whole experiment workspace (read-only context; duty boundaries live in your persona, not in read ACLs).',
    `Writable root: ${policy.writableRoot}/ (the only directory you may mutate).`,
    'All paths you exchange with tools are experiment-workspace-relative, e.g. Report/main.typ.',
    `Task subject: ${task.subject}`,
    `Output artifacts: ${roleToScope(task.role)}/`,
    `Checklist:\n${checklist}`,
    `Goal:\n${prompt}`,
    ...(context === undefined ? [] : [`Explicit user constraints:\n${context}`]),
    ...(handoff === undefined ? [] : [handoff]),
  ].join('\n\n')
}

function nextAttempt(task: TaskSnapshot, runtime: ReturnType<AutoReportWorkflowRuntime['forSession']>): number {
  const current = runtime.state.currentDelegation(task.taskId)
  if (isOpenDelegation(current)) throw new Error(`task ${task.taskId} already has work waiting for its child`)
  return (current?.delegationRevision ?? 0) + 1
}

function ensureRoleAvailable(role: SpecialistRole, state: ReturnType<AutoReportWorkflowRuntime['forSession']>['state']): void {
  assertRoleAvailable(state, role)
}

function ensureTaskDispatchable(task: TaskSnapshot, role: SpecialistRole, state: ReturnType<AutoReportWorkflowRuntime['forSession']>['state']): void {
  if (task.role !== role) throw new WorkflowError('WORKFLOW_ROLE_MISMATCH', `Task ${task.taskId} belongs to ${task.role}, not ${role}. Dispatch with role=${task.role}; task ownership cannot be reassigned.`, { task_id: task.taskId, expected_role: task.role, actual_role: role })
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new WorkflowError('WORKFLOW_TASK_NOT_DISPATCHABLE', `Task ${task.taskId} cannot be dispatched from status ${task.status}. ${task.status === 'completed' ? 'Reopen it for revision (which invalidates dependent results), or plan a different task.' : 'Reopen the cancelled task before dispatching.'}`, { task_id: task.taskId, status: task.status })
  }
  assertDependenciesReady(state, task)
}

function normalizeTimeout(raw: unknown, fallback: number): number {
  return workflowInteger(raw, 'timeout_ms', fallback, MAX_TIMEOUT_MS)
}

function isNotResumable(error: unknown): boolean {
  if (error instanceof SubagentError && error.code === 'NOT_RESUMABLE') return true
  return (error as { code?: string }).code === 'NOT_RESUMABLE'
}

function taskSteps(raw: unknown): Array<{ description: string; done: boolean }> {
  return workflowSteps(raw)
}

function subjectFromPrompt(prompt: string, rawSubject: unknown): string {
  if (rawSubject !== undefined) return text(rawSubject, 'subject', MAX_SUBJECT)
  const firstLine = prompt.split('\n')[0]?.trim() ?? prompt
  return firstLine.length <= MAX_SUBJECT ? firstLine : firstLine.slice(0, MAX_SUBJECT)
}

/** Convert one already-folded terminal delegation into the waiter vocabulary. */
function terminalOutcome(snapshot: DelegationSnapshot | undefined): WaiterOutcome | undefined {
  if (snapshot?.phase === 'cancelled') {
    return { status: 'cancelled' }
  }
  if (snapshot?.phase === 'completed') {
    return {
      status: 'completed',
      ...(snapshot.report?.response === undefined ? {} : { response: snapshot.report.response }),
      ...(snapshot.report?.produced_files === undefined ? {} : { producedFiles: snapshot.report.produced_files }),
    }
  }
  if (snapshot?.phase === 'blocked') {
    return {
      status: 'blocked',
      ...(snapshot.report?.response === undefined ? {} : { response: snapshot.report.response }),
      ...(snapshot.report?.block_type === 'missing_data' || snapshot.report?.block_type === 'quality' || snapshot.report?.block_type === 'missing_dependency'
        ? { blockType: snapshot.report.block_type }
        : {}),
    }
  }
  if (snapshot?.phase === 'failed') {
    return { status: 'failed', ...(snapshot.reason === undefined ? {} : { response: snapshot.reason }) }
  }
  return undefined
}

function resultFromOutcome(
  taskId: string,
  revision: number,
  outcome: WaiterOutcome,
): {
  status: string
  task_id: string
  delegation_revision: number
  response?: string
  block_type?: 'missing_data' | 'quality' | 'missing_dependency'
  produced_files?: string[]
} {
  return {
    status: outcome.status === 'completed' ? 'success' : outcome.status === 'timed_out' ? 'timeout' : outcome.status,
    task_id: taskId,
    delegation_revision: revision,
    ...(outcome.response === undefined ? {} : { response: outcome.response }),
    ...(outcome.blockType === undefined ? {} : { block_type: outcome.blockType }),
    ...(outcome.producedFiles === undefined ? {} : { produced_files: [...outcome.producedFiles] }),
  }
}

/**
 * Create the fixed-role `send_to_agent` tool over DSH continuable messaging.
 * @param deps - DSH transport, workflow runtime, and plugin config.
 * @returns model-facing tool definition.
 */
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
 * Refuse dispatches whose frozen specialist route names a provider no
 * registered LLM adapter serves. `inheritMain` routes pass untouched: the
 * Main request-time route is resolved by DSH at child-call time and has no
 * stable provider id to check here.
 */
function ensureRouteRegistered(
  llm: SendToAgentDependencies['llm'],
  route: { provider: string; model: string } | undefined,
): void {
  if (llm === undefined || route === undefined) return
  const registered = llm.listProviders().some(info => info.id === route.provider)
  if (registered) return
  throw new Error(
    `specialist provider "${route.provider}" is not registered in this deployment; `
    + `the ${route.model} subagent could not run. Install the matching provider plugin `
    + '(e.g. dsh-codex-subscription) or clear specialistModel from AutoReport settings.',
  )
}

export function createSendToAgentTool(deps: SendToAgentDependencies): ToolDefinition {
  const now = deps.now ?? Date.now
  const mintChild = deps.childId ?? (() => SessionId(randomUUID()))
  const persona = deps.persona ?? loadSpecialistPersona
  // Wait budgets the deployment actually applies, so the schema states the
  // configured numbers instead of a copy that drifts from `Config`. A
  // session's frozen settings snapshot can override them per workflow.
  const defaultHardTimeoutMs = deps.config.delegationWaitTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
  const defaultIdleTimeoutMs = deps.config.delegationIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  return defineTool({
    name: 'send_to_agent',
    description: [
      'Dispatch one durable AutoReport task to its fixed subagent role; creates a task when task_id is omitted. Successful or blocked work is reported through report_workflow.',
      'wait=true is the default. Dispatch waits for DSH to accept the message, then this call waits for that delegation revision to settle. It returns "success" (report response and produced_files), "blocked" (response and block_type: "missing_data", "quality", or "missing_dependency"), "failed" (child turn ended without a valid report; response gives the reason), "cancelled" (workflow_task cancelled it), or "timeout" (idle or hard limit reached). Errors before DSH accepts the message, including child startup or delivery errors, fail the tool call instead of returning one of these statuses.',
      'For block_type "missing_dependency", install the reported dependency yourself; do not ask the subagent to install it.',
      'wait=false returns "delegated" after DSH accepts the message. Any eventual workflow report arrives later as a role \u2192 MAIN message in this conversation; do not poll for it.',
      `timeout_ms is the absolute post-acceptance wait limit (default ${defaultHardTimeoutMs} ms; maximum ${MAX_TIMEOUT_MS} ms); child startup and message delivery are outside this limit. A separate idle timeout (configured default ${defaultIdleTimeoutMs} ms) counts while DSH reports the child as idle, pauses while it is running, and restarts when it becomes idle. Either timeout ends only this caller's wait; the same task and revision still await their report. Do not redispatch or queue another task to the occupied role.`,
      'task_id must name an existing task of the requested role: completed or cancelled tasks, unknown task ids, and unfinished dependencies are rejected instead of dispatched. A rejected call changes nothing.',
      'Each role admits one unsettled task at a time. A busy role rejects dispatch without creating a task or revision. Redispatch a blocked or failed task with the same task_id after settlement; to change unfinished work, cancel it with workflow_task, reopen it, then redispatch. Supply missing inputs or corrected constraints rather than repeating the failed prompt verbatim.',
    ].join(' '),
    parameters: {
      role: { type: 'string', required: true, enum: ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'], description: 'Fixed subagent role that owns the work; an existing task_id must belong to this role.' },
      prompt: { type: 'string', description: 'Task goal; required when creating a task, optional for task_id with a saved plan prompt.' },
      subject: { type: 'string', description: 'Short task subject when auto-creating a task. Defaults to the first line of prompt.' },
      dependencies: { type: 'array', items: { type: 'string' }, description: 'Task ids that must already be completed when auto-creating a task.' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { description: { type: 'string', required: true }, done: { type: 'boolean' } } }, description: 'Initial durable checklist when auto-creating a task; ignored for an existing task_id.' },
      task_id: { type: 'string', description: 'Existing settled task to redispatch; must belong to role. Omit to create a new task. This does not update a running task.' },
      context: { type: 'string', description: 'Explicit user constraints the subagent must preserve.' },
      wait: { type: 'boolean', description: 'Default true: after DSH accepts the dispatch, wait for this delegation revision to settle. false returns "delegated" after acceptance; the report arrives later as a message.' },
      timeout_ms: { type: 'number', description: `Absolute post-acceptance wait limit in milliseconds: an integer from ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}, default ${defaultHardTimeoutMs} ms unless overridden by this workflow's frozen settings. Child startup and message delivery are outside this limit. The separate idle timeout (configured default ${defaultIdleTimeoutMs} ms; also overridable by frozen settings) pauses while the child is running and restarts when it becomes idle.` },
      expected_revision: { type: 'number', description: 'Optional task mutation revision from workflow_task read/graph. Rejects a dispatch if the plan changed meanwhile.' },
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
      const role = workflowRole(args.role)
      const parentSession: Session = parent.session
      deps.assertAvailable?.(parentSession)
      const live = deps.workflow.forSession(parentSession)
      if (args.task_id === undefined && args.expected_revision !== undefined) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', 'expected_revision requires task_id: a newly created task has no prior revision to compare. Omit expected_revision when creating a task, or supply an existing task_id from read/graph.', { field: 'expected_revision', requires: 'task_id', actual: args.expected_revision })
      const existing = args.task_id === undefined ? undefined : requireTask(live.state, text(args.task_id, 'task_id', 256))
      if (existing !== undefined && [args.dependencies, args.subject, args.steps].some(value => value !== undefined)) {
        throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `Dispatch of existing task ${existing.taskId} cannot replace dependencies, subject or steps. Use workflow_task(action="update", task_id="${existing.taskId}") before dispatch; no parameters are silently ignored.`, { task_id: existing.taskId, fields: ['dependencies', 'subject', 'steps'].filter(field => (args as Record<string, unknown>)[field] !== undefined) })
      }
      if (args.prompt === undefined && existing !== undefined && existing.prompt === undefined) throw new WorkflowError('WORKFLOW_MISSING_PROMPT', `Task ${existing.taskId} has no saved prompt (legacy task). Supply prompt in send_to_agent, or save it with workflow_task(action="update", task_id="${existing.taskId}", prompt=...).`, { task_id: existing.taskId, field: 'prompt' })
      let prompt = text(args.prompt ?? existing?.prompt, 'prompt', MAX_PROMPT)
      let context = args.context === undefined ? existing?.context : text(args.context, 'context', MAX_CONTEXT)
      const expectedRevision = args.expected_revision === undefined ? undefined : workflowInteger(args.expected_revision, 'expected_revision', 1, Number.MAX_SAFE_INTEGER)

      // Fail before creating or mutating any durable workflow state when the
      // frozen route cannot run in this deployment. The same route resolves
      // below for child creation; checking it here keeps a misrouted dispatch
      // from reserving bindings and tasks it can never use.
      ensureRouteRegistered(
        deps.llm,
        childAgentOptions(live.state.projection().meta?.settings, deps.config.specialistModel),
      )

      const resolveTask = (): TaskSnapshot => {
        if (args.task_id !== undefined) {
          const taskId = text(args.task_id, 'task_id', 256)
          const current = requireTask(live.state, taskId)
          if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new WorkflowError('WORKFLOW_TASK_CHANGED', `Task ${taskId} changed: expected revision ${expectedRevision}, actual revision ${current.revision}. Read the updated plan and retry with its revision.`, { task_id: taskId, expected_revision: expectedRevision, actual_revision: current.revision })
          return current
        }
        const dependencies = workflowTaskIds(args.dependencies, 'dependencies')
        for (const [index, dependency] of dependencies.entries()) requireTask(live.state, dependency, `dependencies[${index}]`)
        return {
          version: AUTOREPORT_SCHEMA_VERSION,
          taskId: live.state.nextTaskId(),
          subject: subjectFromPrompt(prompt, args.subject),
          role,
          dependencies,
          status: 'pending',
          revision: 1,
          steps: taskSteps(args.steps),
          scopes: [roleToScope(role)],
          prompt,
          ...(context === undefined ? {} : { context }),
        }
      }
      let task = resolveTask()
      ensureTaskDispatchable(task, role, live.state)
      ensureRoleAvailable(role, live.state)
      const settings = live.state.projection().meta?.settings
      const hardTimeoutMs = normalizeTimeout(args.timeout_ms, settings?.delegationWaitTimeoutMs ?? defaultHardTimeoutMs)
      const idleTimeoutMs = normalizeTimeout(undefined, settings?.delegationIdleTimeoutMs ?? defaultIdleTimeoutMs)

      const child = await deps.resident?.ensure(parent, role, exec.signal)
      exec.signal.throwIfAborted()
      deps.assertAvailable?.(parentSession)
      if (child?.status === 'running') throw new WorkflowError('WORKFLOW_ROLE_BUSY', `Role ${role} specialist ${child.id} is still running or draining its previous turn. Wait for it to become idle before dispatching; no new revision was created.`, { role, child_session_id: String(child.id), activity: child.status })
      // Another call may have reserved this role or minted a task while
      // provisioning awaited. Revalidate before any dispatch mutation.
      task = resolveTask()
      if (args.prompt === undefined) prompt = text(task.prompt, 'prompt', MAX_PROMPT)
      if (args.context === undefined) context = task.context
      ensureTaskDispatchable(task, role, live.state)
      ensureRoleAvailable(role, live.state)
      const taskId = task.taskId
      const revision = nextAttempt(task, live)
      if (args.task_id === undefined) deps.workflow.commit(parentSession, 'autoreport/task', task)

      let binding = live.state.bindingForRole(role)
      let firstStart = binding === undefined || binding.provisioning === 'failed'
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

      let dispatched: DelegationSnapshot = {
        version: AUTOREPORT_SCHEMA_VERSION,
        taskId,
        delegationRevision: revision,
        role,
        childSessionId: binding.childSessionId,
        phase: 'dispatched',
        dispatchedAt: now(),
        dependencyVersions: dependencyVersions(live.state, task),
      }
      deps.workflow.commit(parentSession, 'autoreport/delegation', dispatched)
      if (task.status !== 'running' || task.latestDelegationRevision !== revision) {
        const { staleReason: _stale, ...freshTask } = task
        deps.workflow.commit(parentSession, 'autoreport/task', {
          ...freshTask,
          version: AUTOREPORT_SCHEMA_VERSION,
          status: 'running',
          revision: task.revision + 1,
          latestDelegationRevision: revision,
          prompt,
          ...(context === undefined ? {} : { context }),
        })
      }

      let bound = binding
      const briefing = (includeHandoff: boolean): ContentBlock[] => [{
        type: 'text',
        text: taskBriefing(
          task,
          revision,
          prompt,
          context,
          includeHandoff ? roleHandoffText(live.state.projection(), role) : undefined,
        ),
      }]
      let acceptedMessageId: string
      let rebindAttempted = false
      try {
        const deliver = async (): Promise<string> => {
          if (firstStart) {
            const agentOptions = childAgentOptions(settings, deps.config.specialistModel)
            const accepted = await deps.subagents.startContinuable({
              provider: 'spawn',
              label: `AutoReport ${role}`,
              childId: bound.childSessionId,
              request: {
                prompt: briefing(true),
                parent,
                ...(agentOptions === undefined ? {} : { agentOptions }),
                maxDepth: 1,
                persona: persona(role),
                toolFilter: residentToolFilter(role, new Set(DSH_ROLE_ESCAPE_TOOL_NAMES.filter(name =>
                  parent.ctx?.tools.get(name, parent) !== undefined))),
              },
              signal: exec.signal,
            })
            deps.workflow.roleRegistry.markActive(bound.childSessionId)
            const active: RoleBindingSnapshot = { ...bound, provisioning: 'active' }
            deps.workflow.commit(parentSession, 'autoreport/role-binding', active)
            bound = active
            binding = active
            firstStart = false
            return String(accepted.messageId)
          }
          try {
            const source: CoordinatorMessageSource = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id, taskId, delegationRevision: revision }
            const residentMessage = await deps.resident?.deliver(
              parent,
              bound.childSessionId,
              briefing(false),
              source,
              exec.signal,
            )
            if (residentMessage !== undefined) return residentMessage
            return await deps.deliverChild(parent, bound.childSessionId, briefing(false), source, exec.signal)
          } catch (error: unknown) {
            if (!rebindAttempted && isNotResumable(error)) {
              rebindAttempted = true
              const previousBinding = bound
              deps.workflow.commit(parentSession, 'autoreport/role-binding', { ...bound, provisioning: 'failed' })
              const newChild = mintChild()
              const reservation: RoleBindingSnapshot = {
                version: AUTOREPORT_SCHEMA_VERSION,
                role,
                childSessionId: newChild,
                parentSessionId: parent.id,
                workflowId: live.state.projection().meta?.workflowId ?? String(parent.id),
                provisioning: 'reserved',
                supersedes: previousBinding.childSessionId,
              }
              deps.workflow.commit(parentSession, 'autoreport/role-binding', reservation)
              if (deps.workflow.roleRegistry.lookup(previousBinding.childSessionId) !== undefined) {
                deps.workflow.roleRegistry.rebind(role, previousBinding.childSessionId, reservation)
              } else {
                deps.workflow.roleRegistry.registerReserved(reservation)
              }
              bound = reservation
              binding = reservation
              firstStart = true
              dispatched = {
                ...dispatched,
                childSessionId: reservation.childSessionId,
              }
              deps.workflow.commit(parentSession, 'autoreport/delegation', dispatched)
              return deliver()
            }
            throw error
          }
        }
        acceptedMessageId = await deliver()
      } catch (error: unknown) {
        if (bound.provisioning === 'reserved') {
          deps.workflow.roleRegistry.revoke(bound.childSessionId)
          deps.workflow.commit(parentSession, 'autoreport/role-binding', { ...bound, provisioning: 'failed' })
        }
        const currentAttempt = live.state.delegationAt(taskId, revision)
        if (isOpenDelegation(currentAttempt)) deps.workflow.commit(parentSession, 'autoreport/delegation', {
          ...currentAttempt,
          phase: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          settledAt: now(),
        })
        const latestTask = live.state.getTask(taskId)
        if (isOpenDelegation(currentAttempt)
          && latestTask !== undefined
          && (latestTask.latestDelegationRevision === revision || latestTask.latestDelegationRevision === undefined)) {
          const { blockedReason: _blocked, failedReason: _failed, ...rest } = latestTask
          deps.workflow.commit(parentSession, 'autoreport/task', {
            ...rest,
            status: 'failed',
            revision: latestTask.revision + 1,
            failedReason: error instanceof Error ? error.message : String(error),
          })
        }
        if (isOpenDelegation(currentAttempt)) live.waiters.settle(delegationKey(taskId, revision), { status: 'failed', response: error instanceof Error ? error.message : String(error) })
        throw error
      }

      const latest = live.state.delegationAt(taskId, revision)
      if (latest?.phase === 'dispatched') {
        const waiting: DelegationSnapshot = {
          ...latest,
          acceptedMessageId,
          phase: 'waiting_for_child',
        }
        deps.workflow.commit(parentSession, 'autoreport/delegation', waiting)
      }
      const wait = args.wait !== false
      if (!wait) {
        return {
          status: 'delegated',
          task_id: taskId,
          delegation_revision: revision,
          message_id: acceptedMessageId,
        }
      }

      // `startContinuable()` only waits for inbox acceptance. A very fast child
      // may have reported before this tool reaches its local waiter, so read the
      // durable projection first instead of sleeping until a timeout.
      const key = delegationKey(taskId, revision)
      const outcome = terminalOutcome(live.state.delegationAt(taskId, revision))
        ?? await live.waiters.wait(key, {
          childSessionId: String(bound.childSessionId),
          idleTimeoutMs,
          hardTimeoutMs,
        }, exec.signal)
      if (outcome.status === 'timed_out') {
        const current = live.state.delegationAt(taskId, revision)
        return {
          ...resultFromOutcome(taskId, revision, outcome),
          execution_pending: isOpenDelegation(current),
          delegation_phase: current?.phase ?? 'unknown',
          response: `Waiting expired after idle ${idleTimeoutMs}ms or hard ${hardTimeoutMs}ms; this does not cancel execution or create a new revision. Await the report, or cancel, reopen and redispatch to change unfinished work.`,
        }
      }
      return resultFromOutcome(taskId, revision, outcome)
    },
    presentCall: args => genericCall(`send_to_agent ${String(args.role)}`, args.subject ?? args.role),
  })
}

export const name = 'autoreport-send-to-agent'
export const inject = ['tools', 'subagents', 'autoreportWorkflow', 'llm']

/**
 * Register the `send_to_agent` usage policy.
 *
 * The master dsh convention keeps tool guidance beside the tool instead of in
 * the deployment persona, so this section ships with the tool module that owns
 * the dispatch contract. Registering it in the preset scope is this plugin's
 * equivalent of the harness's render-time visibility gate: a child inherits
 * the section registration but sees text only when its tool remains visible.
 * @param ctx - The `autoreport` preset scope.
 * @returns the exact Cordis effect disposer.
 */
export function installSendToAgentGuidance(ctx: Context): () => void {
  return ctx.systemPrompt.section({
    name: SEND_TO_AGENT_SECTION,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ scope }) => ctx.tools.get('send_to_agent', scope) === undefined ? '' : SEND_TO_AGENT_SYSTEM_PROMPT,
  })
}

/** Register `send_to_agent` in the AutoReport Main preset scope. */
export function apply(ctx: Context): void {
  installSendToAgentGuidance(ctx)
  ctx.tools.register(createSendToAgentTool({
    subagents: ctx.subagents,
    resident: {
      ensure: (parent, role, signal) => ctx.autoreportWorkflow.ensureResidentRole(parent, role, signal),
      deliver: (parent, childSessionId, content, source, signal) =>
        ctx.autoreportWorkflow.deliverResidentChild(parent, childSessionId, content, source, signal),
    },
    deliverChild: (parent, childSessionId, content, source, signal) =>
      ctx.autoreportWorkflow.deliverChild(parent, childSessionId, content, source, signal),
    workflow: ctx.autoreportWorkflow,
    assertAvailable: session => ctx.autoreportWorkflow.coordinator.assertAvailable(session),
    config: ctx.autoreportWorkflow.config,
    llm: ctx.llm,
  }))
}
