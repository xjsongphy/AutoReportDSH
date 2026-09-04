/** Read-only MinerU CLI/authentication availability for the settings surface. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MineruStatus } from './client/mineru-status-types.js'

export type { MineruStatus } from './client/mineru-status-types.js'

const MINERU_COMMAND = 'mineru-open-api'

/** Detect whether a command resolves through the Host process's PATH. */
function commandInstalled(env: NodeJS.ProcessEnv): boolean {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = spawnSync(lookup, [MINERU_COMMAND], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    })
    return result.status === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

/** Read a top-level MinerU token without logging or returning its value. */
function configHasToken(home: string): boolean {
  try {
    const config = readFileSync(join(home, '.mineru', 'config.yaml'), 'utf8')
    return config.split(/\r?\n/u).some(line => {
      const match = /^\s*token\s*:\s*(.*?)\s*(?:#.*)?$/u.exec(line)
      if (match === null) return false
      const value = match[1]?.trim() ?? ''
      return value.length > 0 && value !== '""' && value !== "''"
    })
  } catch {
    return false
  }
}

/** Detect the local MinerU command and whether precision-extraction auth is configured. */
export function detectMineruStatus(options: {
  env?: NodeJS.ProcessEnv
  home?: string
} = {}): MineruStatus {
  const env = options.env ?? process.env
  const environmentToken = env.MINERU_TOKEN?.trim().length
  const hasEnvironmentToken = environmentToken !== undefined && environmentToken > 0
  const hasConfigToken = !hasEnvironmentToken && configHasToken(options.home ?? homedir())
  return {
    installed: commandInstalled(env),
    tokenConfigured: hasEnvironmentToken || hasConfigToken,
    ...(hasEnvironmentToken
      ? { tokenSource: 'environment' as const }
      : hasConfigToken ? { tokenSource: 'config' as const } : {}),
  }
}
