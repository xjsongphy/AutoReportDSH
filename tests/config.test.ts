import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('autoreportdsh Config', () => {
  it('fills deployment defaults', () => {
    const config = Config({}) as unknown as {
      defaultReportLanguage: string
      delegationIdleTimeoutMs: number
      delegationWaitTimeoutMs: number
    }
    expect(config.defaultReportLanguage).toBe('latex')
    expect(config.delegationIdleTimeoutMs).toBe(60_000)
    expect(config.delegationWaitTimeoutMs).toBe(600_000)
  })

  it('accepts a full explicit configuration', () => {
    const config = Config({
      defaultReportLanguage: 'typst',
      workspaceRoot: '/tmp/exp',
      specialistModel: { provider: 'openrouter', model: 'stealth/ox-alpha' },
      delegationIdleTimeoutMs: 500,
      delegationWaitTimeoutMs: 1000,
      pythonExecutable: '/opt/python3',
    }) as unknown as Record<string, unknown>
    expect(config['defaultReportLanguage']).toBe('typst')
    expect(config['specialistModel']).toEqual({ provider: 'openrouter', model: 'stealth/ox-alpha' })
    expect(config['pythonExecutable']).toBe('/opt/python3')
    expect(config['delegationIdleTimeoutMs']).toBe(500)
    expect(config['delegationWaitTimeoutMs']).toBe(1000)
  })

  it('rejects an unknown language (fail loud)', () => {
    expect(() => Config({ defaultReportLanguage: 'markdown' as never })).toThrow()
  })
})
