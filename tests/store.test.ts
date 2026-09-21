import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence/src/storage-contract.ts'
import { probeIgnorableMarker } from '../src/session-events.js'
import { appendWorkflowEvent } from '../src/workflow/store.js'

describe('appendWorkflowEvent (persistence vocabulary)', () => {
  it('writes autoreport/* records as ignorable through the official writer', () => {
    const session = Session.create(SessionId('wf-store'))
    const event = appendWorkflowEvent(session, 'autoreport/workflow', {
      version: 1,
      workflowId: 'wf-1',
      workspaceRoot: '/tmp/exp',
      language: 'latex',
      initialized: false,
    })
    if (probeIgnorableMarker()) {
      expect(event.ignorable).toBe(true)
      expect(session.snapshotEvents()[0]?.ignorable).toBe(true)
    } else {
      // A stock dsh ignores the option argument until it ships the append
      // option; the helper still passes it, so the call is forward-compatible.
      expect(event.ignorable).toBeUndefined()
    }
    expect(Object.isFrozen(session.snapshotEvents()[0])).toBe(true)
  })

  it('cold-resumes through the persistence vocabulary gate without registration', () => {
    // The persisted `ignorable` marker is the compatibility mechanism: the
    // first-party storage validator accepts the unknown type because it is
    // marked ignorable, and rejects the same log when the marker is absent.
    const session = Session.create(SessionId('wf-resume'))
    const event = appendWorkflowEvent(session, 'autoreport/task', {
      version: 1,
      workflowId: 'wf-1',
      taskId: 'task-1',
      title: 'theory',
      status: 'open',
    })
    if (!probeIgnorableMarker()) {
      // A stock dsh cannot persist the marker, so the unregistered unknown
      // type must refuse the log — exactly why activation registers the
      // vocabulary in-process on such a harness.
      expect(() => validateStoredEvents(session.header, [event])).toThrow(/not marked ignorable/)
      return
    }
    expect(() =>
      validateStoredEvents(session.header, [event]),
    ).not.toThrow()
    const unmarked = { ...event }
    delete (unmarked as { ignorable?: boolean }).ignorable
    expect(() =>
      validateStoredEvents(session.header, [unmarked as typeof event]),
    ).toThrow(/not marked ignorable/)
  })

  it('keeps non-autoreport appends untouched by the helper contract', () => {
    const session = Session.create(SessionId('wf-store-2'))
    session.append('turn/start', { turn: 1 })
    expect(session.snapshotEvents()[0]?.ignorable).toBeUndefined()
  })
})
