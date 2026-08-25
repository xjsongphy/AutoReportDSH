/**
 * macOS Seatbelt profile for AutoReport execution.
 *
 * DSH's local sandbox establishes file-write authority with `allow default`,
 * `deny file-write*`, then narrow subpath grants. AutoReport reuses that
 * established dialect and adds `deny network*`; the subprocess lifecycle stays
 * with `ctx.subprocess`.
 * @module
 */

import type { IsolatedCommand, IsolationRequest } from './argv.js'
import { validateIsolationRequest } from './argv.js'

function sbplString(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** Build the SBPL profile text separately for focused review/testing. */
export function buildSeatbeltProfile(request: IsolationRequest): string {
  validateIsolationRequest(request)
  const writeRoots = [...new Set([...request.writableRoots, request.tempRoot])]
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
    `(allow file-write* ${writeRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`,
  ].join(' ')
}

/** Build one fail-closed sandbox-exec command. */
export function buildDarwinSeatbeltCommand(
  request: IsolationRequest,
  runner = '/usr/bin/sandbox-exec',
): IsolatedCommand {
  const profile = buildSeatbeltProfile(request)
  return {
    argv: [runner, '-p', profile, '--', ...request.argv],
    env: { TMPDIR: request.tempRoot, TMP: request.tempRoot, TEMP: request.tempRoot },
  }
}
