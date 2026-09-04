import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectMineruStatus } from '../src/mineru-status.js'

describe('detectMineruStatus', () => {
  it('recognizes an environment token without exposing its value', () => {
    const status = detectMineruStatus({
      env: { ...process.env, MINERU_TOKEN: 'secret-token' },
      home: '/definitely/not-a-real-home',
    })

    expect(status.tokenConfigured).toBe(true)
    expect(status.tokenSource).toBe('environment')
    expect(status).not.toHaveProperty('token')
  })

  it('recognizes a token in the MinerU config file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'autoreport-mineru-'))
    await mkdir(join(home, '.mineru'))
    await writeFile(join(home, '.mineru', 'config.yaml'), 'token: configured-token\n', 'utf8')

    const status = detectMineruStatus({
      env: { ...process.env, MINERU_TOKEN: '' },
      home,
    })

    expect(status.tokenConfigured).toBe(true)
    expect(status.tokenSource).toBe('config')
    expect(status).not.toHaveProperty('token')
  })
})
