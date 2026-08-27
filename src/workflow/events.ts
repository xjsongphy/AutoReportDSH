/**
 * The `autoreport/*` session-event vocabulary: complete-snapshot facts folded
 * into the durable report-workflow projection (PLAN.md §2.6). Every payload is
 * a whole snapshot — replay is last-write-wins per key — and every append goes
 * through {@link ../store} so the record carries `ignorable: true` and stock
 * DSH readers skip it instead of refusing the log.
 *
 * Log-only vocabulary: no member here enters model history or the ordered
 * surface, so all records survive compaction unchanged.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AutoReportRole, SpecialistRole } from '../roles.js'
import type { SpecialistRoute } from '../config.js'
import type { WorkflowSettingsSnapshot } from '../settings.js'

/** Current schema version stamped on every snapshot; a field change bumps it. */
export const AUTOREPORT_SCHEMA_VERSION = 3

/** Validated child-report envelope carried on delegation snapshots (PLAN.md §2.5). */
export interface WorkflowReportEnvelope {
  /** Owning task id (`task-<n>`). */
  readonly task_id: string
  /** Delegation attempt this report answers. */
  readonly delegation_revision: number
  /** Terminal classification of one attempt. */
  readonly status: 'success' | 'blocked'
  /** Required for `blocked`, null for `success`. */
  readonly block_type: 'missing_data' | 'quality' | null
  /** Self-contained result text for MAIN. */
  readonly response: string
  /** Normalized workspace-relative paths of produced files. */
  readonly produced_files: readonly string[]
}

/** Provisioning lifecycle of one role binding. Authorization-valid ≠ active: a reserved binding authorizes before materialization. */
export type ProvisioningState = 'reserved' | 'active' | 'failed'

/**
 * Role↔child identity fact. A NEW reservation supersedes the previous
 * binding for the same role (rebind); the old child id stays in the fold as
 * evidence and loses authorization.
 */
export interface RoleBindingSnapshot {
  /** Schema version ({@link AUTOREPORT_SCHEMA_VERSION}). */
  readonly version: number
  /** The fixed specialist role this binding serves. */
  readonly role: SpecialistRole
  /** Caller-reserved durable child session id. */
  readonly childSessionId: SessionId
  /** Session that delegated to this child (MAIN's session). */
  readonly parentSessionId: SessionId
  /** Workflow instance the binding belongs to. */
  readonly workflowId: string
  /** Provisioning lifecycle; `failed` bindings authorize nothing. */
  readonly provisioning: ProvisioningState
  /** Child id this reservation replaces; absent on first provisioning. */
  readonly supersedes?: SessionId
}

/** Checklist entry answering "what work remains" (PLAN.md §2.6). */
export interface TaskStep {
  /** Imperative description of one concrete deliverable. */
  readonly description: string
  /** Whether the step is finished. */
  readonly done: boolean
}

/** Task lifecycle owned by MAIN. */
export type TaskStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'

/** Whole task state; every mutation appends a replacement snapshot. */
export interface TaskSnapshot {
  /** Schema version ({@link AUTOREPORT_SCHEMA_VERSION}). */
  readonly version: number
  /** Stable domain id (`task-<n>`, monotonic within the workflow). */
  readonly taskId: string
  /** Short imperative subject. */
  readonly subject: string
  /** Owning specialist role; ownership is fixed at creation. */
  readonly role: SpecialistRole
  /** Task ids that must complete first. */
  readonly dependencies: readonly string[]
  /** Lifecycle state. */
  readonly status: TaskStatus
  /** Monotonic count of task mutations (not the delegation revision). */
  readonly revision: number
  /** Why the task is blocked; absent otherwise. */
  readonly blockedReason?: string
  /** Why the task failed; absent otherwise. */
  readonly failedReason?: string
  /** Bounded checklist of remaining work. */
  readonly steps: readonly TaskStep[]
  /** Workspace-relative directories the task may produce files in. */
  readonly scopes: readonly string[]
  /** Latest dispatched attempt, if any. */
  readonly latestDelegationRevision?: number
}

/** Durable delegation phase: WHY an attempt waits, never a serialized waiter (PLAN.md §2.6). */
export type DelegationPhase =
  | 'dispatched'
  | 'waiting_for_child'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'stale'
  | 'cancelled'

