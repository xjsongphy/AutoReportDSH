/**
 * The durable report-workflow projection (PLAN.md §2.6): folds `autoreport/*`
 * session events into authoritative task/delegation/binding/artifact state.
 * Folding is deterministic and replay-safe; snapshots are last-write-wins per
 * key, and late reports for older revisions stay in their own delegation
 * slots as stale evidence without touching the current attempt.
 *
 * Recovery inputs are exactly this projection plus the workspace files —
 * conversation history is never consulted (persistence/recovery rule).
 * @module
 */

import type { Session, SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import type { SpecialistRole } from '../roles.js'
import { isAutoreportEvent } from './store.js'
import { delegationKey } from './protocol.js'
import type {
  ArtifactSnapshot,
  DelegationSnapshot,
  FileNoteSnapshot,
  RoleBindingSnapshot,
  TaskSnapshot,
  WorkflowMetaSnapshot,
} from './events.js'

/** Immutable fold of the whole workflow state. */
export interface WorkflowProjection {
  /** Latest workflow metadata; undefined before the first `autoreport/workflow`. */
  readonly meta: WorkflowMetaSnapshot | undefined
  /** Tasks by id. */
  readonly tasks: ReadonlyMap<string, TaskSnapshot>
  /** Delegations by composite key (`taskId#revision`). */
  readonly delegations: ReadonlyMap<string, DelegationSnapshot>
  /** Bindings by child session id; failed/superseded children remain as evidence. */
  readonly bindingsByChild: ReadonlyMap<string, RoleBindingSnapshot>
  /** Newest binding per role (rebinds supersede). */
  readonly bindingsByRole: ReadonlyMap<SpecialistRole, RoleBindingSnapshot>
  /** Artifacts in observation order. */
  readonly artifacts: readonly ArtifactSnapshot[]
  /** Latest semantic description per workspace-relative path. */
  readonly fileNotes: ReadonlyMap<string, FileNoteSnapshot>
}

/**
 * Mutable accumulator behind {@link WorkflowState}. Kept internal; the public
 * surface exposes queries plus {@link WorkflowState.apply}.
 */
interface ProjectionBuilder {
  meta: WorkflowMetaSnapshot | undefined
  tasks: Map<string, TaskSnapshot>
  delegations: Map<string, DelegationSnapshot>
  bindingsByChild: Map<string, RoleBindingSnapshot>
  bindingsByRole: Map<SpecialistRole, RoleBindingSnapshot>
  artifacts: ArtifactSnapshot[]
  fileNotes: Map<string, FileNoteSnapshot>
}

function emptyProjection(): ProjectionBuilder {
  return {
    meta: undefined,
    tasks: new Map(),
    delegations: new Map(),
    bindingsByChild: new Map(),
    bindingsByRole: new Map(),
    artifacts: [],
    fileNotes: new Map(),
  }
}

/** Live report-workflow state with incremental apply and query helpers. */
export class WorkflowState {
  private readonly builder: ProjectionBuilder

  private constructor(builder: ProjectionBuilder) {
    this.builder = builder
  }

  /**
   * Fresh empty state for incremental subscription wiring.
   * @returns a state with no folded records yet.
   */
  static empty(): WorkflowState {
    return new WorkflowState(emptyProjection())
  }

  /**
   * Fold a complete event array (cold load / recovery path).
   * @param events - session log slice containing any `autoreport/*` records.
   * @returns the folded state.
   */
  static fromEvents(events: ReadonlyArray<SessionEvent<SessionEventType>>): WorkflowState {
    const state = WorkflowState.empty()
    for (const event of events) state.apply(event)
    return state
  }

  /**
   * Apply one event incrementally. Non-AutoReport events are ignored so
   * callers may subscribe to the raw session stream unfiltered.
   * @param event - a committed session event.
   */
  apply(event: SessionEvent<SessionEventType>): void {
    if (!isAutoreportEvent(event.type)) return
    switch (event.type) {
      case 'autoreport/workflow':
        this.builder.meta = event.data
        break
      case 'autoreport/role-binding': {
        const snap = event.data
        this.builder.bindingsByChild.set(snap.childSessionId, snap)
        this.builder.bindingsByRole.set(snap.role, snap)
        break
      }
      case 'autoreport/task':
        this.builder.tasks.set(event.data.taskId, event.data)
        break
      case 'autoreport/delegation': {
        const snap = event.data
        this.builder.delegations.set(delegationKey(snap.taskId, snap.delegationRevision), snap)
        break
      }
      case 'autoreport/artifact':
        this.builder.artifacts.push(event.data)
        break
      case 'autoreport/file-note':
        this.builder.fileNotes.set(event.data.path, event.data)
        break
    }
  }

  /**
   * Immutable view for tests/diagnostics.
   * @returns a frozen-ish snapshot copy (arrays copied, maps wrapped readonly).
   */
  projection(): WorkflowProjection {
    return {
      meta: this.builder.meta,
      tasks: this.builder.tasks,
      delegations: this.builder.delegations,
      bindingsByChild: this.builder.bindingsByChild,
      bindingsByRole: this.builder.bindingsByRole,
      artifacts: [...this.builder.artifacts],
      fileNotes: new Map(this.builder.fileNotes),
    }
  }

  /**
   * Fetch one task snapshot.
   * @param taskId - task id.
   * @returns the latest snapshot or undefined.
   */
  getTask(taskId: string): TaskSnapshot | undefined {
    return this.builder.tasks.get(taskId)
  }

  /**
   * Unfinished (open) tasks owned by one role.
   * @param role - specialist role to filter by.
   * @returns snapshots whose status is pending, running, or blocked.
   */
  openTasksForRole(role: SpecialistRole): TaskSnapshot[] {
    return [...this.builder.tasks.values()].filter(
      task => task.role === role && (task.status === 'pending' || task.status === 'running' || task.status === 'blocked'),
    )
  }

  /**
   * Highest-revision delegation recorded for one task.
   * @param taskId - task id.
   * @returns the current attempt or undefined before first dispatch.
   */
  currentDelegation(taskId: string): DelegationSnapshot | undefined {
    let current: DelegationSnapshot | undefined
    for (const snap of this.builder.delegations.values()) {
      if (snap.taskId !== taskId) continue
      if (current === undefined || snap.delegationRevision > current.delegationRevision) current = snap
    }
    return current
  }

  /**
   * One specific delegation attempt.
   * @param taskId - owning task id.
   * @param revision - attempt number.
   * @returns the snapshot or undefined.
   */
  delegationAt(taskId: string, revision: number): DelegationSnapshot | undefined {
    return this.builder.delegations.get(delegationKey(taskId, revision))
  }

  /**
   * Binding recorded for one child session.
   * @param childSessionId - DSH child session id.
   * @returns the binding snapshot or undefined (callers fail closed).
   */
  bindingForChild(childSessionId: string): RoleBindingSnapshot | undefined {
    return this.builder.bindingsByChild.get(childSessionId)
  }

  /**
   * Newest binding for one role (rebinds supersede earlier ones).
   * @param role - specialist role.
   * @returns the binding snapshot or undefined.
   */
  bindingForRole(role: SpecialistRole): RoleBindingSnapshot | undefined {
    return this.builder.bindingsByRole.get(role)
  }

  /**
   * Next monotonic task id (`task-<n>`).
   * @returns the id to use for the next created task.
   */
  nextTaskId(): string {
    let max = 0
    for (const taskId of this.builder.tasks.keys()) {
      const match = /^task-(\d+)$/.exec(taskId)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    return `task-${max + 1}`
  }

  /**
   * Replace a task's checklist with bounded validation. Callers persist via
   * {@link ../store} `appendWorkflowEvent`.
   * @param previous - current snapshot to evolve.
   * @param steps - new checklist (≤64 entries, non-empty descriptions ≤512 chars).
   * @returns the replacement snapshot with an incremented mutation revision.
   */
  updateChecklist(previous: TaskSnapshot, steps: ReadonlyArray<{ description: string; done?: boolean }>): TaskSnapshot {
    if (steps.length > 64) throw new Error('checklist exceeds 64 steps')
    const normalized = steps.map(step => {
      const description = typeof step.description === 'string' ? step.description.trim() : ''
      if (description.length === 0) throw new Error('checklist step description must be non-empty')
      if (description.length > 512) throw new Error('checklist step description exceeds 512 chars')
      return { description, done: step.done === true }
    })
    return { ...previous, steps: normalized, revision: previous.revision + 1 }
  }

  /**
   * Subscribe to a live session's future events (host wiring helper). The
   * caller owns the cordis-level subscription; this only replays what already
   * exists in the log so a late subscriber starts consistent.
   * @param session - session whose existing log seeds the state.
   * @returns this state seeded from `session.events`.
   */
  static fromSession(session: Session): WorkflowState {
    return WorkflowState.fromEvents(session.events)
  }
}
