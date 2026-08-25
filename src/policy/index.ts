/** Additive execution-policy registration used by the later assembled plugin. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { RoleRegistry } from '../workflow/role-registry.js'
import { createReportExecTool, type ReportExecOptions } from '../tools/report-exec.js'
import { createRoleToolGuard, type RoleGuardOptions } from './tool-guard.js'

/** Registration inputs shared by the final host/child assembly. */
export interface ExecutionPolicyOptions extends Omit<RoleGuardOptions, 'registry'>,
  Omit<ReportExecOptions, 'registry' | 'workspaceRoot'> {
  /** One synchronous authorization registry for guard and executor. */
  readonly registry: RoleRegistry
}

/**
 * Register the global monotonic guard and specialist executor definition.
 * The integration layer controls the calling scope; this function makes no
 * assumptions about preset loading and leaves `src/index.ts` untouched.
 * @returns disposer that attempts both registrations.
 */
export function registerExecutionPolicy(ctx: Context, options: ExecutionPolicyOptions): () => void {
  const guard = ctx.tools.guard(createRoleToolGuard(options))
  let tool: () => void
  try {
    tool = ctx.tools.register(createReportExecTool(ctx, options))
  } catch (error: unknown) {
    guard()
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [tool, guard]) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to dispose AutoReport execution policy')
  }
}
