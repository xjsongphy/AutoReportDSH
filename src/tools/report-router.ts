import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installReportTool } from '@deepseek-ai/dsh-tool-subagent-report'
import { createReportExecTool } from './report-exec.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { installWorkflowReportTool } from './report-workflow.js'

export const name = 'autoreportdsh-report-router'
export const inject = ['subagents', 'tools', 'systemPrompt', 'autoreportWorkflow']

/**
 * Route one continuable child's report surface by pre-provisioned role.
 * AutoReport children get the structured protocol plus `report_exec`;
 * ordinary DSH children keep the maintained stock implementation.
 * @param childCtx - unpublished continuable child scope.
 * @param hostCtx - host context carrying shared services.
 * @param workflow - AutoReport role registry and config.
 * @returns child-scoped disposer.
 */
export function installRoutedReportTool(
  childCtx: Context,
  hostCtx: Context,
  workflow: Pick<AutoReportWorkflowRuntime, 'roleRegistry' | 'config'>,
): () => void {
  const child = childCtx.agent as Agent
  const entry = workflow.roleRegistry.lookup(child.id)
  if (entry === undefined) return installReportTool(childCtx, hostCtx, 'next-step')

  const disposeReport = installWorkflowReportTool(childCtx, hostCtx, entry.binding.role)
  let disposeExec: () => void
  try {
    disposeExec = childCtx.tools.register(createReportExecTool(hostCtx, {
      registry: workflow.roleRegistry,
      ...(workflow.config.workspaceRoot === undefined ? {} : { workspaceRoot: workflow.config.workspaceRoot }),
    }))
  } catch (error: unknown) {
    disposeReport()
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeExec, disposeReport]) {
      try {
        dispose()
      } catch (caught: unknown) {
        failures.push(caught)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke AutoReport specialist child tools')
    }
  }
}

/** Register exactly one global continuable-child setup router. */
export function apply(ctx: Context): void {
  ctx.subagents.registerContinuableSetup(childCtx => installRoutedReportTool(childCtx, ctx, ctx.autoreportWorkflow))
}
