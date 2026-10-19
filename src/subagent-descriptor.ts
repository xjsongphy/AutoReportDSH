/**
 * Durable identity and parent-owned navigation for directly created residents.
 * DSH providers publish both a child descriptor and a parent subagent/catalog
 * fact. AutoReport creates residents through the agent factory, so it must
 * publish both facts itself, including when restoring an older resident.
 * @module subagent-descriptor
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { snapshotSubagentDescriptor, type SubagentDescriptorData } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { DSH_ROLE_ESCAPE_TOOL_NAMES, SKILL_TOOL, rolePolicy, type SpecialistRole } from './roles.js'

/** Filter DSH capabilities the fixed role policy does not assign. */
export function residentToolFilter(role: SpecialistRole, visibleTools?: ReadonlySet<string>): ToolRestriction {
  const policy = rolePolicy(role)
  // The skill loader follows the same policy: a role whose scope registers no
  // bundled skills has no catalog, so the loader must be denied too, or a
  // cold-resumed child would see a tool that only invites invented names.
  const denied = [...DSH_ROLE_ESCAPE_TOOL_NAMES, SKILL_TOOL].filter(name => !policy.tools.includes(name))
  const filtered = visibleTools === undefined ? denied : denied.filter(name => visibleTools.has(name))
  return { deny: filtered }
}

/** Compatibility alias used by tests and descriptor readers for a process role. */
export const RESIDENT_TOOL_FILTER: ToolRestriction = residentToolFilter('DATA_ANALYSIS')

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
  /** Exact role filter resolved against the child scope's registered roster. */
  readonly toolFilter?: ToolRestriction | undefined
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
    toolFilter: facts.toolFilter ?? residentToolFilter(facts.role),
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

/**
 * Publish a resident in DSH's native parent-owned catalog once. The descriptor
 * classifies the child; the catalog makes the header navigator discover it.
 * Read the child's existing identity rather than overwriting provider facts.
 */
export function ensureSubagentCatalog(parent: Session, child: Session): boolean {
  if (child.header.parentSession !== parent.id) return false
  if (parent.snapshotEvents().some(event => event.type === 'subagent/catalog' && event.data.childId === child.id)) return false
  const descriptor = child.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data
  if (descriptor?.mode !== 'continuable') return false
  parent.append('subagent/catalog', {
    version: 0,
    childId: child.id,
    childCreatedAt: child.header.createdAt,
    mode: 'continuable',
    label: descriptor.label,
  })
  return true
}
