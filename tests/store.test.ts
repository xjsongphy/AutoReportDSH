import { describe, expect, it } from 'vitest'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { appendWorkflowEvent } from '../src/workflow/store.js'

describe('appendWorkflowEvent (persistence gate)', () => {
  it('writes autoreport/* records through the official writer with ignorable: true', () => {
    const session = Session.create(SessionId('wf-store'))
    const event = appendWorkflowEvent(session, 'autoreport/workflow', {
      version: 1,
      workflowId: 'wf-1',
      workspaceRoot: '/tmp/exp',
      language: 'latex',
      initialized: false,
    })
    expect(event.ignorable).toBe(true)
    expect(session.events[0]?.ignorable).toBe(true)
    expect(Object.isFrozen(session.events[0])).toBe(true)
    // The stock vocabulary must NOT contain our out-of-tree types; the
    // ignorable marker is what keeps cold loads of such logs openable.
    expect(KNOWN_SESSION_EVENT_TYPES.has('autoreport/workflow')).toBe(false)
  })

  it('keeps non-autoreport appends untouched by the helper contract', () => {
    const session = Session.create(SessionId('wf-store-2'))
    session.append('turn/start', { turn: 1 })
    expect(session.events[0]?.ignorable).toBeUndefined()
  })
})
