/**
 * The single AutoReport contribution mounted in the `autoreport` preset.
 *
 * It keeps report-domain registrations preset-scoped: ordinary DSH sessions
 * retain their stock skill catalog and do not see AutoReport model tools.
 * Internal modules stay separate so domain behavior remains independently
 * testable; this composition entry deliberately exposes one product boundary.
 * @module autoreport-preset
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerMainSkills } from './skills-preset.js'
import { installReferencesSkills } from './skills-references.js'
import { installManifestTool } from './tools/manifest.js'
import { createSendToAgentTool, installSendToAgentGuidance } from './tools/send-to-agent.js'
import { installWorkflowTaskTool } from './tools/workflow-task.js'
import type {} from './runtime.js'

export const name = 'autoreport-preset'
export const inject = ['tools', 'skills', 'subagents', 'autoreportWorkflow', 'systemPrompt'] as const

/**
 * Register AutoReport's current MAIN tools.
 *
 * Each tool module owns its own usage-policy section (master dsh convention),
 * so the preset only composes them: `installSendToAgentGuidance` and
 * `installWorkflowTaskTool` mount the `tool:send_to_agent` and
 * `tool:workflow_task` sections beside the tools they describe. Domain skills
 * are registered only in role-bound specialist child scopes by the continuable
 * router.
 * @param ctx - The `autoreport` preset scope.
 */
export function apply(ctx: Context): void {
  installReferencesSkills(ctx)
  registerMainSkills(ctx)
  installSendToAgentGuidance(ctx)
  installManifestTool(ctx, ctx, 'MAIN')
  installWorkflowTaskTool(ctx, ctx)
  ctx.tools.register(createSendToAgentTool({
    subagents: ctx.subagents,
    resident: {
      ensure: (parent, role, signal) => ctx.autoreportWorkflow.ensureResidentRole(parent, role, signal),
      deliver: (parent, childSessionId, content, source, signal) =>
        ctx.autoreportWorkflow.deliverResidentChild(parent, childSessionId, content, source, signal),
    },
    deliverChild: (parent, childSessionId, content, source, signal) =>
      ctx.autoreportWorkflow.deliverChild(parent, childSessionId, content, source, signal),
    workflow: ctx.autoreportWorkflow,
    config: ctx.autoreportWorkflow.config,
  }))
}
