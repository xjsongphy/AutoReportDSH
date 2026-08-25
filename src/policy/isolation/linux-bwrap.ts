/**
 * Linux bubblewrap profile for AutoReport execution.
 *
 * This preserves DSH sandbox-local's mature bwrap file profile (`/` read-only,
 * `/dev`, private pid/proc, die-with-parent), then adds AutoReport's missing
 * network namespace and explicit private-temp/writable mounts.
 * @module
 */

import type { IsolatedCommand, IsolationRequest } from './argv.js'
import { validateIsolationRequest } from './argv.js'

/** Build one fail-closed bubblewrap command. */
export function buildLinuxBwrapCommand(request: IsolationRequest, runner = 'bwrap'): IsolatedCommand {
  validateIsolationRequest(request)
  const args = [
    runner,
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-net',
    '--proc', '/proc',
    '--die-with-parent',
    '--tmpfs', request.tempRoot,
  ]
  for (const root of request.writableRoots) args.push('--bind', root, root)
  args.push('--chdir', request.cwd, '--', ...request.argv)
  return { argv: args, env: { TMPDIR: request.tempRoot, TMP: request.tempRoot, TEMP: request.tempRoot } }
}
