import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { AUTOREPORT_SESSION_EVENT_TYPES, registerAutoReportSessionEvents } from '../src/session-events.js'

describe('AutoReport session persistence vocabulary', () => {
  it('registers every plugin-owned event before session use', async () => {
    const missingBefore = AUTOREPORT_SESSION_EVENT_TYPES.filter(type => !KNOWN_SESSION_EVENT_TYPES.has(type))
    expect(missingBefore.length).toBeGreaterThan(0)

    await registerAutoReportSessionEvents()

    for (const type of AUTOREPORT_SESSION_EVENT_TYPES) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true)
    }
  })

  it('is idempotent', async () => {
    await registerAutoReportSessionEvents()
    await expect(registerAutoReportSessionEvents()).resolves.toBeUndefined()
  })
})
