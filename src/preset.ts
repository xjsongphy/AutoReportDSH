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
import { createReportTaskTool } from './tools/report-task.js'
import { createSendToAgentTool } from './tools/send-to-agent.js'
import { registerBundledSkills } from './skills-preset.js'
import type {} from './runtime.js'

export const name = 'autoreportdsh-preset'
export const inject = ['tools', 'skills', 'subagents', 'autoreportWorkflow'] as const

/**
 * Register AutoReport's preset-scoped skills and its current MAIN tools.
 * @param ctx - The `autoreport-main` preset scope.
 */
export function apply(ctx: Context): void {
  registerBundledSkills(ctx)
  ctx.tools.register(createSendToAgentTool({
    subagents: ctx.subagents,
    workflow: ctx.autoreportWorkflow,
    config: ctx.autoreportWorkflow.config,
  }))
  ctx.tools.register(createReportTaskTool(session => ctx.autoreportWorkflow.forSession(session).state))
}
