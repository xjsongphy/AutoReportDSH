import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { applyChildComposition, seedDescriptorTurn, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionEventMap, type SessionEventType } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { Config } from './config.js'
import { AUTOREPORT_MAIN_PRESET, isAutoReportMainSession } from './membership.js'
import { emptyArtifactFoldState, foldArtifact, type ArtifactCaller, type ArtifactFoldState } from './artifacts/observer.js'
import { AUTOREPORT_SCHEMA_VERSION, type WorkflowMetaSnapshot } from './workflow/events.js'
import { delegationKey } from './workflow/protocol.js'
import { installRoutedReportTool } from './tools/report-router.js'
import { allSpecialistRoles, type SpecialistRole } from './roles.js'
import { loadSpecialistPersona } from './personas.js'
import type { CoordinatorMessageSource, SubagentReportMessageSource } from '@deepseek-ai/dsh-subagent'
import { WorkflowState, type WorkflowProjection } from './workflow/service.js'
import { RoleRegistry } from './workflow/role-registry.js'
import { WaiterRegistry } from './workflow/waiters.js'
import { appendWorkflowEvent } from './workflow/store.js'
import { observeWorkflowMessage, recoverWorkflowReports } from './workflow/report-observer.js'
import { applyRoleSandbox } from './policy/sandbox-roots.js'
import { ensureInitialized } from './workspace/init.js'
import { detectPythonEnvironments, missingAnalysisPackages, type PythonDetectOptions } from './python-detect.js'
import { syncedResourcesRoot } from './workspace/resource-sync.js'
import { detectMineruStatus } from './mineru-status.js'
import {
  AUTO_REPORT_USER_SETTINGS_SCHEMA,
  AUTOREPORT_SETTINGS_NAMESPACE,
  autoReportUserSettingsBase,
  loadProjectSettings,
  resolveWorkflowSettings,
  validatePythonExecutableSetting,
  workspaceIdForRoot,
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

/** Construction options beyond configuration (host wiring / tests). */
export interface RuntimeOptions {
  /** Harness home override for external project settings; absent resolves the DSH home. */
  readonly settingsHome?: string
  /** Skip GitHub overlay sync (tests seed stubs instead). */
  readonly skipResourceSync?: boolean
  /** Interpreter discovery overlay; tests disable conda/PATH scans. */
  readonly pythonDetect?: PythonDetectOptions
}

/**
 * Host-plane AutoReport runtime keyed by Main Session. The service owns no
 * second persistence or queue: it folds committed Session events and keeps
 * only synchronous authorization and optional in-process waiters.
 */
export default class AutoReportWorkflowRuntime extends Service {
  /** Global child-id authorization used during unpublished child setup. */
  readonly roleRegistry = new RoleRegistry()
  /** Validated plugin configuration used by tools and first-turn initialization. */
  readonly config: Config
  /** Harness home override for external project settings; absent resolves the DSH home. */
  readonly settingsHome: string | undefined
  /** Global overlay for synced remotes (`$dshHome/autoreport/resources`). */
  readonly overlayRoot: string
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
  /** Coalesce startup and first-dispatch provisioning for one role. */
  private readonly residentProvisioning = new Map<string, Map<SpecialistRole, Promise<Agent | undefined>>>()
  /** Current DSH-resolved user defaults; each new workflow snapshots this once. */
  private userSettingsSource: () => AutoReportUserSettings

  /**
   * Create the host runtime and observe committed report messages.
   * @param ctx - host context carrying Session events.
   * @param config - resolved plugin configuration.
   * @param options - `settingsHome` overrides `<dshHome>` for project settings (tests).
   */
  constructor(ctx: Context, config: Config = DEFAULT_CONFIG, options: RuntimeOptions = {}) {
    super(ctx, 'autoreportWorkflow')
    this.config = config
    this.settingsHome = options.settingsHome
    const dshHome = options.settingsHome ?? resolveDshHome()
    this.overlayRoot = syncedResourcesRoot(dshHome)
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
    installSettingsSection(ctx, AUTOREPORT_SETTINGS_NAMESPACE, AUTO_REPORT_USER_SETTINGS_SCHEMA, userSettingsBase, {
      setSource: current => { this.userSettingsSource = current },
      validate: value => validatePythonExecutableSetting(value, dshHome),
      // Settings are deliberately read only when a workflow is created;
      // existing snapshots must not change under an in-flight report.
      onChange: () => {},
    })
    ctx.on('session/event', (session, event) => {
      // Coexistence gate (PLAN.md compatibility invariant): sessions that did
      // not select AutoReport stay stock — no state, no initialization, no
      // observation. "Unknown" means "not our session", never "invalid one".
      if (!this.ownsSession(session)) return
      // Artifact facts come from BOTH planes: Main's own Outline writes and
      // specialist children's role-scoped mutations. Fold every owned stream;
      // the caller resolution below decides who is authorized to have produced.
      this.foldArtifacts(session, event)
      // Continuable children have a parent; AutoReport workflow facts live only on Main.
      if (session.header.parentSession !== undefined) return
      const live = this.forSession(session)
      live.state.apply(event)
      if (event.type === 'turn/start' && this.isInitialTurnStart(session)) {
        this.initializeAfterAppend(session)
        this.ensureResidentRolesForSession(session)
        // The turn boundary is the first reliable lifecycle event for a
        // newly selected preset. Initialize here before the first model
        // message; the user/message branch below remains an idempotent
        // recovery path for hosts that do not publish turn/start first.
      }
      if (event.type === 'user/message'
        && event.data.source.kind === 'user'
        && this.isInitialUserMessage(session)) {
        this.initializeAfterAppend(session)
        this.ensureResidentRolesForSession(session)
      }
      if (event.type === 'agent-preset/selected' && isAutoReportMainSession(session)) {
        // A blank DSH session can be composed after agent/session-start. In
        // that path the startup listener has already run before membership is
        // visible, so retry provisioning at the actual preset-selection event.
        this.ensureResidentRolesForSession(session)
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
    }, { global: true })
    ctx.on('agent/session-start', ({ agent }) => {
      if (!isAutoReportMainSession(agent.session)) return
      // The role sessions are created before any Main delegation. They stay
      // idle until the user or Main addresses them, matching AutoReport's
      // resident-loop model without consuming a startup model request.
      void this.ensureResidentRoles(agent).catch(error => this.logResidentFailure(error))
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      if (isAutoReportMainSession(agent.session)) void this.disposeResidentFor(agent.id)
    }, { global: true })
    const agents = ctx.get('agents') as { list?: () => Agent[] } | undefined
    for (const agent of agents?.list?.() ?? []) {
      if (isAutoReportMainSession(agent.session)) {
        void this.ensureResidentRoles(agent).catch(error => this.logResidentFailure(error))
      }
    }
    ctx.effect(() => () => {
      void this.disposeResidentRoles()
    }, 'autoreportdsh.residentRoles()')
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

  /** Ensure all four fixed subagents exist before the first user turn. */
  async ensureResidentRoles(parent: Agent, signal?: AbortSignal): Promise<void> {
    await Promise.all(allSpecialistRoles().map(role => this.ensureResidentRole(parent, role, signal)))
  }

  /** Retry resident provisioning when a blank session selects AutoReport late. */
  private ensureResidentRolesForSession(session: Session): void {
    const agents = this.ctx.get('agents') as {
      get?: (id: SessionId) => Agent | undefined
      list?: () => Agent[]
    } | undefined
    const agent = agents?.get?.(session.id)
      ?? agents?.list?.().find(candidate => candidate.session.id === session.id)
    if (agent === undefined) return
    void this.ensureResidentRoles(agent).catch(error => this.logResidentFailure(error))
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
    if (parent === undefined) throw new Error('direct parent is not live; report was not delivered')
    const message = createUserMessage({
      content: [
        { type: 'text', text: `Background subagent ${child.id} reported:` },
        ...content,
      ],
      source: {
        kind: 'subagent-report',
        form: 'relay',
        senderSessionId: child.id,
      } satisfies SubagentReportMessageSource,
    })
    parent.steer(message)
    return String(message.id)
  }

  /** Create or resume one resident role without sending an initial prompt. */
  private async provisionResidentRole(parent: Agent, role: SpecialistRole, signal: AbortSignal): Promise<Agent | undefined> {
    const parentSession = parent.session
    const agents = this.ctx.get('agents') as {
      get?: (id: SessionId) => Agent | undefined
      create?: (options: object) => Promise<AgentHandle>
      resume?: (options: { resumeSessionId: SessionId; agentOptions?: Agent['options']; setup?: (ctx: Context) => void }) => Promise<AgentHandle>
      withInitiator?: <T>(agent: Agent, operation: () => T) => T
    } | undefined
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
    const route = this.currentUserSettings().specialistModel ?? this.config.specialistModel
    const agentOptions: Agent['options'] = {
      ...(parent.options.provider === undefined ? {} : { provider: parent.options.provider }),
      ...(parent.options.model === undefined ? {} : { model: parent.options.model }),
      ...(parent.options.maxTokens === undefined ? {} : { maxTokens: parent.options.maxTokens }),
      ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
    }
    const persona = loadSpecialistPersona(role)
    const toolFilter = { deny: ['send_to_agent', 'ask_user_question'] }
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'spawn',
      label: `AutoReport ${role}`,
      ...(agentOptions.provider === undefined ? {} : { agentProvider: agentOptions.provider }),
      ...(agentOptions.model === undefined ? {} : { agentModel: agentOptions.model }),
      persona,
      toolFilter,
    })
    const seed = seedDescriptorTurn(binding.childSessionId, undefined, descriptor)
    const setup = async (childCtx: Context): Promise<void> => {
      const child = childCtx.agent
      if (child === undefined) throw new Error(`resident ${role} setup has no child agent`)
      applyChildComposition(childCtx, parent, { persona, toolFilter })
      // The parent preset is joined synchronously above, but its scoped skill
      // service is exposed through Cordis injection. Wait for that capability
      // before publishing the child so REPORT skills and the role report tool
      // are present from the first resident request.
      await childCtx.inject(['skills'], (skillCtx) => {
        skillCtx.effect(
          () => installRoutedReportTool(skillCtx, this.ctx, this),
          `autoreportdsh.resident.${role}()`,
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
        ? agents.resume!({ resumeSessionId: binding.childSessionId, agentOptions, setup })
        : agents.create!({
            sessionId: binding.childSessionId,
            seed,
            meta: {
              ...(parent.session.header.cwd === undefined ? {} : { cwd: parent.session.header.cwd }),
              parentSession: parent.id,
              origin: 'subagent',
              delegationDepth: 1,
            },
            agentOptions,
            setup,
          } as never)
      const handle = await (agents.withInitiator === undefined
        ? createOrResume()
        : agents.withInitiator(parent, createOrResume))
      this.storeResident(parent, role, handle)
      this.markResidentActive(parentSession, binding, role, handle.agent)
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

  private logResidentFailure(error: unknown): void {
    try {
      this.ctx.logger.warn('autoreportdsh: resident subagent provisioning failed: %s', error instanceof Error ? error.message : String(error))
    } catch {
      // Tests may use a bare context without a logger.
    }
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
      if (current.phase !== 'dispatched' && current.phase !== 'waiting_for_child') continue
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
    const created = { state: WorkflowState.fromSession(session), waiters: new WaiterRegistry() }
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
    return session.events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'user',
    ).length === 1
  }

  /** Whether the observed turn boundary is the first turn in this session. */
  private isInitialTurnStart(session: Session): boolean {
    return session.events.filter(event => event.type === 'turn/start').length === 1
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
   * Append one ignorable domain event and synchronously update its projection.
   * Applying twice through the Session observer is safe because mutable
   * workflow snapshots are keyed last-write-wins.
   * @param session - owning Main Session.
   * @param type - AutoReport event type.
   * @param data - whole snapshot payload.
   * @returns the committed event.
   */
  commit<T extends keyof SessionEventMap & `autoreport/${string}`>(
    session: Session,
    type: T,
    data: SessionEventMap[T],
  ): SessionEvent<T> {
    const event = appendWorkflowEvent(session, type, data)
    this.forSession(session).state.apply(event as SessionEvent<SessionEventType>)
    return event
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

  /** Read the current DSH-resolved user defaults for a future workflow. */
  currentUserSettings(): AutoReportUserSettings {
    return this.userSettingsSource()
  }

  /**
   * Idempotent first-turn workspace initialization for one Main session:
   * resolves the settings chain (override > project > user > composition >
   * defaults), materializes missing resources for the resolved language, then
   * records the workflow once via {@link createWorkflow}.
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
      const project = loadProjectSettings(this.settingsHome, workspaceIdForRoot(root))
      settings = resolveWorkflowSettings({
        user: this.userSettingsSource(),
        project,
        composition: this.config,
        dshHome: this.settingsHome ?? resolveDshHome(),
      })
      ensureInitialized(root, settings.reportLanguage, this.overlayRoot)
    } catch (error: unknown) {
      // A broken external settings document must not wedge the first turn;
      // the explicit /init path surfaces the same failure loudly for repair.
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.logger.warn('autoreportdsh: skipped workflow initialization: %s', message)
      } catch {
        // A bare test Context may lack a working logger; containment already happened.
      }
      return
    }
    this.createWorkflow(session, settings)
    this.warnMissingAnalysisPackages(settings.pythonExecutable)
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
  ): SessionEvent<'autoreport/workflow'> | undefined {
    const previous: WorkflowMetaSnapshot | undefined = this.forSession(session).state.projection().meta
    if (previous?.initialized === true) return undefined
    const root = this.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) {
      throw new Error('autoreportdsh: cannot record the workflow without a workspace root')
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
        'autoreportdsh: Python interpreter is missing analysis packages: %s (%s). Data Analysis and Plotting may fail until they are installed.',
        missing.join(', '),
        pythonExecutable,
      )
    } catch {
      // A bare test Context may lack a working logger.
    }
  }
}
