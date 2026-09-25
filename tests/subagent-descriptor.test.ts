/**
 * The resident child's durable identity: one `subagent/descriptor` event,
 * present before the child's first request so DSH can classify it.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ensureSubagentDescriptor,
  residentDescriptor,
  residentToolFilter,
  RESIDENT_TOOL_FILTER,
} from '../src/subagent-descriptor.js'

function childSession(id = 'resident-child'): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(id),
    createdAt: 1,
  })
}

const FACTS = {
  role: 'THEORY' as const,
  persona: 'theory persona',
  route: { provider: 'deepseek-official', model: 'deepseek-flash' },
}

describe('residentDescriptor', () => {
  it('names a continuable AutoReport role with the composition it was created under', () => {
    expect(residentDescriptor({
      ...FACTS,
      route: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    })).toMatchObject({
      mode: 'continuable',
      provider: 'spawn',
      label: 'AutoReport THEORY',
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-flash',
      agentReasoningEffort: 'low',
      persona: 'theory persona',
      toolFilter: { deny: ['send_to_agent', 'ask_user_question', 'bash'] },
    })
  })

  it('omits a route field the deployment never resolved', () => {
    const bare = residentDescriptor({ ...FACTS, route: {} })
    expect(bare).not.toHaveProperty('agentProvider')
    expect(bare).not.toHaveProperty('agentModel')
  })

  it('keeps the coordinator tools out of every resident child', () => {
    expect(RESIDENT_TOOL_FILTER).toEqual({ deny: ['send_to_agent', 'ask_user_question'] })
    expect(residentToolFilter('THEORY')).toEqual({ deny: ['send_to_agent', 'ask_user_question', 'bash'] })
    expect(residentToolFilter('DATA_ANALYSIS')).toBe(RESIDENT_TOOL_FILTER)
  })
})

describe('ensureSubagentDescriptor', () => {
  it('appends the descriptor once on a child that has none', () => {
    const child = childSession()
    expect(ensureSubagentDescriptor(child, residentDescriptor(FACTS))).toBe(true)
    const appended = child.snapshotEvents().filter(event => event.type === 'subagent/descriptor')
    expect(appended).toHaveLength(1)
    expect(appended[0]?.data).toMatchObject({ mode: 'continuable', label: 'AutoReport THEORY' })
  })

  it('is idempotent', () => {
    const child = childSession()
    ensureSubagentDescriptor(child, residentDescriptor(FACTS))
    expect(ensureSubagentDescriptor(child, residentDescriptor(FACTS))).toBe(false)
    expect(child.snapshotEvents().filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
  })

  it('leaves a descriptor an establishing provider already wrote untouched', () => {
    const child = childSession()
    child.append('subagent/descriptor', {
      version: 3,
      mode: 'continuable',
      provider: 'spawn',
      label: 'AutoReport PLOTTING',
    })
    expect(ensureSubagentDescriptor(child, residentDescriptor(FACTS))).toBe(false)
    const appended = child.snapshotEvents().filter(event => event.type === 'subagent/descriptor')
    expect(appended).toHaveLength(1)
    // The first descriptor is authoritative, so the provider's label survives.
    expect(appended[0]?.data).toMatchObject({ label: 'AutoReport PLOTTING' })
  })
})
