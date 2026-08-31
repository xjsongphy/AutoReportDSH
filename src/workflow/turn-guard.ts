/**
 * Turn-stopping guards that steer specialists and MAIN toward required workflow
 * actions before a turn closes (PLAN.md §2.6). Pure decision helpers are
 * exported for tests; {@link installTurnGuards} registers the host listener.
 *
 * Specialist order is manifest freshness first, then forgotten
 * `report_workflow`. Each reason is capped once per turn so a ignored
 * manifest reminder cannot consume the report reminder.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  formatManifestSteer,
  MAIN_STEER_SUMMARY,
  MANIFEST_STEER_SUMMARY,
  REPORT_STEER_SUMMARY,
  TURN_GUARD_PLUGIN,
} from './display.js'
import { openDelegationForChild, staleDescribedPaths } from './file-notes.js'
import type { RoleRegistry } from './role-registry.js'
import type { WorkflowProjection } from './service.js'

const SPECIALIST_REPORT_STEER_TEXT =
  'Finish the delegated task by calling report_workflow with the exact task_id and delegation_revision from your briefing.'

const MAIN_BLOCKED_STEER_TEXT =
  'A subagent task is blocked. Redispatch, repair a dependency, or ask the user.'

/** Maximum specialist steers of each reason per session turn. */
export const MAX_MANIFEST_STEERS = 1
/** Maximum forgotten-report steers per session turn. */
export const MAX_REPORT_STEERS = 1
/** Combined specialist steer budget (manifest + report). */
export const MAX_SPECIALIST_STEERS = MAX_MANIFEST_STEERS + MAX_REPORT_STEERS

/** Maximum MAIN steers per session turn. */
export const MAX_MAIN_STEERS = 1

/** Why a specialist turn was steered rather than allowed to stop. */
export type SpecialistSteerReason = 'manifest' | 'report'

/** Per-reason steer counts for one specialist turn. */
export interface SpecialistSteerCounts {
  readonly manifest: number
  readonly report: number
}

/** Blocked-task keys already surfaced, isolated per Main session. */
const acknowledgedBlockedKeysByMain = new Map<string, Set<string>>()

function noticeSource(summary: string) {
  return {
    kind: 'plugin' as const,
    plugin: TURN_GUARD_PLUGIN,
    form: 'notice' as const,
    summary: boundContextSummary(summary),
  }
}

function blockedTaskKey(taskId: string, revision: number): string {
  return `${taskId}#${revision}`
}

function blockedKeysFromProjection(projection: WorkflowProjection): Set<string> {
  const keys = new Set<string>()
  for (const task of projection.tasks.values()) {
    if (task.status === 'blocked') keys.add(blockedTaskKey(task.taskId, task.revision))
  }
  return keys
}

function acknowledgedSet(sessionId: string): Set<string> {
  let keys = acknowledgedBlockedKeysByMain.get(sessionId)
  if (keys === undefined) {
    keys = new Set()
    acknowledgedBlockedKeysByMain.set(sessionId, keys)
  }
  return keys
}

/**
 * Blocked keys in `projection` not yet acknowledged for this Main session.
 * @param sessionId - Main session id owning the workflow.
 * @param projection - workflow fold for that Main session.
 * @returns keys that would trigger a new MAIN steer.
 */
export function newlyBlockedTaskKeys(sessionId: string, projection: WorkflowProjection | undefined): string[] {
  if (projection === undefined) return []
  const acknowledged = acknowledgedBlockedKeysByMain.get(sessionId) ?? new Set<string>()
  const keys: string[] = []
  for (const task of projection.tasks.values()) {
    if (task.status !== 'blocked') continue
    const key = blockedTaskKey(task.taskId, task.revision)
    if (!acknowledged.has(key)) keys.push(key)
  }
  return keys
}

/**
 * Acknowledge currently blocked keys for one Main session and drop stale
 * entries no longer blocked in that session's projection.
 * @param sessionId - Main session id owning the workflow.
 * @param projection - workflow fold for that Main session.
 */
export function acknowledgeCurrentBlockedKeys(sessionId: string, projection: WorkflowProjection | undefined): void {
  if (projection === undefined) {
    acknowledgedBlockedKeysByMain.delete(sessionId)
    return
  }
  const current = blockedKeysFromProjection(projection)
  const acknowledged = acknowledgedSet(sessionId)
  for (const key of [...acknowledged]) {
    if (!current.has(key)) acknowledged.delete(key)
  }
  for (const key of current) acknowledged.add(key)
}

/** Clear acknowledged blocked keys (test isolation). */
export function resetAcknowledgedBlockedKeys(): void {
  acknowledgedBlockedKeysByMain.clear()
}

