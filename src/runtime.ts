import { Service, type Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionEventMap, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from './config.js'
import { WorkflowState } from './workflow/service.js'
import { RoleRegistry } from './workflow/role-registry.js'
import { WaiterRegistry } from './workflow/waiters.js'
import { appendWorkflowEvent } from './workflow/store.js'
import { observeWorkflowMessage } from './workflow/report-observer.js'
import { ensureInitialized } from './workspace/init.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AutoReport workflow state and synchronous role authorization. */
    autoreportWorkflow: AutoReportWorkflowRuntime
  }
}

const DEFAULT_CONFIG: Config = {
  reportLanguage: 'latex',
  latexEngine: 'latexmk',
  pythonEnv: undefined,
  workspaceRoot: undefined,
  specialistRoute: undefined,
  executionTimeoutMs: 600_000,
}

/** Per-parent live synchronization state. Durable facts remain in the Session log. */
export interface ParentWorkflowRuntime {
  readonly state: WorkflowState
  readonly waiters: WaiterRegistry
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
  private readonly parents = new Map<string, ParentWorkflowRuntime>()
  private readonly mainSessionIds = new Set<string>()

  /**
   * Create the host runtime and observe committed report messages.
   * @param ctx - host context carrying Session events.
   * @param config - resolved plugin configuration.
   */
  constructor(ctx: Context, config: Config = DEFAULT_CONFIG) {
    super(ctx, 'autoreportWorkflow')
    this.config = config
    ctx.on('session/event', (session, event) => {
      // Continuable children have a parent; AutoReport workflow facts live only on Main.
      if (session.header.parentSession !== undefined) return
      const live = this.forSession(session)
      live.state.apply(event)
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
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
   * Whether a live session is an AutoReport Main parent.
   * @param sessionId - candidate session id.
   */
  isMainSession(sessionId: SessionId): boolean {
    return this.mainSessionIds.has(sessionId)
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
    const existing = this.parents.get(session.id)
    if (existing !== undefined) return existing
    const created = { state: WorkflowState.fromSession(session), waiters: new WaiterRegistry() }
    this.parents.set(session.id, created)
    this.mainSessionIds.add(session.id)
    for (const binding of created.state.projection().bindingsByRole.values()) {
      if (binding.provisioning !== 'failed' && this.roleRegistry.lookup(binding.childSessionId) === undefined) {
        this.roleRegistry.registerReserved(binding)
      }
    }
    return created
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
   * Idempotent first-turn workspace initialization for one Main session.
   * @param session - Main session whose cwd (or configured root) is the experiment workspace.
   */
  maybeInitialize(session: Session): void {
    const live = this.forSession(session)
    if (live.state.projection().meta?.initialized === true) return
    const root = this.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) return
    ensureInitialized(root, this.config.reportLanguage)
    const previous = live.state.projection().meta
    this.commit(session, 'autoreport/workflow', {
      version: 1,
      workflowId: previous?.workflowId ?? String(session.id),
      workspaceRoot: root,
      language: this.config.reportLanguage,
      initialized: true,
      ...(this.config.specialistRoute === undefined ? {} : { specialistRoute: this.config.specialistRoute }),
    })
  }
}
