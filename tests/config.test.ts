import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('autoreportdsh Config', () => {
  it('fills deployment defaults', () => {
    const config = Config({}) as unknown as {
      reportLanguage: string
      latexEngine: string
      executionTimeoutMs: number
      pythonEnv: undefined
    }
    expect(config.reportLanguage).toBe('latex')
    expect(config.latexEngine).toBe('latexmk')
    expect(config.executionTimeoutMs).toBe(600_000)
  })

  it('accepts a full explicit configuration', () => {
    const config = Config({
      reportLanguage: 'typst',
      latexEngine: 'tectonic',
      pythonEnv: '/usr/bin/python3',
      workspaceRoot: '/tmp/exp',
      specialistRoute: { provider: 'openrouter', model: 'stealth/ox-alpha' },
      executionTimeoutMs: 1000,
    }) as unknown as Record<string, unknown>
    expect(config['reportLanguage']).toBe('typst')
    expect(config['specialistRoute']).toEqual({ provider: 'openrouter', model: 'stealth/ox-alpha' })
  })

  it('rejects an unknown language (fail loud)', () => {
    expect(() => Config({ reportLanguage: 'markdown' as never })).toThrow()
  })
})
