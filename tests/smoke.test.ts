import { describe, expect, it } from 'vitest'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

describe('scaffold smoke', () => {
  it('exposes a loadable cordis plugin module', () => {
    expect(plugin.name).toBe('autoreportdsh')
    expect(typeof plugin.apply).toBe('function')
  })

  it('resolves linked @deepseek-ai/dsh-session runtime exports', () => {
    expect(typeof Session).toBe('function')
    expect(typeof Service).toBe('function')
    // Brand helper: casting a raw uuid through the branded id must round-trip.
    const id = SessionId('01890a5d-ac96-774b-bcce-b3022099b81a')
    expect(id).toBe('01890a5d-ac96-774b-bcce-b3022099b81a')
    expect(KNOWN_SESSION_EVENT_TYPES.size).toBeGreaterThan(0)
  })
})
