import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('autoreportdsh Config', () => {
  it('fills deployment defaults', () => {
    const config = Config({}) as unknown as {
      defaultReportLanguage: string
      defaultLatexEngine: string
      executionTimeoutMs: number
      defaultPythonEnv: undefined
    }
    expect(config.defaultReportLanguage).toBe('latex')
    expect(config.defaultLatexEngine).toBe('latexmk')
    expect(config.executionTimeoutMs).toBe(600_000)
  })

  it('accepts a full explicit configuration', () => {
    const config = Config({
      defaultReportLanguage: 'typst',
      defaultLatexEngine: 'tectonic',
      defaultPythonEnv: '/usr/bin/python3',
      workspaceRoot: '/tmp/exp',
      specialistModel: { provider: 'openrouter', model: 'stealth/ox-alpha' },
      executionTimeoutMs: 1000,
    }) as unknown as Record<string, unknown>
    expect(config['defaultReportLanguage']).toBe('typst')
    expect(config['specialistModel']).toEqual({ provider: 'openrouter', model: 'stealth/ox-alpha' })
  })

  it('rejects an unknown language (fail loud)', () => {
    expect(() => Config({ defaultReportLanguage: 'markdown' as never })).toThrow()
  })
})
