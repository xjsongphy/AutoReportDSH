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
  'A specialist task is blocked. Redispatch, repair a dependency, ask the user, or explicitly leave it blocked.'

/** Maximum specialist steers per session turn. */
export const MAX_SPECIALIST_STEERS = 2

/** Maximum MAIN steers per session turn. */
export const MAX_MAIN_STEERS = 1

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
 * Whether MAIN should be steered when a specialist task is blocked.
 * @param projection - workflow fold for the Main session.
 * @param steerCount - steers already sent this turn for this session.
 * @returns true when one more steer is warranted.
 */
export function shouldSteerMain(
  projection: WorkflowProjection | undefined,
  steerCount: number,
): boolean {
  if (steerCount >= MAX_MAIN_STEERS) return false
  if (projection === undefined) return false
  for (const task of projection.tasks.values()) {
    if (task.status === 'blocked') return true
  }
  return false
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
  const steerCounts = new Map<string, number>()

  const listener = ({ agent, turn }: { agent: Agent; turn: number }): void => {
    const session = agent.session
    const sessionId = String(session.id)
    const turnKey = `${sessionId}:${String(turn)}`
    const steerCount = steerCounts.get(turnKey) ?? 0

    const projection = deps.getProjection(sessionId)
    if (deps.isMainSession(session.id)) {
      if (!shouldSteerMain(projection, steerCount)) return
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: MAIN_BLOCKED_STEER_TEXT }],
        source: PLUGIN_SOURCE,
      }))
      steerCounts.set(turnKey, steerCount + 1)
      return
    }

    if (!shouldSteerSpecialist(deps.roleRegistry, session.id, projection, steerCount)) return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: SPECIALIST_STEER_TEXT }],
      source: PLUGIN_SOURCE,
    }))
    steerCounts.set(turnKey, steerCount + 1)
  }

  const dispose = ctx.on('agent/turn-stopping', listener)
  return () => { dispose() }
}
