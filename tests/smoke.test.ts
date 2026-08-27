import { describe, expect, it } from 'vitest'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

describe('scaffold smoke', () => {
  it('exposes a loadable cordis plugin module', () => {
    expect(plugin.name).toBe('autoreportdsh')
    expect(typeof plugin.apply).toBe('function')
  })

  it('declares a web client half for the settings card', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      dsh: { client: { platform: string } }
    }
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.exports['./client']).toEqual({ default: './dist/client.js' })
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
