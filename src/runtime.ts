import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionEventMap, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { Config } from './config.js'
import { AUTOREPORT_MAIN_PRESET, isAutoReportMainSession } from './membership.js'
import { renderManifest, writeManifests } from './artifacts/manifest.js'
import { emptyArtifactFoldState, foldArtifact, type ArtifactCaller, type ArtifactFoldState } from './artifacts/observer.js'
import { AUTOREPORT_SCHEMA_VERSION, type WorkflowMetaSnapshot } from './workflow/events.js'
import { delegationKey } from './workflow/protocol.js'
import { WorkflowState, type WorkflowProjection } from './workflow/service.js'
import { RoleRegistry } from './workflow/role-registry.js'
import { WaiterRegistry } from './workflow/waiters.js'
import { appendWorkflowEvent } from './workflow/store.js'
import { observeWorkflowMessage } from './workflow/report-observer.js'
import { applyRoleSandbox } from './policy/sandbox-roots.js'
import { ensureInitialized } from './workspace/init.js'
import { syncedResourcesRoot } from './workspace/resource-sync.js'
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
import { detectPythonEnvironments } from './python-detect.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AutoReport workflow state and synchronous role authorization. */
    autoreportWorkflow: AutoReportWorkflowRuntime
  }
}

const DEFAULT_WAIT_MS = 600_000

const DEFAULT_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: DEFAULT_WAIT_MS,
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
  /** Root receiving external manifest projections; absent resolves the DSH home lazily. */
  readonly manifestHome?: string
  /** Skip GitHub overlay sync (tests seed stubs instead). */
  readonly skipResourceSync?: boolean
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
  private readonly manifestHome: string | undefined
  private readonly parents = new Map<string, ParentWorkflowRuntime>()
  // Retain admitted parent sessions for workflow/artifact ownership, but do
  // not use historical admission as current Main authorization: the effective
  // preset may change while a root is still blank.
  private readonly mainSessions = new Map<string, Session>()
  private readonly artifactFolds = new Map<string, ArtifactFoldState>()
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
    this.manifestHome = options.manifestHome
    const dshHome = options.settingsHome ?? resolveDshHome()
    this.overlayRoot = syncedResourcesRoot(dshHome)
    const userSettingsBase = autoReportUserSettingsBase(
      config,
      detectPythonEnvironments({
        ...(config.workspaceRoot === undefined ? {} : { workspace: config.workspaceRoot }),
        dshHome,
      }),
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
      if (event.type === 'turn/start') {
        this.ensureMainSandbox(session)
      }
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        this.ensureMainSandbox(session)
        this.maybeInitialize(session)
      }
      observeWorkflowMessage(session, event, {
        state: live.state,
        waiters: live.waiters,
        commit: (type, data) => this.commit(session, type, data),
      })
    })
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

  /** Current open attempt key for one specialist child, when one is waiting. */
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
   * Project the accumulated artifact snapshots into the EXTERNAL manifest
   * cache under the harness home (`<home>/autoreport/<workspaceId>/manifests/`),
   * never inside the experiment workspace. Failures are contained: the
   * durable artifact facts are already committed, and a projection hiccup
   * must never break the tool pipeline that produced them.
   */
  private projectManifests(session: Session): void {
    try {
      const home = this.manifestHome ?? resolveDshHome()
      const live = this.forSession(session).state.projection()
      if (live.meta?.initialized !== true) return
      const artifacts = live.artifacts
      if (artifacts.length === 0) return
      writeManifests(home, workspaceIdForRoot(live.meta.workspaceRoot), renderManifest(artifacts))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.logger.warn('autoreportdsh: manifest projection failed: %s', message)
      } catch {
        // A bare test Context may lack a working logger; containment already happened.
      }
    }
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
    for (const binding of created.state.projection().bindingsByRole.values()) {
      if (binding.provisioning !== 'failed' && this.roleRegistry.lookup(binding.childSessionId) === undefined) {
        this.roleRegistry.registerReserved(binding)
      }
    }
    return created
  }

  /**
   * Pin MAIN sandbox confinement once a real turn starts. Idempotent last-wins;
   * independent of workflow initialization so `/report-init` alone never pins.
   * @param session - owning Main session.
   */
  private ensureMainSandbox(session: Session): void {
    if (!isAutoReportMainSession(session)) return
    const root = this.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) return
    applyRoleSandbox(session, 'MAIN', root)
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
    if (type === 'autoreport/artifact') this.projectManifests(session)
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
    const live = this.forSession(session)
    if (live.state.projection().meta?.initialized === true) return
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
      // A broken EXTERNAL settings document must not wedge every first turn;
      // the next user message retries after repair. The /report-init command
      // path surfaces the same failure loudly instead of skipping.
      const message = error instanceof Error ? error.message : String(error)
      try {
        this.ctx.logger.warn('autoreportdsh: skipped workflow initialization: %s', message)
      } catch {
        // A bare test Context may lack a working logger; containment already happened.
      }
      return
    }
    this.createWorkflow(session, settings)
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
}
