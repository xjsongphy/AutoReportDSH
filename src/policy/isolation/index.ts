/** Platform selection and injectable report-execution isolation. @module */

import type { IsolatedCommand, IsolationRequest } from './argv.js'
import { buildDarwinSeatbeltCommand } from './darwin-seatbelt.js'
import { buildLinuxBwrapCommand } from './linux-bwrap.js'

export type { IsolatedCommand, IsolationRequest } from './argv.js'
export { buildSeatbeltProfile, buildDarwinSeatbeltCommand } from './darwin-seatbelt.js'
export { buildLinuxBwrapCommand } from './linux-bwrap.js'

/** AutoReport process isolation capability. */
export interface IsolationBackend {
  /** Wrap exact argv under file-write and network-denial policy. */
  wrap(request: IsolationRequest, signal?: AbortSignal): Promise<IsolatedCommand>
}

/** Executable lookup supplied by DSH's subprocess execution world. */
export type ExecutableResolver = (command: string, signal?: AbortSignal) => Promise<string>

/** Stable fail-closed error for unsupported/missing isolation. */
export class IsolationUnavailableError extends Error {
  constructor(detail: string) {
    super(`AutoReport report execution is unavailable: ${detail}; refusing unisolated execution`)
    this.name = 'IsolationUnavailableError'
  }
}

/**
 * Resolve the v1 platform backend. Runner lookup uses the mounted DSH
 * subprocess service so local/remote execution worlds cannot disagree.
 */
export function createPlatformIsolationBackend(
  resolveExecutable: ExecutableResolver,
  platform: NodeJS.Platform = process.platform,
): IsolationBackend {
  switch (platform) {
    case 'linux':
      return {
        async wrap(request, signal) {
          let runner: string
          try {
            runner = await resolveExecutable('bwrap', signal)
          } catch (error: unknown) {
            throw new IsolationUnavailableError(`bubblewrap is missing (${String(error)})`)
          }
          return buildLinuxBwrapCommand(request, runner)
        },
      }
    case 'darwin':
      return {
        async wrap(request, signal) {
          let runner: string
          try {
            runner = await resolveExecutable('/usr/bin/sandbox-exec', signal)
          } catch (error: unknown) {
            throw new IsolationUnavailableError(`sandbox-exec is missing (${String(error)})`)
          }
          return buildDarwinSeatbeltCommand(request, runner)
        },
      }
    default:
      return {
        wrap() {
          return Promise.reject(new IsolationUnavailableError(`platform ${platform} has no verified network sandbox`))
        },
      }
  }
}
