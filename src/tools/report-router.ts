import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { applyRoleSandbox } from '../policy/sandbox-roots.js'
import { installWorkflowReportTool } from './report-workflow.js'
import { installManifestTool } from './manifest.js'
import { registerRoleSkills, type ReportSkillLanguage } from '../skills-preset.js'
import { installReferencesSkills } from '../skills-references.js'

/** Entry file, theme, language guidance, and compile skill per report language. */
const REPORT_ENVIRONMENTS: Readonly<Record<ReportSkillLanguage, { entry: string; theme: string; languageSkill: string; compileSkill: string }>> = {
  latex: { entry: 'Report/main.tex', theme: 'Report/mpltx.cls', languageSkill: 'report-language-latex', compileSkill: 'latex-compile' },
  typst: { entry: 'Report/main.typ', theme: 'Report/mplts.typ', languageSkill: 'report-language-typst', compileSkill: 'typst-compile' },
}

/**
 * Inject the session-specific Report Environment facts the REPORT persona
 * references: active language, entry file, theme, language guidance, and
 * compile skill names.
 * Dynamic facts live here, not in the immutable persona text.
 */
function installReportEnvironmentSection(childCtx: Context, language: ReportSkillLanguage): () => void {
  const environment = REPORT_ENVIRONMENTS[language]
  return childCtx.systemPrompt.section({
    name: 'report-environment',
    order: 115,
    text: [
      'Report Environment',
      `language: ${language}`,
      `entry: ${environment.entry}`,
      `theme: ${environment.theme}`,
      `language skill: ${environment.languageSkill}`,
      `compile skill: ${environment.compileSkill}`,
    ].join('\n'),
  })
}

export const name = 'autoreportdsh-report-router'
export const inject = ['subagents', 'tools', 'systemPrompt', 'skills', 'autoreportWorkflow']

/** Router inputs shared by every specialist branch. */
type RoutedWorkflow = Pick<AutoReportWorkflowRuntime, 'roleRegistry' | 'config' | 'workflowForChild' | 'overlayRoot'>

/**
 * Seed DSH's agent-scoped selection from the frozen workflow snapshot, then
 * release it after the child's first request — success or throw — so a later
 * composer `selectModel` can retarget that child. A continuing pin would win
 * over the Host selection the conversation-window picker writes. Main
 * inheritance installs nothing.
 */
export function installSpecialistModelSelection(childCtx: Context, child: Agent, workflow: RoutedWorkflow): (() => void) | undefined {
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
 * DSH children need nothing here — their messaging is the stock adjacent-agent
 * `send_message` surface the base bundle mounts (the standalone stock report
 * tool was removed upstream in the 2026-08-27 unified-steer change).
 * @param childCtx - unpublished continuable child scope.
 * @param child - the child agent being composed.
 * @param hostCtx - host context carrying shared services.
 * @param workflow - AutoReport role registry, config, and owning-session lookup.
 * @returns child-scoped disposer.
 */
export function installRoutedReportTool(
  childCtx: Context,
  child: Agent,
  hostCtx: Context,
  workflow: RoutedWorkflow,
): () => void {
  const entry = workflow.roleRegistry.lookup(child.id)
  if (entry === undefined) return () => {}
  routedChildren.add(child)

  const disposers: (() => void)[] = []
  try {
    disposers.push(installManifestTool(childCtx, hostCtx, entry.binding.role))
    disposers.push(installWorkflowReportTool(childCtx, hostCtx, entry.binding.role))
    const disposeModelSelection = installSpecialistModelSelection(childCtx, child, workflow)
    if (disposeModelSelection !== undefined) disposers.push(disposeModelSelection)
    const language = workflow.workflowForChild(child.id)?.runtime.state.projection().meta?.settings?.reportLanguage
      ?? workflow.config.defaultReportLanguage
    if (entry.binding.role === 'REPORT') {
      disposers.push(installReportEnvironmentSection(childCtx, language))
    }
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

/** Agents whose report surface this process already routed. */
const routedChildren = new WeakSet<Agent>()

/**
 * Register the child report router. Master dsh removed the continuable-setup
 * composition seam, so routing rides `agent/created`: every published agent
 * whose RoleRegistry binding exists gets the structured protocol installed in
 * its own scope. Resident roles install during their creation setup (marked
 * in {@link routedChildren}); this listener covers manager-owned children.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    if (routedChildren.has(agent)) return undefined
    // The injected fiber rides the agent's own scope and is disposed with it.
    agent.ctx.inject(['tools', 'subagents', 'systemPrompt', 'skills', 'autoreportWorkflow'], childCtx => {
      installRoutedReportTool(childCtx, agent, ctx, childCtx.autoreportWorkflow)
    })
    return undefined
  })
}
