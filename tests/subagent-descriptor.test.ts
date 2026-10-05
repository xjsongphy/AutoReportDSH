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
import { ROLE_PROCESS_TOOL } from '../src/roles.js'

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
      toolFilter: { deny: ['send_to_agent', 'ask_user_question', 'workflow', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'todo_write', 'glob', 'pwsh', 'bash', 'install_python_package', 'skill'] },
    })
  })

  it('omits a route field the deployment never resolved', () => {
    const bare = residentDescriptor({ ...FACTS, route: {} })
    expect(bare).not.toHaveProperty('agentProvider')
    expect(bare).not.toHaveProperty('agentModel')
  })

  it('keeps the coordinator tools out of every resident child', () => {
    const otherProcessTool = ROLE_PROCESS_TOOL === 'bash' ? 'pwsh' : 'bash'
    const delegatedTools = ['send_to_agent', 'ask_user_question', 'workflow', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'todo_write', 'glob', otherProcessTool, 'install_python_package', 'skill']
    expect(RESIDENT_TOOL_FILTER).toEqual({ deny: delegatedTools })
    expect(residentToolFilter('THEORY').deny?.slice().sort()).toEqual([...delegatedTools, ROLE_PROCESS_TOOL].sort())
    expect(residentToolFilter('DATA_ANALYSIS')).toEqual(RESIDENT_TOOL_FILTER)
  })

  it('keeps the skill loader for exactly the roles whose policy grants it', () => {
    // The policy table and the skill registry must agree: a role with no
    // registered bundled skills has no skill catalog, so the loader tool would
    // only invite invented names (session 48970218's "data-analysis" error).
    expect(residentToolFilter('THEORY').deny).toContain('skill')
    expect(residentToolFilter('DATA_ANALYSIS').deny).toContain('skill')
    expect(residentToolFilter('PLOTTING').deny).not.toContain('skill')
    expect(residentToolFilter('REPORT').deny).not.toContain('skill')
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
