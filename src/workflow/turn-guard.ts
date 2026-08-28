/**
 * Turn-stopping guards that steer specialists and MAIN toward required workflow
 * actions before a turn closes (PLAN.md §2.6). Pure decision helpers are
 * exported for tests; {@link installTurnGuards} registers the host listener.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RoleRegistry } from './role-registry.js'
import type { WorkflowProjection } from './service.js'
import type { DelegationSnapshot } from './events.js'

const PLUGIN_SOURCE = { kind: 'plugin' as const, plugin: 'autoreportdsh' as const }

const SPECIALIST_STEER_TEXT =
  'Finish the delegated task by calling report_workflow with the exact task_id and delegation_revision from your briefing.'

const MAIN_BLOCKED_STEER_TEXT =
  'A specialist task is blocked. Redispatch, repair a dependency, or ask the user.'

/** Maximum specialist steers per session turn. */
export const MAX_SPECIALIST_STEERS = 2

/** Maximum MAIN steers per session turn. */
export const MAX_MAIN_STEERS = 1

/** Blocked-task keys already surfaced, isolated per Main session. */
const acknowledgedBlockedKeysByMain = new Map<string, Set<string>>()

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

function activeDelegationForChild(
  projection: WorkflowProjection,
  childSessionId: SessionId,
): DelegationSnapshot | undefined {
  let match: DelegationSnapshot | undefined
  for (const task of projection.tasks.values()) {
    const key = task.latestDelegationRevision
    if (key === undefined) continue
    const delegation = projection.delegations.get(`${task.taskId}#${key}`)
    if (delegation === undefined) continue
    if (delegation.childSessionId !== childSessionId) continue
    if (delegation.phase !== 'dispatched' && delegation.phase !== 'waiting_for_child') continue
    if (delegation.report !== undefined) continue
    if (match === undefined || (delegation.dispatchedAt ?? 0) > (match.dispatchedAt ?? 0)) match = delegation
  }
  return match
}

/**
 * Whether a specialist child should be steered to call `report_workflow`.
 * @param roleRegistry - synchronous child authorization map.
 * @param childSessionId - specialist session id.
 * @param projection - parent workflow fold, when available.
 * @param steerCount - steers already sent this turn for this session.
 * @returns true when one more steer is warranted.
 */
export function shouldSteerSpecialist(
  roleRegistry: RoleRegistry,
  childSessionId: SessionId,
  projection: WorkflowProjection | undefined,
  steerCount: number,
): boolean {
  if (steerCount >= MAX_SPECIALIST_STEERS) return false
  if (roleRegistry.lookup(childSessionId) === undefined) return false
  if (projection === undefined) return false
  return activeDelegationForChild(projection, childSessionId) !== undefined
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

/**
 * Register turn-stopping guards on the host context.
 * @param ctx - Cordis context receiving `agent/turn-stopping`.
 * @param deps - role registry and workflow lookups supplied by the host runtime.
 * @returns disposer removing the listener.
 */
export function installTurnGuards(ctx: Context, deps: TurnGuardDependencies): () => void {
  const steerState = new Map<string, { turn: number; count: number }>()

  const steerCountFor = (sessionId: string, turn: number): number => {
    const current = steerState.get(sessionId)
    if (current === undefined || current.turn !== turn) return 0
    return current.count
  }

  const bumpSteer = (sessionId: string, turn: number): void => {
    steerState.set(sessionId, { turn, count: steerCountFor(sessionId, turn) + 1 })
  }

  const listener = ({ agent, turn }: { agent: Agent; turn: number }): void => {
    const session = agent.session
    const sessionId = String(session.id)
    const steerCount = steerCountFor(sessionId, turn)

    const projection = deps.getProjection(sessionId)
    if (deps.isMainSession(session.id)) {
      const newlyBlocked = newlyBlockedTaskKeys(sessionId, projection).length > 0
      if (shouldSteerMain(projection, steerCount, newlyBlocked)) {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: MAIN_BLOCKED_STEER_TEXT }],
          source: PLUGIN_SOURCE,
        }))
        bumpSteer(sessionId, turn)
      }
      acknowledgeCurrentBlockedKeys(sessionId, projection)
      return
    }

    if (!shouldSteerSpecialist(deps.roleRegistry, session.id, projection, steerCount)) return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: SPECIALIST_STEER_TEXT }],
      source: PLUGIN_SOURCE,
    }))
    bumpSteer(sessionId, turn)
  }

  const dispose = ctx.on('agent/turn-stopping', listener)
  return () => {
    dispose()
    steerState.clear()
  }
}
