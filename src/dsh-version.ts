/** Detect and enforce the exact DSH release supported by AutoReportDSH. */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The only supported DSH runtime release. */
export const VERIFIED_DSH_VERSION = '0.2.0-rc.2'

/**
 * Read the version of the running dsh CLI.
 *
 * `anchor` is the running launcher path (`process.argv[1]` in normal CLI/Web
 * operation): walk up from its directory to the package root whose manifest
 * declares the `@deepseek-ai/dsh` name, and read its version. A test or
 * embedded host without that layout resolves to `undefined`, which callers
 * report as "unknown" rather than guessing.
 * @param anchor - the launcher path to walk up from, or its directory.
 * @returns the running dsh version, or undefined when it cannot be determined.
 */
export function readRunningDshVersion(anchor: string | undefined = process.argv[1]): string | undefined {
  if (anchor === undefined || anchor === '') return undefined
  let dir = resolve(anchor)
  if (!existsSync(dir) || !dir.endsWith('.js')) dir = dirname(dir)
  else dir = dirname(dir)
  for (let cursor = dir; ; cursor = dirname(cursor)) {
    const manifest = join(cursor, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
        if (parsed.name === '@deepseek-ai/dsh' && typeof parsed.version === 'string') return parsed.version
      } catch {
        return undefined
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
  }
}

/**
 * Describe how the running dsh version relates to the verified one.
 * @param running - the running dsh version, or undefined when undetectable.
 * @returns a user-facing notice; `verified` is true only for the exact pin.
 */
export function describeDshVersionSupport(running: string | undefined): { verified: boolean; message: string } {
  if (running === undefined) {
    return {
      verified: false,
      message: `AutoReportDSH: this dsh build does not expose its version; the plugin is verified against dsh ${VERIFIED_DSH_VERSION}`,
    }
  }
  if (running === VERIFIED_DSH_VERSION) {
    return { verified: true, message: `AutoReportDSH: verified against dsh ${running}` }
  }
  return {
    verified: false,
    message: `AutoReportDSH: running dsh ${running}, but this plugin requires dsh ${VERIFIED_DSH_VERSION}`
      + ' — only dsh 0.2.0-rc.2 is supported',
  }
}
