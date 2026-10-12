import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type AgentCancelCause, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import {
  childSessionMeta,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentError,
  type SubagentInterruptAuthority,
} from '@deepseek-ai/dsh-subagent'
import { installCancellationAdapters } from './cancellation.js'
import { WorkflowCoordinator } from './workflow/coordinator.js'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import {
  ensureSubagentDescriptor,
  residentDescriptor,
  residentToolFilter,
} from './subagent-descriptor.js'
import type { Config, ReportLanguage } from './config.js'
import type { CoordinatorMessageSource, SubagentReportMessageSource } from './messages.js'
import { AUTOREPORT_MAIN_PRESET, isAutoReportMainSession } from './membership.js'
import { emptyArtifactFoldState, foldArtifact, type ArtifactCaller, type ArtifactFoldState } from './artifacts/observer.js'
import {
  AUTOREPORT_SCHEMA_VERSION,
  type AutoReportRecordMap,
  type AutoReportRecordType,
  type DelegationSnapshot,
  type WorkflowMetaSnapshot,
} from './workflow/events.js'
import { delegationKey, isOpenDelegation, parseWorkflowReportContent } from './workflow/protocol.js'
import { installRoutedReportTool } from './tools/report-router.js'
import { allSpecialistRoles, type AutoReportRole, type SpecialistRole } from './roles.js'
import { loadSpecialistPersona } from './personas.js'
import { WorkflowState, type WorkflowProjection } from './workflow/service.js'
import { RoleRegistry } from './workflow/role-registry.js'
import { WaiterRegistry } from './workflow/waiters.js'
import {
  appendWorkflowEvent,
  readWorkflowLog,
  seedWorkflowLog,
  workflowLogPath,
  type WorkflowLogLocation,
  type WorkflowRecord,
} from './workflow/store.js'
import { observeWorkflowMessage, recoverWorkflowReports } from './workflow/report-observer.js'
import { applyRoleSandbox } from './policy/sandbox-roots.js'
import type { ReportSkillLanguage } from './skills-preset.js'
import { ensureInitialized, switchReportLanguage } from './workspace/init.js'
import type { WorkspaceLanguageStore } from './workspace/command.js'
import { detectPythonEnvironments, missingAnalysisPackages, type PythonDetectOptions } from './python-detect.js'
import { detectMineruStatus } from './mineru-status.js'
import {
  AUTOREPORT_SETTINGS_NAMESPACE,
  AUTO_REPORT_USER_SETTINGS_SCHEMA,
  validatePythonExecutableSetting,
  autoReportUserSettingsBase,
  childAgentOptions,
  resolveWorkflowSettings,
  type AutoReportUserSettings,
  type WorkflowSettingsSnapshot,
} from './settings.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AutoReport workflow state and synchronous role authorization. */
    autoreportWorkflow: AutoReportWorkflowRuntime
  }
}

const DEFAULT_WAIT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
/** Distinguish task-scoped stops from whole specialist conversation stops. */
const TASK_CANCEL_REASON = 'AutoReport task cancelled'

const DEFAULT_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: DEFAULT_WAIT_MS,
  delegationIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
}

/** Per-parent live synchronization state. Durable facts remain in the Session log. */
export interface ParentWorkflowRuntime {
  readonly state: WorkflowState
  readonly waiters: WaiterRegistry
}

interface PlotterModelRoute {
  readonly provider: string
  readonly model: string
}