/**
 * Next specialist invariant to enforce before the turn may stop.
 * Manifest freshness is checked before forgotten `report_workflow`.
 * @param roleRegistry - synchronous child authorization map.
 * @param childSessionId - specialist session id.
 * @param projection - parent workflow fold, when available.
 * @param counts - steers already sent this turn for each reason.
 * @returns the reason to steer, or undefined when the turn may stop.
 */
export function nextSpecialistSteer(
  roleRegistry: RoleRegistry,
  childSessionId: SessionId,
  projection: WorkflowProjection | undefined,
  counts: SpecialistSteerCounts,
): SpecialistSteerReason | undefined {
  if (roleRegistry.lookup(childSessionId) === undefined) return undefined
  if (projection === undefined) return undefined
  const stale = staleDescribedPaths(projection, childSessionId)
  if (stale.length > 0 && counts.manifest < MAX_MANIFEST_STEERS) return 'manifest'
  if (
    counts.report < MAX_REPORT_STEERS
    && openDelegationForChild(projection, childSessionId) !== undefined
  ) return 'report'
  return undefined
}

/**
 * Whether a specialist child should be steered (either reason).
 * @param roleRegistry - synchronous child authorization map.
 * @param childSessionId - specialist session id.
 * @param projection - parent workflow fold, when available.
 * @param counts - steers already sent this turn for each reason.
 * @returns true when one more steer is warranted.
 */
export function shouldSteerSpecialist(
  roleRegistry: RoleRegistry,
  childSessionId: SessionId,
  projection: WorkflowProjection | undefined,
  counts: SpecialistSteerCounts | number,
): boolean {
  const normalized = typeof counts === 'number'
    ? { manifest: 0, report: counts }
    : counts
  return nextSpecialistSteer(roleRegistry, childSessionId, projection, normalized) !== undefined
}

/**
 * Whether MAIN should be steered for a newly blocked specialist task.
 * @param projection - workflow fold for the Main session.
 * @param steerCount - steers already sent this turn for this session.
 * @param newlyBlocked - true when at least one blocked `taskId#revision` is unacknowledged.
 * @returns true when one more steer is warranted.
 */
export function shouldSteerMain(
  projection: WorkflowProjection | undefined,
  steerCount: number,
  newlyBlocked: boolean,
): boolean {
  if (steerCount >= MAX_MAIN_STEERS) return false
  if (projection === undefined) return false
  return newlyBlocked
}

/** Dependencies for {@link installTurnGuards}. */
export interface TurnGuardDependencies {
  readonly roleRegistry: RoleRegistry
  readonly isMainSession: (id: SessionId) => boolean
  readonly getProjection: (sessionId: string) => WorkflowProjection | undefined
}

interface SteerState {
  turn: number
  main: number
  manifest: number
  report: number
}

/**
 * Register turn-stopping guards on the host context.
 * @param ctx - Cordis context receiving `agent/turn-stopping`.
 * @param deps - role registry and workflow lookups supplied by the host runtime.
 * @returns disposer removing the listener.
 */
export function installTurnGuards(ctx: Context, deps: TurnGuardDependencies): () => void {
  const steerState = new Map<string, SteerState>()

  const stateFor = (sessionId: string, turn: number): SteerState => {
    const current = steerState.get(sessionId)
    if (current === undefined || current.turn !== turn) {
      return { turn, main: 0, manifest: 0, report: 0 }
    }
    return current
  }

  const listener = ({ agent, turn }: { agent: Agent; turn: number }): void => {
    const session = agent.session
    const sessionId = String(session.id)
    const counts = stateFor(sessionId, turn)
    const projection = deps.getProjection(sessionId)

    if (deps.isMainSession(session.id)) {
      const newlyBlocked = newlyBlockedTaskKeys(sessionId, projection).length > 0
      if (shouldSteerMain(projection, counts.main, newlyBlocked)) {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: MAIN_BLOCKED_STEER_TEXT }],
          source: noticeSource(MAIN_STEER_SUMMARY),
        }))
        steerState.set(sessionId, { ...counts, turn, main: counts.main + 1 })
      }
      acknowledgeCurrentBlockedKeys(sessionId, projection)
      return
    }

    const reason = nextSpecialistSteer(deps.roleRegistry, session.id, projection, counts)
    if (reason === 'manifest') {
      const stale = projection === undefined ? [] : staleDescribedPaths(projection, session.id)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: formatManifestSteer(stale) }],
        source: noticeSource(MANIFEST_STEER_SUMMARY),
      }))
      steerState.set(sessionId, { ...counts, turn, manifest: counts.manifest + 1 })
      return
    }
    if (reason === 'report') {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: SPECIALIST_REPORT_STEER_TEXT }],
        source: noticeSource(REPORT_STEER_SUMMARY),
      }))
      steerState.set(sessionId, { ...counts, turn, report: counts.report + 1 })
    }
  }

  const dispose = ctx.on('agent/turn-stopping', listener)
  return () => {
    dispose()
    steerState.clear()
  }
}
