import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AUTOREPORT_MAIN_PRESET, isAutoReportMainSession, resolveAgentPreset } from '../src/membership.js'

/** A detached root session whose header names its composing agent preset. */
function rootSession(id: string, preset: string | undefined): Session {
  return Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: Date.now(),
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
}

describe('AutoReport session membership', () => {
  it('treats only top-level autoreport-main sessions as MAIN roots', () => {
    expect(isAutoReportMainSession(rootSession('main', AUTOREPORT_MAIN_PRESET))).toBe(true)
    // Any other preset — including the stock composition — stays foreign.
    expect(isAutoReportMainSession(rootSession('stock', undefined))).toBe(false)
    expect(isAutoReportMainSession(rootSession('other', 'some-other-preset'))).toBe(false)
  })

  it('never admits continuable children through the preset alone', () => {
    const child = Session.create(SessionId('child'), undefined, {
      version: 0,
      id: SessionId('child'),
      createdAt: Date.now(),
      parentSession: SessionId('main'),
      agentPreset: AUTOREPORT_MAIN_PRESET,
    })
    expect(isAutoReportMainSession(child)).toBe(false)
  })

  it('resolves a logged preset selection over the creation header', () => {
    const switched = rootSession('switched', AUTOREPORT_MAIN_PRESET)
    switched.append('agent-preset/selected', { agentPreset: 'minimal' })
    expect(resolveAgentPreset(switched)).toBe('minimal')
    expect(isAutoReportMainSession(switched)).toBe(false)

    const upgraded = rootSession('upgraded', undefined)
    upgraded.append('agent-preset/selected', { agentPreset: AUTOREPORT_MAIN_PRESET })
    expect(resolveAgentPreset(upgraded)).toBe(AUTOREPORT_MAIN_PRESET)
    expect(isAutoReportMainSession(upgraded)).toBe(true)

    // Newest selection wins.
    upgraded.append('agent-preset/selected', { agentPreset: 'third' })
    expect(resolveAgentPreset(upgraded)).toBe('third')
    expect(isAutoReportMainSession(upgraded)).toBe(false)
  })

  it('falls back to the header when no selection event exists', () => {
    const plain = rootSession('plain', undefined)
    plain.append('turn/start', { turn: 1 })
    expect(resolveAgentPreset(plain)).toBeUndefined()
    expect(resolveAgentPreset(rootSession('preset', AUTOREPORT_MAIN_PRESET))).toBe(AUTOREPORT_MAIN_PRESET)
  })
})
