import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installReportTool } from '@deepseek-ai/dsh-tool-subagent-report'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { applyRoleSandbox } from '../policy/sandbox-roots.js'
import { installWorkflowReportTool } from './report-workflow.js'
import { installManifestTool } from './manifest.js'
import { registerRoleSkills } from '../skills-preset.js'
import { installReferencesSkills } from '../skills-references.js'

export const name = 'autoreportdsh-report-router'
export const inject = ['subagents', 'tools', 'systemPrompt', 'autoreportWorkflow']

/** Router inputs shared by every specialist branch. */
type RoutedWorkflow = Pick<AutoReportWorkflowRuntime, 'roleRegistry' | 'config' | 'workflowForChild' | 'overlayRoot'>

/**
 * Seed DSH's agent-scoped selection from the frozen workflow snapshot, then
 * release it after the child's first request — success or throw — so a later
 * composer `selectModel` can retarget that child. A continuing pin would win
 * over the Host selection the conversation-window picker writes. Main
 * inheritance installs nothing.
 */
export function installSpecialistModelSelection(childCtx: Context, workflow: RoutedWorkflow): (() => void) | undefined {
  const child = childCtx.agent as Agent
  const selected = workflow.workflowForChild(child.id)?.runtime.state.projection().meta?.settings?.specialistModel
  if (selected === undefined || selected.inheritMain) return undefined
  const route = selected
  const selection: { current: ModelSelection | undefined; assembled: ModelSelection | undefined } = {
    current: {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
    },
    assembled: undefined,
  }
  const disposeInstall = installModelSelection(childCtx, selection)
  const disposeRelease = childCtx.on('agent/request', async (_payload, next) => {
    try {
      return await next()
    } finally {
      selection.current = undefined
      selection.assembled = undefined
    }
  })
  return () => {
    disposeRelease()
    disposeInstall()
  }
}

/**
 * Route one continuable child's report surface by pre-provisioned role.
 * AutoReport children get the structured protocol and role skills; ordinary
 * DSH children keep the maintained stock implementation.
 * @param childCtx - unpublished continuable child scope.
 * @param hostCtx - host context carrying shared services.
 * @param workflow - AutoReport role registry, config, and owning-session lookup.
 * @returns child-scoped disposer.
 */
export function installRoutedReportTool(
  childCtx: Context,
  hostCtx: Context,
  workflow: RoutedWorkflow,
): () => void {
  const child = childCtx.agent as Agent
  const entry = workflow.roleRegistry.lookup(child.id)
  if (entry === undefined) return installReportTool(childCtx, hostCtx, 'next-step')

  const disposers: (() => void)[] = []
  try {
    disposers.push(installManifestTool(childCtx, hostCtx, entry.binding.role))
    disposers.push(installWorkflowReportTool(childCtx, hostCtx, entry.binding.role))
    const disposeModelSelection = installSpecialistModelSelection(childCtx, workflow)
    if (disposeModelSelection !== undefined) disposers.push(disposeModelSelection)
    const language = workflow.workflowForChild(child.id)?.runtime.state.projection().meta?.settings?.reportLanguage
      ?? workflow.config.defaultReportLanguage
    disposers.push(registerRoleSkills(childCtx, entry.binding.role, language, workflow.overlayRoot))
    disposers.push(installReferencesSkills(childCtx))
    const session = child.session
    if (session !== undefined) {
      const workspaceRoot = workflow.config.workspaceRoot ?? session.header.cwd
      if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
        applyRoleSandbox(session, entry.binding.role, workspaceRoot)
      }
    }
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // Best-effort rollback of partial registrations before rethrowing.
      }
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch (caught: unknown) {
        failures.push(caught)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke AutoReport subagent child tools')
    }
  }
}

/** Register exactly one global continuable-child setup router. */
export function apply(ctx: Context): void {
  ctx.subagents.registerContinuableSetup(childCtx => installRoutedReportTool(childCtx, ctx, ctx.autoreportWorkflow))
}
