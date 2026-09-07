/**
 * Pin each AutoReport session to workspace-write with an independent DSH
 * writable root. Navigation stays on the experiment cwd; confinement uses
 * the role directory.
 * @module
 */

import { resolve } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { rolePolicy, type AutoReportRole } from '../roles.js'

/**
 * Absolute writable root for one role under an experiment workspace.
 * @param workspaceRoot - experiment root (session cwd).
 * @param role - AutoReport role.
 * @returns canonical-enough absolute path of the role's first writable root.
 */
export function roleWritableRoot(workspaceRoot: string, role: AutoReportRole): string {
  const relative = rolePolicy(role).writableRoots[0]
  if (relative === undefined) throw new Error(`AutoReport ${role} has no writable root`)
  return resolve(workspaceRoot, relative)
}

/**
 * Record durable sandbox mode and writable-root overrides on one session.
 * Safe to call more than once: each call appends a new last-wins event.
 * @param session - MAIN or specialist session (cwd remains the experiment root).
 * @param role - role whose writable root is pinned.
 * @param workspaceRoot - experiment workspace root.
 */
export function applyRoleSandbox(session: Session, role: AutoReportRole, workspaceRoot: string): void {
  setSandboxMode(session, 'workspace-write')
  // `sandbox/workspace-root` is an AutoReport-owned extension event. The
  // current published DSH exposes no third-party setter for it; the host
  // plugin registers this event with session persistence before using it.
  // Keep the navigation cwd unchanged while the AutoReport tool guard and
  // newer DSH consumers fold this narrower writable root.
  const append = session.append as unknown as (
    type: string,
    data: unknown,
  ) => unknown
  append.call(session, 'sandbox/workspace-root', {
    workspaceRoot: roleWritableRoot(workspaceRoot, role),
  })
}
