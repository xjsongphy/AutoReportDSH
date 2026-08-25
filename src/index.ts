/**
 * AutoReportDSH host-plane plugin entry.
 *
 * This phase ships the loadable skeleton only. Later phases register the
 * report workflow service, durable projections, `/report-init`, the role
 * policy guard, and the report-execution capability from this `apply`.
 *
 * @module autoreportdsh
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'autoreportdsh'

/**
 * Apply the AutoReport domain plugin to a harness context.
 * @param ctx - host-plane context the Loader activates this plugin under.
 */
export function apply(ctx: Context): void {
  // Phase scaffold: nothing registered yet. Registrations are effects; later
  // phases add them here with their own disposers via ctx.effect()/ctx.on().
  void ctx
}
