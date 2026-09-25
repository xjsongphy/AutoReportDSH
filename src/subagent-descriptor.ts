/**
 * The resident child's durable identity in DSH's own subagent vocabulary.
 *
 * A child created through a `ctx.subagents` provider is classified by the
 * `subagent/descriptor` event that provider appends inside the child's initial
 * turn. AutoReport's resident roles are created directly — no provider runs —
 * so this module appends the same payload the continuation provider snapshots
 * (`@deepseek-ai/dsh-subagent`, `continuation.ts`). Without it DSH's catalog
 * cannot classify the child: `listChildren` drops a live child that carries no
 * identity, so the session header can only show disabled placeholder rows, and
 * a cold read of the child would rebuild it under the deployment default
 * composition instead of the one it actually ran (session log 70e9fb99 →
 * children 877b9437, 6e57e8d7).
 *
 * The append happens at creation rather than inside the first turn, because a
 * resident role is created idle and its first turn may be much later — or, for
 * a role the workflow never dispatches, never.
 * @module subagent-descriptor
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { snapshotSubagentDescriptor, type SubagentDescriptorData } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SpecialistRole } from './roles.js'

/**
 * Tools every resident child is denied: delegation belongs to MAIN, and a
 * role never asks the user anything directly.
 */
export const RESIDENT_TOOL_FILTER: ToolRestriction = { deny: ['send_to_agent', 'ask_user_question'] }

/** Match the original AutoReport role capability: THEORY can inspect the
 * workspace and maintain its own files, but has no shell execution tool. */
export function residentToolFilter(role: SpecialistRole): ToolRestriction {
  return role === 'THEORY'
    ? { deny: ['send_to_agent', 'ask_user_question', 'bash'] }
    : RESIDENT_TOOL_FILTER
}

/** Composition facts one resident child was created under. */
export interface ResidentDescriptorFacts {
  /** Fixed role the child serves. */
  readonly role: SpecialistRole
  /** Route resolved for that child, as passed to its creation options. */
  readonly route: {
    readonly provider?: string | undefined
    readonly model?: string | undefined
    readonly reasoningEffort?: ReasoningEffortId | undefined
  }
  /** Role persona shadowing the deployment persona in the child's prompt. */
  readonly persona: string
}

/**
 * Snapshot one resident child's descriptor payload.
 * @param facts - the role, resolved route, and persona it was created under.
 * @returns the versioned continuable descriptor for `subagent/descriptor`.
 */
export function residentDescriptor(facts: ResidentDescriptorFacts): SubagentDescriptorData {
  return snapshotSubagentDescriptor({
    mode: 'continuable',
    // The provider name DSH knows this child's composition by; residents are
    // in-process children, exactly like the ones the spawn provider publishes.
    provider: 'spawn',
    label: `AutoReport ${facts.role}`,
    ...(facts.route.provider === undefined ? {} : { agentProvider: facts.route.provider }),
    ...(facts.route.model === undefined ? {} : { agentModel: facts.route.model }),
    ...(facts.route.reasoningEffort === undefined ? {} : { agentReasoningEffort: facts.route.reasoningEffort }),
    persona: facts.persona,
    toolFilter: residentToolFilter(facts.role),
  })
}

/**
 * Append one resident child's descriptor unless its log already carries one.
 *
 * The first descriptor is authoritative for DSH, so a child an establishing
 * provider already classified keeps that identity untouched — this only fills
 * the gap left by direct creation.
 * @param child - the resident child's Session.
 * @param descriptor - payload from {@link residentDescriptor}.
 * @returns whether this call appended the descriptor.
 */
export function ensureSubagentDescriptor(child: Session, descriptor: SubagentDescriptorData): boolean {
  if (child.snapshotEvents().some(event => event.type === 'subagent/descriptor')) return false
  child.append('subagent/descriptor', descriptor)
  return true
}
