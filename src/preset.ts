/**
 * The single AutoReport contribution mounted in the `autoreport-main` preset.
 *
 * It keeps report-domain registrations preset-scoped: ordinary DSH sessions
 * retain their stock skill catalog and do not see AutoReport model tools.
 * Internal modules stay separate so domain behavior remains independently
 * testable; this composition entry deliberately exposes one product boundary.
 * @module autoreportdsh-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerMainSkills } from './skills-preset.js'
import { createReportTaskTool } from './tools/report-task.js'
import { createSendToAgentTool } from './tools/send-to-agent.js'
import type {} from './runtime.js'

export const name = 'autoreportdsh-preset'
export const inject = ['tools', 'skills', 'subagents', 'autoreportWorkflow'] as const

/**
 * Register AutoReport's current MAIN tools. Domain skills are registered only
 * in role-bound specialist child scopes by the continuable router.
 * @param ctx - The `autoreport-main` preset scope.
 */
export function apply(ctx: Context): void {
  registerMainSkills(ctx)
  ctx.tools.register(createSendToAgentTool({
    subagents: ctx.subagents,
    workflow: ctx.autoreportWorkflow,
    config: ctx.autoreportWorkflow.config,
  }))
  ctx.tools.register(createReportTaskTool(session => ctx.autoreportWorkflow.forSession(session).state))
}
