import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence/src/storage-contract.ts'
import { AUTOREPORT_SESSION_EVENT_TYPES, probeIgnorableMarker, registerAutoReportSessionEvents } from '../src/session-events.js'

describe('AutoReport session persistence vocabulary', () => {
  it('registers every plugin-owned event before session use', async () => {
    const missingBefore = AUTOREPORT_SESSION_EVENT_TYPES.filter(type => !KNOWN_SESSION_EVENT_TYPES.has(type))
    expect(missingBefore.length).toBeGreaterThan(0)

    const compatibility = await registerAutoReportSessionEvents()

    for (const type of AUTOREPORT_SESSION_EVENT_TYPES) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    }
    expect(compatibility.vocabularyRegistered).toBe(true)
  })

  it('is idempotent', async () => {
    await registerAutoReportSessionEvents()
    await expect(registerAutoReportSessionEvents()).resolves.toMatchObject({
      vocabularyRegistered: true,
    })
  })

  it('reports whether the running dsh persists the ignorable marker', async () => {
    const compatibility = await registerAutoReportSessionEvents()
    // The development checkout carries the append option; a stock dsh does not.
    expect(typeof compatibility.markerPersisted).toBe('boolean')
    const probe = Session.create(SessionId('probe-marker'))
    const event = probe.append('turn/start', { turn: 1 }, { ignorable: true } as never)
    expect(compatibility.markerPersisted).toBe(event.ignorable === true)
  })

  it('detects a dsh whose append ignores the ignorable option', async () => {
    const compatibility = await registerAutoReportSessionEvents({ markerProbe: () => false })
    expect(compatibility.markerPersisted).toBe(false)
    // Vocabulary registration still covers this process, so this is not fatal.
    expect(compatibility.vocabularyRegistered).toBe(true)
  })

  it('fails loud when neither mechanism can make the log loadable', async () => {
    await expect(
      registerAutoReportSessionEvents({ registries: [], markerProbe: () => false }),
    ).rejects.toThrow(/cannot make AutoReport session logs loadable/)
  })

  it('tolerates a frozen vocabulary set only when the appended marker is persisted', async () => {
    if (probeIgnorableMarker()) {
      await expect(registerAutoReportSessionEvents({ registries: [] })).resolves.toMatchObject({
        vocabularyRegistered: false,
        markerPersisted: true,
      })
    } else {
      // A stock dsh offers neither mechanism through these seams: activation
      // must fail loud rather than write logs nobody can open.
      await expect(
        registerAutoReportSessionEvents({ registries: [] }),
      ).rejects.toThrow(/cannot make AutoReport session logs loadable/)
    }
  })

  it('makes an UNMARKED autoreport log loadable once the vocabulary is registered', async () => {
    // The acceptance criterion: a session carrying AutoReport records must be
    // loadable. This is registration-only loadability — the record is stripped
    // of the persisted marker, so the registration is the sole reason it passes.
    await registerAutoReportSessionEvents()
    const session = Session.create(SessionId('vocab-load'))
    const event = session.append('autoreport/task', {
      version: 1,
      workflowId: 'wf-1',
      taskId: 'task-1',
      title: 'theory',
      status: 'open',
    } as never) as { ignorable?: boolean } & Record<string, unknown>
    const unmarked = { ...event }
    delete unmarked.ignorable

    expect(() => validateStoredEvents(session.header, [unmarked as never])).not.toThrow()

    // Control: a type nobody registered still refuses the whole log.
    const foreign = { ...unmarked, type: 'some-other-plugin/unknown' }
    expect(() => validateStoredEvents(session.header, [foreign as never]))
      .toThrow(/not marked ignorable/)
  })
})
