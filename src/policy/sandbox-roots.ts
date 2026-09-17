/**
 * Pin each AutoReport session to `workspace-write` sandbox mode. The role
 * writable root itself is resolved by the sandbox-policy override
 * (`sandbox-override.ts`) at enforcement time; navigation stays on the
 * experiment cwd.
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
 * Pin `workspace-write` on one AutoReport session. Safe to call more than
 * once: the last event wins. The role's writable root is NOT logged here —
 * the host sandbox-policy override derives it from role membership at every
 * enforcement call, so no session-vocabulary extension is needed.
 * @param session - MAIN or specialist session (cwd remains the experiment root).
 * @param role - role whose writable root the override resolves.
 * @param workspaceRoot - experiment workspace root; the mode pin does not
 *   need it, but call sites resolve it alongside the role.
 */
export function applyRoleSandbox(session: Session, _role: AutoReportRole, _workspaceRoot?: string): void {
  setSandboxMode(session, 'workspace-write')
}
