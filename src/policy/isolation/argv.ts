/** Shared exact-argv and path validation for report isolation builders. @module */

import { isAbsolute, normalize } from 'node:path'

/** Fully resolved process request handed to one platform builder. */
export interface IsolationRequest {
  /** Exact executable plus arguments; never shell-interpreted. */
  readonly argv: readonly string[]
  /** Absolute process working directory. */
  readonly cwd: string
  /** Absolute directories the process may read. */
  readonly readableRoots: readonly string[]
  /** Absolute directories the process may write. */
  readonly writableRoots: readonly string[]
  /** Private, caller-owned temporary directory. */
  readonly tempRoot: string
}

/** Wrapped command plus environment changes required by its private temp. */
export interface IsolatedCommand {
  /** Platform runner argv. */
  readonly argv: readonly string[]
  /** Environment layered onto DSH subprocess's scrubbed parent environment. */
  readonly env: Readonly<Record<string, string>>
}

/** Assert exact non-empty argv and absolute policy paths. */
export function validateIsolationRequest(request: IsolationRequest): void {
  if (request.argv.length === 0 || request.argv.some(value => value.length === 0 || value.includes('\0'))) {
    throw new Error('report isolation requires non-empty, NUL-free argv entries')
  }
  const paths = [request.cwd, ...request.readableRoots, ...request.writableRoots, request.tempRoot]
  if (paths.some(path => !isAbsolute(path) || path.includes('\0') || normalize(path) !== path)) {
    throw new Error('report isolation requires normalized absolute policy paths')
  }
  if (request.writableRoots.length === 0) {
    throw new Error('report isolation requires at least one writable root')
  }
}
