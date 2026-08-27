/** Additive execution-policy registration used by the later assembled plugin. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { RoleRegistry } from '../workflow/role-registry.js'
import { createRoleToolGuard, type RoleGuardOptions } from './tool-guard.js'

/** Registration inputs shared by the final host/child assembly. */
export interface ExecutionPolicyOptions extends RoleGuardOptions {
  /** One synchronous authorization registry for guard and executor. */
  readonly registry: RoleRegistry
}

/**
 * Register the global monotonic role guard.
 * The integration layer controls the calling scope; this function makes no
 * assumptions about preset loading and leaves `src/index.ts` untouched.
 * @returns disposer that attempts guard registration.
 */
export function registerExecutionPolicy(ctx: Context, options: ExecutionPolicyOptions): () => void {
  return ctx.tools.guard(createRoleToolGuard(options))
}
