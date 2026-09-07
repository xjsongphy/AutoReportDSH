import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendWorkflowEvent } from '../src/workflow/store.js'

describe('appendWorkflowEvent (persistence vocabulary)', () => {
  it('writes autoreport/* records through the official writer', () => {
    const session = Session.create(SessionId('wf-store'))
    const event = appendWorkflowEvent(session, 'autoreport/workflow', {
      version: 1,
      workflowId: 'wf-1',
      workspaceRoot: '/tmp/exp',
      language: 'latex',
      initialized: false,
    })
    expect(event.ignorable).toBeUndefined()
    expect(session.events[0]?.ignorable).toBeUndefined()
    expect(Object.isFrozen(session.events[0])).toBe(true)
  })

  it('keeps non-autoreport appends untouched by the helper contract', () => {
    const session = Session.create(SessionId('wf-store-2'))
    session.append('turn/start', { turn: 1 })
    expect(session.events[0]?.ignorable).toBeUndefined()
  })
})