/** Whole delegation-attempt state keyed by `(taskId, delegationRevision)`. */
export interface DelegationSnapshot {
  /** Schema version ({@link AUTOREPORT_SCHEMA_VERSION}). */
  readonly version: number
  /** Owning task id. */
  readonly taskId: string
  /** Attempt number within the task; monotonic per dispatch/re-dispatch. */
  readonly delegationRevision: number
  /** Specialist role the attempt targets. */
  readonly role: SpecialistRole
  /** Bound child session receiving the attempt. */
  readonly childSessionId: SessionId
  /** DSH transport evidence: accepted inbox message id. Domain identity stays `(taskId, revision)`. */
  readonly acceptedMessageId?: string
  /** DSH transport identity of the latest accepted child report. */
  readonly reportMessageId?: string
  /** Durable phase. */
  readonly phase: DelegationPhase
  /** Latest validated child report; absent until one arrives. */
  readonly report?: WorkflowReportEnvelope
  /** Epoch ms the attempt was dispatched. */
  readonly dispatchedAt?: number
  /** Epoch ms the attempt reached a terminal phase. */
  readonly settledAt?: number
  /** Free-form reason for `blocked`/`failed`/`timed_out`/`cancelled`. */
  readonly reason?: string
}

/** One produced file recorded by runtime observers (never by model claim). */
export interface ArtifactSnapshot {
  /** Schema version ({@link AUTOREPORT_SCHEMA_VERSION}). */
  readonly version: number
  /** Normalized workspace-relative path. */
  readonly path: string
  /** Role whose tool/process produced the file. */
  readonly producedBy: AutoReportRole
  /** Observer channel that recorded the artifact. */
  readonly origin: 'fs-tool' | 'process'
  /** Change classification; `unknown` covers unclassifiable process effects. */
  readonly status: 'created' | 'modified' | 'unknown'
  /** Owning task when known. */
  readonly taskId?: string
  /** Owning attempt key `taskId#revision` when known. */
  readonly delegationKey?: string
  /** Epoch ms of observation. */
  readonly recordedAt: number
}

/** Workflow-level metadata; latest write wins. */
export interface WorkflowMetaSnapshot {
  /** Schema version ({@link AUTOREPORT_SCHEMA_VERSION}). */
  readonly version: number
  /** Stable workflow instance id. */
  readonly workflowId: string
  /** Absolute experiment workspace root. */
  readonly workspaceRoot: string
  /** Selected report language. */
  readonly language: 'latex' | 'typst'
  /** Whether `ensureInitialized()` completed for the workspace. */
  readonly initialized: boolean
  /** Optional specialist route override (composition default at creation time). */
  readonly specialistRoute?: SpecialistRoute
  /**
   * Resolved workflow-settings snapshot frozen at creation (PLAN.md §2.14):
   * override > project > user > composition > schema defaults. Absent only on
   * logs written before this field existed; consumers fall back to composition
   * defaults ONLY in that case.
   */
  readonly settings?: WorkflowSettingsSnapshot
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Workflow-level metadata (workspace, language, initialization). Log-only
     * AutoReport fact written with `ignorable: true`; latest write wins.
     */
    'autoreport/workflow': WorkflowMetaSnapshot
    /**
     * Role↔child identity and provisioning state. Reservations land BEFORE
     * `startContinuable()` so guards authorize the child's first tool call;
     * rebinds supersede the prior binding for the role. Log-only.
     */
    'autoreport/role-binding': RoleBindingSnapshot
    /**
     * Whole task snapshot (subject, owner, checklist, dependencies, status).
     * Every mutation replaces the snapshot; replay is last-write-wins per
     * task id. Log-only.
     */
    'autoreport/task': TaskSnapshot
    /**
     * Whole delegation-attempt snapshot keyed by `(taskId, delegationRevision)`.
     * Records WHY work waits (phase), never a live waiter; late reports for
     * older revisions keep their own snapshots as stale evidence. Log-only.
     */
    'autoreport/delegation': DelegationSnapshot
    /**
     * One produced-file observation from a filesystem or process observer.
     * Model claims never create these. Log-only.
     */
    'autoreport/artifact': ArtifactSnapshot
  }
}