/** Resolve the route selected for this exact prompt/request assembly. */
function plotterModelRoute(
  ctx: Context,
  child: Agent,
  variables: Readonly<Record<string, string | undefined>>,
): PlotterModelRoute | undefined {
  // DSH's model-selection assembly hook snapshots the selected route into
  // these variables before the request config is built. Prefer that snapshot
  // so a picker change cannot race the route metadata lookup.
  if (typeof variables['provider'] === 'string' && typeof variables['model'] === 'string') {
    return { provider: variables['provider'], model: variables['model'] }
  }

  // The Session projection covers a pending selection when no assembly hook
  // supplies the route. The request header and Agent options are fallbacks.
  const projections = ctx.get('sessionProjections') as {
    stateOf?: (session: Session, key: string) => unknown
  } | undefined
  const selectionState = projections?.stateOf?.(child.session, 'modelSelection') as {
    pending?: { provider?: unknown; model?: unknown } | null
  } | undefined
  const pending = selectionState?.pending
  if (typeof pending?.provider === 'string' && typeof pending.model === 'string') {
    return { provider: pending.provider, model: pending.model }
  }

  // Match DSH's read_image route resolution when no new selection is pending.
  const requestRoute = child.session.requestHeader()?.config
  const provider = requestRoute?.provider ?? child.options.provider
  const model = requestRoute?.model ?? child.options.model
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

/** Add or remove the visual-review section for the route entering each step. */
function installPlotterImageReviewPrompt(ctx: Context, child: Agent): void {
  const tools = ctx.get('tools') as { get?: (name: string, scope?: Agent) => unknown } | undefined
  const llm = ctx.get('llm') as {
    resolveModelInfo?: (
      provider: string,
      model: string,
      signal?: AbortSignal,
    ) => Promise<{ inputModalities?: readonly string[] }>
  } | undefined
  if (tools?.get?.('read_image', child) === undefined || llm?.resolveModelInfo === undefined) return

  // Capabilities are stable for one exact provider/model pair. A model picker
  // route change gets a fresh lookup; unknown metadata stays non-mandatory.
  const imageCapability = new Map<string, boolean>()
  const sectionName = 'autoreport:plot-image-review'
  const sectionText = '## Visual review of final figures\n\nBefore reporting success, use read_image to inspect each final figure at its rendered size. Use your judgment to correct any visible problems.'

  ctx.on('system-prompt/assemble', async (_assembly, assemblyContext, next) => {
    const assembly = await next()
    const signal = assemblyContext.signal
    signal?.throwIfAborted()
    const route = plotterModelRoute(ctx, child, assembly.variables)
    let canReview = false
    if (route !== undefined) {
      const key = `${route.provider}\u0000${route.model}`
      const cached = imageCapability.get(key)
      if (cached !== undefined) {
        canReview = cached
      } else {
        try {
          const info = await llm.resolveModelInfo!(route.provider, route.model, signal)
          signal?.throwIfAborted()
          canReview = info.inputModalities?.includes('image') === true
          imageCapability.set(key, canReview)
        } catch {
          signal?.throwIfAborted()
          imageCapability.set(key, false)
        }
      }
    }
    return {
      ...assembly,
      sections: [
        ...assembly.sections.filter(section => section.name !== sectionName),
        ...(canReview ? [{ name: sectionName, text: sectionText }] : []),
      ],
    }
  })
}

/** Construction options beyond configuration (host wiring / tests). */
export interface RuntimeOptions {
  /** Harness home override for AutoReport-managed environment files. */
  readonly settingsHome?: string
  /** Interpreter discovery overlay; tests disable conda/PATH scans. */
  readonly pythonDetect?: PythonDetectOptions
  /** Running dsh version override; absent reads the launcher anchor (tests pin it). */
  readonly runningDshVersion?: string
}

/**
 * Host-plane AutoReport runtime keyed by Main Session. The service owns no
 * second persistence or queue: it folds committed Session events and keeps
 * only synchronous authorization and optional in-process waiters.
 */
export default class AutoReportWorkflowRuntime extends Service {
  /** Dependency scheduling and independent task waits. */
  readonly coordinator: WorkflowCoordinator
  /** Global child-id authorization used during unpublished child setup. */
  readonly roleRegistry = new RoleRegistry()
  /** Validated plugin configuration used by tools and first-turn initialization. */
  readonly config: Config
  /** Harness home override for AutoReport-managed environment files. */
  readonly settingsHome: string | undefined
  private readonly parents = new Map<string, ParentWorkflowRuntime>()
  // Retain admitted parent sessions for workflow/artifact ownership, but do
  // not use historical admission as current Main authorization: the effective
  // preset may change while a root is still blank.
  private readonly mainSessions = new Map<string, Session>()
  private readonly artifactFolds = new Map<string, ArtifactFoldState>()
  /** Main ids whose post-append initialization retry is already queued. */
  private readonly pendingPostCommitInitialization = new Set<string>()
  /** Resident AutoReport children, grouped by their owning MAIN session. */
  private readonly residentHandles = new Map<string, Map<SpecialistRole, AgentHandle>>()
  /** Published agents indexed independently of the scoped Agent registry. */
  private readonly liveAgents = new Map<string, Agent>()
  /** Execution identity captured from the exact coordinator message delivered to each resident. */
  private readonly activeChildDelegations = new Map<string, { taskId: string; delegationRevision: number }>()
  /** Stop background messages from waking MAIN until a new foreground input. */
  private readonly stoppedParents = new Set<string>()
  /** Cancels already accounted synchronously must not cancel a later redispatch at turn/end. */
  private readonly accountedCancels = new WeakSet<Agent>()
  /** Coalesce first-dispatch provisioning for one role. */
  private readonly residentProvisioning = new Map<string, Map<SpecialistRole, Promise<Agent | undefined>>>()
  /** Current DSH-resolved user defaults; each new workflow snapshots this once. */
  private userSettingsSource: () => AutoReportUserSettings
  /** Settings provider when one is mounted; absent in settings-less test contexts. */
  private settingsService: SettingsForms | undefined
  /** Last user settings this runtime observed, for diffing one change into a switch. */
  private previousUserSettings: AutoReportUserSettings | undefined

  /**
   * Create the host runtime and observe committed report messages.
   * @param ctx - host context carrying Session events.
   * @param config - resolved plugin configuration.
   * @param options - host wiring and test overrides.
   */
  constructor(ctx: Context, config: Config = DEFAULT_CONFIG, options: RuntimeOptions = {}) {
    super(ctx, 'autoreportWorkflow')
    this.config = config
    this.coordinator = new WorkflowCoordinator(ctx, this)
    this.settingsHome = options.settingsHome
    const dshHome = options.settingsHome ?? resolveDshHome()
    // Keep this as composition state: the settings card can show readiness,
    // while the token value itself never enters the browser-facing snapshot.
    const mineruStatus = detectMineruStatus()
    const userSettingsBase = autoReportUserSettingsBase(
      config,
      detectPythonEnvironments({
        ...(config.workspaceRoot === undefined ? {} : { workspace: config.workspaceRoot }),
        dshHome,
        ...options.pythonDetect,
      }),
      mineruStatus,
    )
    this.userSettingsSource = () => userSettingsBase
    // RC2 validates persistent Config writes through the owning plugin fiber.
    // Keep interpreter checks at this boundary before a profile patch is saved.
    ctx.on('internal/config', function (_raw: unknown, next: () => unknown): unknown {
      const candidate = next()
      if (this !== ctx.fiber) return candidate
      const values = AUTO_REPORT_USER_SETTINGS_SCHEMA(candidate as AutoReportUserSettings)
      validatePythonExecutableSetting({ ...userSettingsBase, ...values }, dshHome)
      return candidate
    })
    ctx.inject(['settings'], sctx => {
      this.settingsService = sctx.settings
      sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
      this.userSettingsSource = () => {
        const value = sctx.settings.describe().find(row => row.ns === AUTOREPORT_SETTINGS_NAMESPACE)?.value
        return { ...userSettingsBase, ...(value as Partial<AutoReportUserSettings> | undefined) }
      }
      this.observeUserSettingsChange()
      sctx.on('settings/document-updated', ns => {
        if (ns === AUTOREPORT_SETTINGS_NAMESPACE) this.observeUserSettingsChange()
      })
    })
    ctx.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined) {
        const recordDispatch = (message: { source: { kind: string }; content?: readonly ContentBlock[] }): void => {
          if (this.roleRegistry.lookup(session.id) === undefined) return
          let execution: { taskId: string; delegationRevision: number } | undefined
          if (message.source.kind === 'coordinator') {
            const source = message.source as CoordinatorMessageSource
            execution = { taskId: source.taskId, delegationRevision: source.delegationRevision }
          } else {
            // The first resident prompt is created by DSH's startContinuable API,
            // which owns its message source. Recover the explicit identity already
            // present in the plugin-authored briefing, then verify it against the
            // durable attempt before using it for any settlement.
            const text = message.content?.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n') ?? ''
            const match = /^AutoReport task (task-[A-Za-z0-9._-]{1,127}), delegation revision ([1-9][0-9]*)\s*$/mu.exec(text)
            if (match?.[1] !== undefined && match[2] !== undefined && Number.isSafeInteger(Number(match[2]))) {
              execution = { taskId: match[1], delegationRevision: Number(match[2]) }
            }
          }
          if (execution === undefined) return
          const attempt = this.workflowForChild(session.id)?.runtime.state.delegationAt(execution.taskId, execution.delegationRevision)
          if (attempt?.childSessionId !== session.id || !isOpenDelegation(attempt)) return
          this.activeChildDelegations.set(String(session.id), execution)
        }
        if (event.type === 'user/message') recordDispatch(event.data)
        if (event.type === 'agent/inbox/spliced') {
          for (const message of event.data.inserted) recordDispatch(message)
        }
        if (event.type === 'turn/end') {
          const reason = event.data.reason
          if (reason?.kind === 'aborted') {
            const cause = reason.reason
            const agent = this.liveAgents.get(String(session.id))
            const accounted = agent !== undefined && this.accountedCancels.delete(agent)
            if (!accounted && (cause.kind !== 'hook' || cause.reason !== TASK_CANCEL_REASON)) {
              this.cancelChildDelegations(session.id, 'subagent turn interrupted')
            }
          } else {
            const detail = reason?.kind === 'error'
              ? `turn failed: ${reason.error.message}`
              : 'turn ended without a valid workflow report'
            this.notifyChildTurnFailure(session, detail)
          }
          this.activeChildDelegations.delete(String(session.id))
        }
      }
      // Coexistence gate (PLAN.md compatibility invariant): sessions that did
      // not select AutoReport stay stock — no state, no initialization, no
      // observation. "Unknown" means "not our session", never "invalid one".
      if (!this.ownsSession(session)) return
      // Artifact facts come from BOTH planes: Main's own Outline writes and
      // specialist children's role-scoped mutations. Fold every owned stream;
      // the caller resolution below decides who is authorized to have produced.
      this.foldArtifacts(session, event)
      // A specialist child whose turn ended in an error never reaches its
      // report_workflow call and never settles its continuable activation, so
      // nothing else folds the failure: the delegation would sit in
      // `waiting_for_child` until the idle timeout, and a wait=false Main would
      // never hear about it at all. Deliver a runtime settlement notice onto
      // the owning parent; the observer's existing `subagent-settled` fold
      // turns it into a failed delegation, settles waiters, and surfaces the
      // error to Main in both wait modes.
      // Continuable children have a parent; AutoReport workflow facts live only on Main.
      if (session.header.parentSession !== undefined) return
      // The workflow state is NOT folded from this stream: AutoReport records
      // live in its own log (`src/workflow/store.ts`), and `commit()` is what
      // applies one. Nothing here may read `autoreport/*` out of the session.
      const live = this.forSession(session)
      if (event.type === 'turn/start' && this.isInitialTurnStart(session)) {
        this.initializeAfterAppend(session)
      }
      if (event.type === 'user/message'
        && event.data.source.kind === 'user'
        && this.isInitialUserMessage(session)) {
        this.initializeAfterAppend(session)
      }
      observeWorkflowMessage(session, event, {
        state: live.state,
        waiters: live.waiters,
        commit: (type, data) => this.commit(session, type, data),
      })
    }, { global: true })
    ctx.on('agent/status', ({ agent, status }) => {
      const owner = this.workflowForChild(agent.id)
      if (owner === undefined) return
      owner.runtime.waiters.noteChildActivity(String(agent.id), status)
      if (status === 'idle') void this.coordinator.requestPump(owner.session)
    }, { global: true })
    ctx.on('agent/created', ({ agent }) => {
      this.liveAgents.set(String(agent.id), agent)
      // Load Main's durable role bindings before later created listeners (or
      // child session events) need to resolve the resident identities. The
      // host finishes role-specific tool composition before it asks us to
      // materialize those bindings as live Agents.
      if (isAutoReportMainSession(agent.session)) this.forSession(agent.session)
      return undefined
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.coordinator.forgetParent(agent)
      this.activeChildDelegations.delete(String(agent.id))
      this.liveAgents.delete(String(agent.id))
      this.forgetResidentAgent(agent)
    }, { global: true })
    ctx.effect(() => async () => {
      await this.coordinator.dispose()
      await this.disposeResidentRoles()
    }, 'autoreport.residentRoles()')
    const existingAgents = ctx.get('agents') as { list?: () => Agent[] } | undefined
    for (const agent of existingAgents?.list?.() ?? []) {
      this.liveAgents.set(String(agent.id), agent)
      if (isAutoReportMainSession(agent.session)) this.forSession(agent.session)
    }
    installCancellationAdapters(ctx, {
      owns: agent => isAutoReportMainSession(agent.session) || this.roleRegistry.lookup(agent.id) !== undefined,
      cancelling: (agent, cause) => this.onAgentCancelling(agent, cause),
      interrupt: (childId, authority) => this.interruptResident(childId, authority),
    })
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (messages.some(message => message.source.kind === 'user')) this.stoppedParents.delete(String(agent.id))
      return next()
    }, { global: true })
  }

  private onAgentCancelling(agent: Agent, cause: AgentCancelCause): void {
    this.accountedCancels.add(agent)
    if (cause.kind === 'disposed') return
    if (cause.kind === 'hook' && cause.reason === TASK_CANCEL_REASON) return
    if (this.roleRegistry.lookup(agent.id) !== undefined) {
      this.cancelChildDelegations(agent.id, `subagent interrupted by ${cause.kind}`)
      return
    }
    if (!isAutoReportMainSession(agent.session)) return
    this.coordinator.pause(agent.session)
    this.stoppedParents.add(String(agent.id))
    const live = this.forSession(agent.session)
    const childIds = new Set<SessionId>()
    for (const task of live.state.projection().tasks.values()) {
      const attempt = live.state.currentDelegation(task.taskId)
      if (isOpenDelegation(attempt)) childIds.add(attempt.childSessionId)
    }
    for (const handle of this.residentHandles.get(String(agent.id))?.values() ?? []) childIds.add(handle.agent.id)
    for (const childId of childIds) this.stopChild(childId, { kind: 'parent' })
  }

  private interruptResident(childId: SessionId, authority: SubagentInterruptAuthority): boolean {
    const child = this.residentChild(childId)
    if (child === undefined) return false
    const parentId = child.session.header.parentSession
    const authorized = authority.kind === 'user'
      ? parentId === authority.parentSessionId
      : this.liveAgents.get(String(authority.agent.id)) === authority.agent && parentId === authority.agent.id
    if (!authorized) throw new SubagentError('resident subagent does not belong to this caller', 'UNAUTHORIZED')
    this.stopChild(childId, { kind: authority.kind === 'user' ? 'user' : 'parent' })
    return true
  }

  /**
   * Stop one bound specialist without releasing its Session or role binding.
   * @param childId - bound specialist to stop.
   * @param cause - cause recorded by the Agent loop.
   */
  stopChild(childId: SessionId, cause: AgentCancelCause = { kind: 'parent' }): void {
    this.cancelChildDelegations(childId, `subagent interrupted by ${cause.kind}`)
    const child = this.residentChild(childId)
    if (child !== undefined) child.cancel(cause, { keepInbox: true })
    else {
      const parentId = this.roleRegistry.lookup(childId)?.binding.parentSessionId
      if (parentId !== undefined) this.ctx.get('subagents')?.interrupt(childId, { kind: 'user', parentSessionId: parentId })
    }
  }

  /**
   * Stop an active task or remove its still-queued briefing without cancelling
   * other tasks bound to the same specialist.
   * @param attempt - task delegation whose durable state was just cancelled.
   */
  stopTaskExecution(attempt: DelegationSnapshot): void {
    if (!isOpenDelegation(attempt)) return
    const child = this.residentChild(attempt.childSessionId) ?? this.liveAgents.get(String(attempt.childSessionId))
    if (child === undefined) {
      this.stopChild(attempt.childSessionId)
      return
    }
    if (attempt.acceptedMessageId !== undefined && child.inbox.remove(attempt.acceptedMessageId as MessageId)) return
    child.cancel({ kind: 'hook', reason: TASK_CANCEL_REASON }, { keepInbox: true })
  }

  private cancelChildDelegations(childId: SessionId, reason: string): void {
    const owner = this.workflowForChild(childId)
    if (owner === undefined) return
    for (const task of owner.runtime.state.projection().tasks.values()) {
      const attempt = owner.runtime.state.currentDelegation(task.taskId)
      if (!isOpenDelegation(attempt) || attempt.childSessionId !== childId) continue
      this.commit(owner.session, 'autoreport/delegation', { ...attempt, phase: 'cancelled', reason, settledAt: Date.now() })
      const { blockedReason: _blocked, failedReason: _failed, ...rest } = task
      this.commit(owner.session, 'autoreport/task', { ...rest, status: 'cancelled', revision: task.revision + 1 })
      owner.runtime.waiters.settle(delegationKey(task.taskId, attempt.delegationRevision), { status: 'cancelled' })
    }
  }

  /** Resolve the currently live resident child for direct UI/tool routing. */
  residentChild(childSessionId: SessionId): Agent | undefined {
    for (const byRole of this.residentHandles.values()) {
      for (const handle of byRole.values()) {
        if (handle.agent.id === childSessionId) return handle.agent
      }
    }
    return undefined
  }

  /** Published Agent identity for execution diagnostics, including manager-owned children. */
  liveAgent(sessionId: SessionId): Agent | undefined {
    return this.liveAgents.get(String(sessionId))
  }

  /** Ensure one fixed role has a durable, idle child Session and live Agent. */
  async ensureResidentRole(
    parent: Agent,
    role: SpecialistRole,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Agent | undefined> {
    const parentId = String(parent.id)
    let byRole = this.residentProvisioning.get(parentId)
    if (byRole === undefined) {
      byRole = new Map()
      this.residentProvisioning.set(parentId, byRole)
    }
    const existing = byRole.get(role)
    if (existing !== undefined) return existing
    const operation = this.provisionResidentRole(parent, role, signal)
    byRole.set(role, operation)
    try {
      return await operation
    } finally {
      if (byRole.get(role) === operation) byRole.delete(role)
      if (byRole.size === 0) this.residentProvisioning.delete(parentId)
    }
  }

  /** Ensure all four fixed subagents exist after an explicit activation. */
  async ensureResidentRoles(parent: Agent, signal?: AbortSignal): Promise<void> {
    await Promise.all(allSpecialistRoles().map(role => this.ensureResidentRole(parent, role, signal)))
  }

  /** Restore only the specialist roles that already have durable bindings. */
  async restoreResidentRoles(parent: Agent): Promise<void> {
    if (!isAutoReportMainSession(parent.session)) return
    const bindings = [...this.forSession(parent.session).state.projection().bindingsByRole.values()]
      .filter(binding => binding.provisioning !== 'failed')
    await Promise.all(bindings.map(async binding => {
      try {
        await this.ensureResidentRole(parent, binding.role)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(
          'AutoReportDSH: could not restore resident %s for MAIN %s: %s',
          binding.role,
          parent.id,
          message,
        )
      }
    }))
  }

  /**
   * Explicitly activate the resident subagent set. Normal report work uses
   * the lazy per-role path in send_to_agent; this method is retained for an
   * explicit activation caller.
   */
  async activateResidentRoles(parent: Agent, signal?: AbortSignal): Promise<void> {
    this.ensureMainSandbox(parent.session)
    this.maybeInitialize(parent.session)
    await this.ensureResidentRoles(parent, signal)
  }

  /**
   * Find the live Agent registry visible to a parent. Child creation belongs
   * to the parent's scoped registry so DSH can enforce structured ownership.
   */
  private agentsForParent(parent: Agent): {
    get?: (id: SessionId) => Agent | undefined
    create?: (options: object) => Promise<AgentHandle>
    resume?: (options: { resumeSessionId: SessionId; agentOptions?: Agent['options']; setup?: (ctx: Context, agent: Agent) => unknown; signal?: AbortSignal }) => Promise<AgentHandle>
    withInitiator?: <T>(agent: Agent, operation: () => T) => T
  } | undefined {
    return (parent.ctx?.get('agents') ?? this.ctx.get('agents')) as {
      get?: (id: SessionId) => Agent | undefined
      create?: (options: object) => Promise<AgentHandle>
      resume?: (options: { resumeSessionId: SessionId; agentOptions?: Agent['options']; setup?: (ctx: Context, agent: Agent) => unknown; signal?: AbortSignal }) => Promise<AgentHandle>
      withInitiator?: <T>(agent: Agent, operation: () => T) => T
    } | undefined
  }

  /** Deliver a coordinator message to a resident child without cold-resume. */
  async deliverResidentChild(
    parent: Agent,
    childSessionId: SessionId,
    content: ContentBlock[],
    source: CoordinatorMessageSource,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted()
    const child = this.residentChild(childSessionId)
    if (child === undefined || child.session.header.parentSession !== parent.id) return undefined
    const message = createUserMessage({ content, source })
    child.followup(message)
    return String(message.id)
  }

  /** Deliver a report from a resident child using DSH's normal steer relay. */
  async reportFromResident(
    child: Agent,
    content: ContentBlock[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted()
    const entry = this.roleRegistry.lookup(child.id)
    if (entry === undefined || this.residentChild(child.id) !== child) return undefined
    const parentId = entry.binding.parentSessionId
    const agents = this.ctx.get('agents') as { get?: (id: SessionId) => Agent | undefined } | undefined
    const parent = agents?.get?.(parentId)
    const execution = this.activeChildDelegations.get(String(child.id))
    const message = createUserMessage({
      content: [
        { type: 'text', text: `Background subagent ${child.id} reported:` },
        ...content,
      ],
      source: {
        kind: 'subagent-report',
        form: 'relay',
        senderSessionId: child.id,
        ...(execution === undefined ? {} : execution),
      } satisfies SubagentReportMessageSource,
    })
    if (parent !== undefined) {
      const report = parseWorkflowReportContent(content)
      const attempt = report.ok
        ? this.workflowForChild(child.id)?.runtime.state.delegationAt(report.value.task_id, report.value.delegation_revision)
        : undefined
      if (this.stoppedParents.has(String(parentId)) || attempt?.phase === 'cancelled') parent.inject(message)
      else parent.steer(message)
    } else {
      const parentSession = this.mainSessions.get(String(parentId))
      if (parentSession === undefined) {
        throw new Error('direct parent session is unavailable; report was not delivered')
      }
      // A durable resident can finish while Main has no live Activation.
      // Append the same relay message to Main's Session so its normal observer
      // folds the report and the next Main activation sees it in history.
      parentSession.append('user/message', message, { surfaceOp: 'append' })
    }
    return String(message.id)
  }

  /**
   * Deliver one host-protocol briefing onto any direct continuable child —
   * including manager-owned children this runtime does not hold resident —
   * through the official symbol-keyed delivery seam as a distinct turn.
   */
  async deliverChild(
    parent: Agent,
    childSessionId: SessionId,
    content: ContentBlock[],
    source: CoordinatorMessageSource,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    const subagents = this.ctx.get('subagents') as HostPromptDeliverer | undefined
    if (subagents === undefined) throw new Error('subagents service is unavailable; child delivery failed')
    const messageId = await subagents[deliverSubagentPrompt](parent, childSessionId, content, source, signal, 'queue')
    return String(messageId)
  }

  /** Create or resume one resident role without sending an initial prompt. */
  private async provisionResidentRole(parent: Agent, role: SpecialistRole, signal: AbortSignal): Promise<Agent | undefined> {
    const parentSession = parent.session
    const agents = this.agentsForParent(parent)
    // The assembled unit tests deliberately provide only the subagent seam;
    // leave their legacy lazy path untouched when the Agent factory is absent.
    if (agents?.get === undefined || agents.create === undefined || agents.resume === undefined) return undefined
    const live = this.forSession(parentSession)
    let binding = live.state.bindingForRole(role)
    let createdReservation = false
    if (binding === undefined || binding.provisioning === 'failed') {
      const childId = SessionId(randomUUID())
      const reservation = {
        version: AUTOREPORT_SCHEMA_VERSION,
        role,
        childSessionId: childId,
        parentSessionId: parent.id,
        workflowId: live.state.projection().meta?.workflowId ?? String(parent.id),
        provisioning: 'reserved' as const,
        ...(binding === undefined ? {} : { supersedes: binding.childSessionId }),
      }
      this.commit(parentSession, 'autoreport/role-binding', reservation)
      if (binding !== undefined && this.roleRegistry.lookup(binding.childSessionId) !== undefined) {
        this.roleRegistry.rebind(role, binding.childSessionId, reservation)
      } else {
        this.roleRegistry.registerReserved(reservation)
      }
      binding = reservation
      createdReservation = true
    } else if (this.roleRegistry.lookup(binding.childSessionId) === undefined) {
      this.roleRegistry.registerReserved(binding)
    }

    if (binding === undefined) return undefined
    const alreadyLive = agents.get(binding.childSessionId)
    if (alreadyLive !== undefined) {
      this.markResidentActive(parentSession, binding, role, alreadyLive)
      // A live child that this runtime did not create belongs to the DSH
      // continuation manager (or another owner); leave delivery on its
      // official followup/report path instead of bypassing its inbox manager.
      return alreadyLive
    }

    signal.throwIfAborted()
    // DSH resolves a delegation's route from the delegating session's LATEST
    // The route comes from the same authority the delegation path reads: the
    // FROZEN workflow snapshot. It is resolved through `routeField`, so it can
    // never carry the phantom `{}` the live user layer materializes, and a
    // workflow keeps the route it started under. DSH then resolves the child's
    // actual call config from the delegating session's latest REQUEST HEADER
    // first and only falls back to creation options
    // (`parentAgentOptionsForDelegation`), so a Main whose model was chosen at
    // request time still hands its route down. Reading `parent.options` here
    // instead produced children that died on their first step with
    // `has no provider/model`.
    const route = childAgentOptions(live.state.projection().meta?.settings, this.config.specialistModel)
    const childDepth = resolveChildDepth(parent, 1)
    const agentOptions: Agent['options'] = resolveChildAgentOptions(parent, route, childDepth)
    const persona = loadSpecialistPersona(role)
    let descriptorToolFilter: ReturnType<typeof residentToolFilter> | undefined
    const setup = async (childCtx: Context, child: Agent): Promise<void> => {
      if (child === undefined) throw new Error(`resident ${role} setup has no child agent`)
      // Master dsh moved persona/tool-filter composition into the continuation
      // providers; resident roles are created directly, so the shadow and the
      // deny-list are applied through their own seams: naming the deployment
      // persona section replaces it instead of duplicating it. The preset join
      // itself cannot be skipped: the agent factory never mounts a preset for
      // children, so without composeFrom this child's scope chain holds no
      // preset scope — the preset-plane tool names are then neither visible to
      // the role (no bash, read, or skills) nor restrictable, and
      // tools.restrict() rejects the deny-list outright.
      const joined = childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
      childCtx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: persona,
      })
      if (joined !== undefined) {
        const denied = residentToolFilter(role)
        const getScopedTool = (childCtx.tools as unknown as {
          get?: (name: string, scope?: Agent) => unknown
        }).get
        const visibleDeniedNames = new Set((denied.deny ?? []).filter(name =>
          getScopedTool === undefined || getScopedTool.call(childCtx.tools, name, child) !== undefined))
        const roleFilter = residentToolFilter(role, visibleDeniedNames)
        if ((roleFilter.deny?.length ?? 0) > 0) {
          childCtx.tools.restrict(roleFilter)
          descriptorToolFilter = roleFilter
        }
      }
      if (role === 'PLOTTING') installPlotterImageReviewPrompt(childCtx, child)
      // The parent preset is joined synchronously above, but its scoped skill
      // service is exposed through Cordis injection. Wait for that capability
      // before publishing the child so REPORT skills and the role report tool
      // are present from the first resident request.
      await childCtx.inject(['skills'], (skillCtx) => {
        skillCtx.effect(
          () => installRoutedReportTool(skillCtx, child, this.ctx, this),
          `autoreport.resident.${role}()`,
        )
      })
    }
    try {
      const persistence = this.ctx.get('sessionPersistence') as { inspect?: (id: SessionId, signal: AbortSignal) => Promise<unknown> } | undefined
      let persisted = false
      if (persistence?.inspect !== undefined) {
        try {
          await persistence.inspect(binding.childSessionId, signal)
          persisted = true
        } catch {
          persisted = false
        }
      }
      const createOrResume = (): Promise<AgentHandle> => persisted
        ? agents.resume!({ resumeSessionId: binding.childSessionId, agentOptions, setup, signal })
        : agents.create!({
            sessionId: binding.childSessionId,
            // The same metadata DSH's own driver stamps on a delegated child:
            // the parent's workspace, its live composition, and the durable
            // recursion budget a cold read resumes under.
            meta: childSessionMeta(parent, childDepth, false),
            agentOptions,
            setup,
            signal,
          } as never)
      const handle = await (agents.withInitiator === undefined
        ? createOrResume()
        : agents.withInitiator(parent, createOrResume))
      this.storeResident(parent, role, handle)
      this.markResidentActive(parentSession, binding, role, handle.agent)
      // Direct creation skips the provider that would have classified this
      // child, so the runtime writes the identity itself; a child that already
      // carries one keeps it.
      ensureSubagentDescriptor(
        handle.agent.session,
        residentDescriptor({
          role,
          route: agentOptions,
          persona,
          ...(descriptorToolFilter === undefined ? {} : { toolFilter: descriptorToolFilter }),
        }),
      )
      return handle.agent
    } catch (error: unknown) {
      if (createdReservation && this.roleRegistry.lookup(binding.childSessionId) !== undefined) {
        this.roleRegistry.revoke(binding.childSessionId)
        this.commit(parentSession, 'autoreport/role-binding', { ...binding, provisioning: 'failed' })
      }
      throw error
    }
  }

  private markResidentActive(session: Session, binding: import('./workflow/events.js').RoleBindingSnapshot, _role: SpecialistRole, _agent: Agent): void {
    if (binding.provisioning !== 'active') {
      this.commit(session, 'autoreport/role-binding', { ...binding, provisioning: 'active' })
      this.roleRegistry.markActive(binding.childSessionId)
    }
  }

  private storeResident(parent: Agent, role: SpecialistRole, handle: AgentHandle): void {
    let byRole = this.residentHandles.get(String(parent.id))
    if (byRole === undefined) {
      byRole = new Map()
      this.residentHandles.set(String(parent.id), byRole)
    }
    if (!byRole.has(role)) byRole.set(role, handle)
  }

  /** Remove the exact disposed activation while preserving its durable binding. */
  private forgetResidentAgent(agent: Agent): void {
    for (const [parentId, byRole] of this.residentHandles) {
      for (const [role, handle] of byRole) {
        if (handle.agent !== agent) continue
        byRole.delete(role)
        if (byRole.size === 0) this.residentHandles.delete(parentId)
        return
      }
    }
  }

  private async disposeResidentRoles(): Promise<void> {
    const handles = [...this.residentHandles.values()].flatMap(byRole => [...byRole.values()])
    this.residentHandles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }

  private async disposeResidentFor(parentId: SessionId): Promise<void> {
    const byRole = this.residentHandles.get(String(parentId))
    if (byRole === undefined) return
    this.residentHandles.delete(String(parentId))
    await Promise.allSettled([...byRole.values()].map(handle => handle.dispose()))
  }

  /**
   * Resolve the calling role and workspace for one observed session, using the
   * same fail-closed identity sources as the tool guard: MAIN membership or a
   * synchronous RoleRegistry entry. Unknown sessions produce nothing.
   */
  private resolveArtifactCaller(sessionId: string): ArtifactCaller | undefined {
    const main = this.mainSessions.get(sessionId)
    if (main !== undefined) {
      const root = this.config.workspaceRoot ?? main.header.cwd
      return root === undefined ? undefined : { role: 'MAIN', workspaceRoot: root }
    }
    const entry = this.roleRegistry.lookup(sessionId)
    if (entry === undefined) return undefined
    const owner = this.workflowForChild(entry.binding.childSessionId)
    const root = this.config.workspaceRoot ?? owner?.runtime.state.projection().meta?.workspaceRoot
    return root === undefined ? undefined : { role: entry.binding.role, workspaceRoot: root }
  }

  /** Fold one committed event of ANY session into artifact observations. */
  private foldArtifacts(session: Session, event: SessionEvent): void {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return
    const sessionId = String(session.id)
    const caller = this.resolveArtifactCaller(sessionId)
    if (caller === undefined) return
    let state = this.artifactFolds.get(sessionId)
    if (state === undefined) {
      state = emptyArtifactFoldState()
      this.artifactFolds.set(sessionId, state)
    }
    foldArtifact(event, caller, state, {
      sessionId,
      currentDelegationKey: childId => this.currentDelegationKey(childId),
      commit: (observedId, snapshot) => {
        // Artifacts are facts of the OWNING workflow session (PLAN §2.11):
        // Main's own mutations land on Main; a specialist child's land on its
        // binding's parent session.
        const owner = observedId === sessionId && caller.role === 'MAIN'
          ? this.mainSessions.get(sessionId)
          : this.workflowForChild(sessionId as SessionId)?.session
        if (owner === undefined) return
        this.commit(owner, 'autoreport/artifact', snapshot)
      },
    })
  }

  /** Current open attempt key for one subagent child, when one is waiting. */
  private currentDelegationKey(childSessionId: string): { taskId: string; key: string } | undefined {
    const owner = this.workflowForChild(childSessionId as SessionId)
    if (owner === undefined) return undefined
    for (const task of owner.runtime.state.projection().tasks.values()) {
      const current = owner.runtime.state.currentDelegation(task.taskId)
      if (current?.childSessionId !== childSessionId) continue
      if (!isOpenDelegation(current)) continue
      return { taskId: task.taskId, key: delegationKey(task.taskId, current.delegationRevision) }
    }
    return undefined
  }

  /**
   * Whether a live session is an AutoReport Main parent.
   * @param sessionId - candidate session id.
   */
  isMainSession(sessionId: SessionId): boolean {
    const session = this.mainSessions.get(String(sessionId))
    return session !== undefined && isAutoReportMainSession(session)
  }

  /**
   * AutoReport role bound to one session: MAIN membership or a RoleRegistry
   * child binding. Foreign sessions produce `undefined`, so the sandbox
   * override and any other role-derived policy leave them untouched.
   * @param sessionId - candidate session id.
   */
  roleFor(sessionId: string): AutoReportRole | undefined {
    const main = this.mainSessions.get(sessionId)
    if (main !== undefined && isAutoReportMainSession(main)) return 'MAIN'
    return this.roleRegistry.lookup(sessionId as SessionId)?.binding.role
  }

  /**
   * Whether one observed session belongs to this deployment: a top-level
   * session actually running the `autoreport` preset, or a continuable
   * child bound in the RoleRegistry (reserved before its publication).
   * Everything else — ordinary roots, ordinary DSH continuable children — is
   * foreign, and foreign sessions must keep their stock behavior untouched.
   * @param session - any session surfaced on the context event stream.
   */
  ownsSession(session: Session): boolean {
    if (session.header.parentSession !== undefined) {
      return this.roleRegistry.lookup(session.id) !== undefined
    }
    return isAutoReportMainSession(session)
  }

  /**
   * Resolve or cold-fold the live projection for one Main Session.
   * @param session - durable Main Session.
   * @returns parent-local projection and waiter registry.
   */
  forSession(session: Session): ParentWorkflowRuntime {
    if (session.header.parentSession !== undefined) {
      throw new Error(`AutoReport workflow state is owned by Main; refused child session ${session.id}`)
    }
    if (!isAutoReportMainSession(session)) {
      throw new Error(
        `AutoReport workflow state requires the '${AUTOREPORT_MAIN_PRESET}' preset`
        + `; refused foreign root session ${session.id}`,
      )
    }
    const existing = this.parents.get(session.id)
    if (existing !== undefined) return existing
    const created = { state: this.loadWorkflowState(session), waiters: new WaiterRegistry() }
    this.parents.set(session.id, created)
    this.mainSessions.set(String(session.id), session)
    recoverWorkflowReports(session, {
      state: created.state,
      waiters: created.waiters,
      commit: (type, data) => this.commit(session, type, data),
    })
    for (const binding of created.state.projection().bindingsByRole.values()) {
      if (binding.provisioning !== 'failed' && this.roleRegistry.lookup(binding.childSessionId) === undefined) {
        this.roleRegistry.registerReserved(binding)
      }
    }
    return created
  }

  /**
   * Pin MAIN sandbox confinement once a real turn starts. Idempotent last-wins;
   * independent of workflow initialization so `/init` alone never pins.
   * @param session - owning Main session.
   */
  private ensureMainSandbox(session: Session): void {
    if (!isAutoReportMainSession(session)) return
    const root = this.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) return
    applyRoleSandbox(session, 'MAIN', root)
  }

  /** Whether the observed user message is the first real user input. */
  private isInitialUserMessage(session: Session): boolean {
    return session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'user',
    ).length === 1
  }

  /** Whether the observed turn boundary is the first turn in this session. */
  private isInitialTurnStart(session: Session): boolean {
    return session.snapshotEvents().filter(event => event.type === 'turn/start').length === 1
  }

  /**
   * Run first-turn side effects after the current Session append has
   * published. DSH intentionally rejects re-entrant appends from a
   * `session/event` observer; direct test emitters do not have that guard, so
   * the fast path remains synchronous there.
   */
  private initializeAfterAppend(session: Session): void {
    try {
      this.ensureMainSandbox(session)
      this.maybeInitialize(session)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('session append cannot reenter')) throw error
      const id = String(session.id)
      if (this.pendingPostCommitInitialization.has(id)) return
      this.pendingPostCommitInitialization.add(id)
      queueMicrotask(() => {
        this.pendingPostCommitInitialization.delete(id)
        if (this.ownsSession(session)) this.initializeAfterAppend(session)
      })
    }
  }

  /**
   * Append one domain event and synchronously update its projection.
   * Applying twice through the Session observer is safe because mutable
   * workflow snapshots are keyed last-write-wins.
   * @param session - owning Main Session.
   * @param type - AutoReport event type.
   * @param data - whole snapshot payload.
   * @returns the committed event.
   */
  commit<T extends AutoReportRecordType>(
    session: Session,
    type: T,
    data: AutoReportRecordMap[T],
  ): WorkflowRecord<T> {
    // One step, two effects: the record becomes durable in the plugin's own log
    // and updates the live projection. Nothing observes the session stream for
    // this, so a record can never be applied twice.
    const record = appendWorkflowEvent(session, type, data, this.workflowLocation(session))
    const state = this.forSession(session).state
    const fact: WorkflowRecord = record
    const previous = fact.type === 'autoreport/task' ? state.getTask(fact.data.taskId) : undefined
    state.apply(record)
    this.coordinator.afterCommit(session, fact, previous)
    return record
  }

  /**
   * Where one session's workflow log lives: the harness home keyed by the
   * experiment workspace that owns it.
   * @param session - the MAIN session being observed.
   * @returns the location, or undefined when neither the composition nor the
   *   session header supplies a workspace root.
   */
  private workflowLocation(session: Session): WorkflowLogLocation | undefined {
    const workspaceRoot = this.workflowRootFor(session)
    if (workspaceRoot === undefined) return undefined
    return {
      workspaceRoot,
      ...(this.settingsHome === undefined ? {} : { settingsHome: this.settingsHome }),
    }
  }

  /**
   * Workspace root one session's workflow is keyed by: the configured root
   * when the deployment pins one, otherwise the session's own cwd.
   * @param session - the MAIN session being observed.
   * @returns the root, or undefined when neither source supplies one.
   */
  workflowRootFor(session: Session): string | undefined {
    const root = this.config.workspaceRoot ?? session.header.cwd
    return root === undefined || root.length === 0 ? undefined : root
  }

  /**
   * Reset one MAIN session's workflow: release its resident children, revoke
   * their role bindings, delete the durable log, and drop the cached state, so
   * the next admission folds a fresh, empty workflow.
   *
   * The workspace's files are the caller's business — `/reset` clears them
   * first — and this session-side half is deliberately not recoverable: a
   * reset means the task board, the delegation history, and the role bindings
   * are gone. Role bindings are dropped with it because a binding that
   * outlived its files would hand the next dispatch a child whose work
   * referenced deleted inputs.
   * @param session - owning MAIN session.
   * @returns the child session ids that lost their binding, in revocation order.
   * @throws when the session is not an admitted AutoReport MAIN session.
   */
  async resetWorkflow(session: Session): Promise<string[]> {
    if (!isAutoReportMainSession(session)) {
      throw new Error(
        `AutoReport workflow reset requires the '${AUTOREPORT_MAIN_PRESET}' preset; refused ${session.id}`,
      )
    }
    const key = String(session.id)
    const released: string[] = []
    await this.coordinator.resetSession(session)
    try {
      await Promise.allSettled([...(this.residentProvisioning.get(key)?.values() ?? [])])
      const live = this.parents.get(key)
      if (live !== undefined) {
        for (const attempt of live.waiters.pendingDelegations()) live.waiters.abandon(attempt)
        for (const binding of live.state.projection().bindingsByRole.values()) {
          if (this.roleRegistry.revoke(binding.childSessionId)) released.push(String(binding.childSessionId))
        }
      }
      await this.disposeResidentFor(session.id)
      const location = this.workflowLocation(session)
      if (location !== undefined) {
        const path = workflowLogPath(location.settingsHome, location.workspaceRoot ?? '', key)
        rmSync(dirname(path), { recursive: true, force: true })
      }
      this.parents.delete(key)
      this.artifactFolds.delete(key)
      this.residentProvisioning.delete(key)
      this.stoppedParents.delete(key)
      this.pendingPostCommitInitialization.delete(key)
    } finally {
      this.coordinator.finishReset(session)
    }
    return released
  }

  /**
   * Rebuild one MAIN session's workflow state from the plugin's own log.
   *
   * The host session log is never consulted for AutoReport state: a session
   * with no log is a new workflow, which is also what a session from a build
   * that wrote records into the host log becomes. Those records are not read
   * back — this plugin supports its own current format only.
   * @param session - the MAIN session being admitted.
   * @returns the folded workflow state.
   */
  private loadWorkflowState(session: Session): WorkflowState {
    const location = this.workflowLocation(session)
    if (location === undefined) return WorkflowState.empty()
    const path = workflowLogPath(location.settingsHome, location.workspaceRoot ?? '', String(session.id))
    const records = readWorkflowLog(path)
    if (records.length === 0) return WorkflowState.empty()
    seedWorkflowLog(path, records)
    return WorkflowState.fromRecords(records)
  }

  /**
   * Resolve the owning MAIN session and live runtime for one bound child via
   * the synchronous binding alone — no sessions-service round trip, so child
   * setup and observers can use it before any registry is published.
   * @param childId - specialist child Session id.
   * @returns owning MAIN session with its parent runtime, or undefined.
   */
  workflowForChild(childId: SessionId): { session: Session; runtime: ParentWorkflowRuntime } | undefined {
    const entry = this.roleRegistry.lookup(childId)
    if (entry === undefined) return undefined
    const session = this.mainSessions.get(String(entry.binding.parentSessionId))
    if (session === undefined) return undefined
    return { session, runtime: this.forSession(session) }
  }

  /** Exact task/revision bound to the resident child's current dispatch, when known. */
  executionForChild(childId: SessionId): { taskId: string; delegationRevision: number } | undefined {
    const execution = this.activeChildDelegations.get(String(childId))
    return execution === undefined ? undefined : { ...execution }
  }

  /**
   * Workflow projection for a MAIN session id or a bound specialist child id.
   * Specialist lookups return the owning Main projection (tasks live there).
   * @param sessionId - Main or specialist session id.
   */
  projectionFor(sessionId: string): WorkflowProjection | undefined {
    const asChild = this.workflowForChild(sessionId as SessionId)
    if (asChild !== undefined) return asChild.runtime.state.projection()
    const main = this.mainSessions.get(sessionId)
    if (main === undefined) return undefined
    return this.forSession(main).state.projection()
  }

  /**
   * The report language whose skills one bound specialist child received.
   *
   * Registration ({@link installRoutedReportTool}) and enforcement (the
   * report-skill gate) must resolve the language identically, or a gate could
   * require a skill the child was never given. Both call this.
   * @param childId - specialist child Session id.
   * @returns the frozen workflow language, else the configured plugin default.
   */
  reportLanguageForChild(childId: SessionId): ReportSkillLanguage {
    return this.workflowForChild(childId)?.runtime.state.projection().meta?.settings?.reportLanguage
      ?? this.config.defaultReportLanguage
  }

  /**
   * Find the parent runtime that owns one bound child.
   * @param childId - specialist child Session id.
   * @returns parent session/runtime or undefined for an ordinary DSH child.
   */
  parentForChild(childId: SessionId): { session: Session; runtime: ParentWorkflowRuntime } | undefined {
    const entry = this.roleRegistry.lookup(childId)
    if (entry === undefined) return undefined
    const sessions = this.ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
    const session = sessions?.get(entry.binding.parentSessionId)
    if (session === undefined) return undefined
    return { session, runtime: this.forSession(session) }
  }

  /**
   * Deliver a settlement notice onto the owning Main session after one bound
   * child's turn ended in an error.
   *
   * The notice reuses the `subagent-settled` source, so the parent-message
   * observer's existing fold applies it exactly like a runtime settlement:
   * the current delegation fails with the error as its reason, waiters
   * resolve, and the task record carries `failedReason`. Delivery is the same
   * splice the settlement path uses, so the durable log and the live projection
   * agree whichever way the parent consumes it.
   * @param child - the failed child session.
   * @param failure - the structured turn failure from its `turn/end`.
   */
  private notifyChildTurnFailure(child: Session, detail: string): void {
    const owned = this.roleRegistry.lookup(child.id)
    if (owned === undefined) return
    const execution = this.activeChildDelegations.get(String(child.id))
    if (execution === undefined) return
    const owner = this.workflowForChild(child.id)
    const attempt = owner?.runtime.state.delegationAt(execution.taskId, execution.delegationRevision)
    if (attempt === undefined || !isOpenDelegation(attempt)) return
    const parentSessionId = owned.binding.parentSessionId
    const agents = this.ctx.get('agents') as { get?: (id: SessionId) => Agent | undefined } | undefined
    const parent = agents?.get?.(parentSessionId)
    const summary = `AutoReport subagent ${child.id} ${detail}`
    const message = createUserMessage({
      content: [{ type: 'text', text: summary }],
      source: {
        kind: 'autoreport-settled',
        form: 'notice',
        senderSessionId: child.id,
        ...execution,
        summary: boundContextSummary(summary),
      },
    })
    if (parent === undefined) {
      // Main is not live (crash recovery, closed UI): the notice must still
      // reach the durable log so a reload folds the failure. Steering onto
      // the parent session directly keeps the workflow log and session log
      // consistent without a live driver.
      const session = this.mainSessions.get(String(parentSessionId))
      session?.append('user/message', message, { surfaceOp: 'append' })
      return
    }
    if (this.stoppedParents.has(String(parentSessionId))) parent.inject(message)
    else if (parent.status === 'idle') parent.followup(message)
    else parent.steer(message)
  }

  /** Read the current DSH-resolved user defaults for a future workflow. */
  currentUserSettings(): AutoReportUserSettings {
    return this.userSettingsSource()
  }

  /**
   * Idempotent first-turn workspace initialization for one Main session:
   * resolves the settings chain (override > workspace language > user >
   * composition > defaults), materializes missing resources for the
   * resolved language, then records the workflow once via
   * {@link createWorkflow}.
   * @param session - Main session whose cwd (or configured root) is the experiment workspace.
   */
  maybeInitialize(session: Session): void {
    // The host command wrapper admits only autoreport callers; retain
    // this gate here as defense in depth for any future direct caller.
    if (!isAutoReportMainSession(session)) return
    this.forSession(session)
    const root = this.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) return
    let settings: WorkflowSettingsSnapshot
    try {
      settings = resolveWorkflowSettings({
        user: this.userSettingsSource(),
        workspaceRoot: root,
        composition: this.config,
        dshHome: this.settingsHome ?? resolveDshHome(),
      })
      ensureInitialized(root, settings.reportLanguage)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.logger.warn('AutoReportDSH: skipped workflow initialization: %s', message)
      } catch {
        // A bare test Context may lack a working logger; containment already happened.
      }
      return
    }
    this.createWorkflow(session, settings)
    this.warnMissingAnalysisPackages(settings.pythonExecutable)
  }

  /**
   * Language currently in effect for one workspace root under the live user
   * settings: the authoritative map entry, else the user default.
   * @param root - absolute workspace root.
   * @returns the language a workflow created now would resolve.
   */
  workspaceLanguageFor(root: string): ReportLanguage {
    return this.effectiveLanguageFor(root, this.userSettingsSource())
  }

  /**
   * Authoritative per-workspace language seam for the explicit `/init` path.
   * Absent when no settings provider is mounted, in which case the command
   * materializes resources without recording anything.
   */
  get languageStore(): WorkspaceLanguageStore | undefined {
    if (this.settingsService === undefined) return undefined
    return {
      read: root => this.userSettingsSource().workspaceLanguages?.[resolve(root)],
      write: (root, language) => { void this.writeWorkspaceLanguage(resolve(root), language) },
    }
  }

  /**
   * React to one user-settings change by switching the templates of every
   * workspace whose resolved language moved.
   *
   * The first observation is not a change: it records the baseline. Later
   * observations compare each key either snapshot carries, so a move recorded
   * as a fresh map entry is diffed against the language in effect just before
   * it (the user default). A default-only
   * change therefore switches nothing, because no key moves.
   */
  private observeUserSettingsChange(): void {
    const next = this.userSettingsSource()
    const previous = this.previousUserSettings
    this.previousUserSettings = next
    if (previous === undefined) return
    const roots = new Set([
      ...Object.keys(previous.workspaceLanguages ?? {}),
      ...Object.keys(next.workspaceLanguages ?? {}),
    ])
    for (const root of roots) {
      const before = this.effectiveLanguageFor(root, previous)
      const after = this.effectiveLanguageFor(root, next)
      if (before === after) continue
      try {
        switchReportLanguage(resolve(root), before, after)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          this.ctx.logger.warn('AutoReportDSH: language switch failed for %s: %s', root, message)
        } catch {
          // A bare test Context may lack a working logger; the switch already failed loud enough.
        }
      }
    }
  }

  /**
   * Language one workspace root resolves to under a given settings snapshot.
   * @param root - absolute workspace root.
   * @param settings - user settings snapshot the resolution runs against.
   */
  private effectiveLanguageFor(root: string, settings: AutoReportUserSettings): ReportLanguage {
    const explicit = settings.workspaceLanguages?.[resolve(root)]
    if (explicit !== undefined) return explicit
    return settings.defaultReportLanguage
  }

  /**
   * Persist one workspace's language through the settings service. An absent
   * provider (bare test contexts) or a refused write is logged, never thrown:
   * the caller is a settings notification or a first turn, neither of which
   * owns a user-facing failure path.
   * @param root - resolved absolute workspace root, used as the map key.
   * @param language - language to record.
   */
  private async writeWorkspaceLanguage(root: string, language: ReportLanguage): Promise<void> {
    const settings = this.settingsService
    if (settings === undefined) return
    try {
      await settings.mutate(AUTOREPORT_SETTINGS_NAMESPACE, [
        { op: 'set', path: ['workspaceLanguages', root], value: language },
      ])
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.logger.warn('AutoReportDSH: could not record the workspace language: %s', message)
      } catch {
        // A bare test Context may lack a working logger.
      }
    }
  }

  /**
   * Commit the durable workflow event ONCE with the resolved settings
   * snapshot attached (PLAN.md §2.14). Later calls are no-ops: an in-flight
   * report never adopts changed settings.
   * @param session - owning Main session.
   * @param resolvedSettings - frozen snapshot from {@link resolveWorkflowSettings}.
   * @returns the committed event, or undefined when a workflow already exists.
   */
  createWorkflow(
    session: Session,
    resolvedSettings: WorkflowSettingsSnapshot,
  ): WorkflowRecord<'autoreport/workflow'> | undefined {
    const previous: WorkflowMetaSnapshot | undefined = this.forSession(session).state.projection().meta
    if (previous?.initialized === true) return undefined
    const root = this.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) {
      throw new Error('AutoReportDSH: cannot record the workflow without a workspace root')
    }
    return this.commit(session, 'autoreport/workflow', {
      version: AUTOREPORT_SCHEMA_VERSION,
      workflowId: previous?.workflowId ?? String(session.id),
      workspaceRoot: root,
      language: resolvedSettings.reportLanguage,
      initialized: true,
      ...(this.config.specialistModel === undefined ? {} : { specialistRoute: this.config.specialistModel }),
      settings: resolvedSettings,
    })
  }

  /**
   * Warn when a non-managed (or otherwise incomplete) interpreter is missing
   * numpy/scipy/pandas/matplotlib. Never fails init; managed venvs already
   * pip-install those packages when they are created or reused.
   */
  private warnMissingAnalysisPackages(pythonExecutable: string | undefined): void {
    if (pythonExecutable === undefined) return
    const missing = missingAnalysisPackages(pythonExecutable)
    if (missing.length === 0) return
    try {
      this.ctx.logger.warn(
        'AutoReportDSH: Python interpreter is missing analysis packages: %s (%s). Data Analysis and Plotting may fail until they are installed.',
        missing.join(', '),
        pythonExecutable,
      )
    } catch {
      // A bare test Context may lack a working logger.
    }
  }
}
