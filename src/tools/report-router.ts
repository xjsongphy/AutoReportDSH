import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { applyRoleSandbox } from '../policy/sandbox-roots.js'
import { installWorkflowReportTool } from './report-workflow.js'
import { installManifestTool } from './manifest.js'
import { registerRoleSkills, reportSkillRequirements, type ReportSkillLanguage } from '../skills-preset.js'
import { installReferencesSkills } from '../skills-references.js'
import { loadReportLanguageGuidance } from '../workspace/skill-loader.js'
import { skillLoadTracker } from '../policy/skill-gate.js'

/** Entry file and theme per report language; skill names come from the requirements table. */
const REPORT_ENVIRONMENTS: Readonly<Record<ReportSkillLanguage, { entry: string; theme: string }>> = {
  latex: { entry: 'Report/main.tex', theme: 'Report/mpltx.cls' },
  typst: { entry: 'Report/main.typ', theme: 'Report/mplts.typ' },
}

/**
 * Inject the session-specific Report Environment facts the REPORT persona
 * references: active language, entry file, theme, and compile skill name.
 * Dynamic facts live here, not in the immutable persona text.
 */
function installReportEnvironmentSection(childCtx: Context, language: ReportSkillLanguage): () => void {
  const environment = REPORT_ENVIRONMENTS[language]
  const required = reportSkillRequirements(language)
  return childCtx.systemPrompt.section({
    name: 'report-environment',
    order: 115,
    text: [
      'Report Environment',
      `language: ${language}`,
      `entry: ${environment.entry}`,
      `theme: ${environment.theme}`,
      `compile skill: ${required.compile}`,
    ].join('\n'),
  })
}

/**
 * Append the active language's layout rules to the REPORT prompt.
 *
 * These rules were once a `report-language-<language>` skill, which meant a
 * REPORT child could only obtain them by loading a skill — and the writing gate
 * had to demand that load. They are unconditional guidance, not a decision the
 * model makes, so they belong in the prompt: every REPORT child now has them
 * before its first step, and no gate depends on them.
 */
function installReportLanguageGuidanceSection(childCtx: Context, language: ReportSkillLanguage): () => void {
  return childCtx.systemPrompt.section({
    name: 'report-language-guidance',
    order: 116,
    text: loadReportLanguageGuidance(language),
  })
}

export const name = 'autoreportdsh-report-router'
export const inject = ['subagents', 'tools', 'systemPrompt', 'skills', 'autoreportWorkflow']

/** Router inputs shared by every specialist branch. */
export type RoutedWorkflow = Pick<
  AutoReportWorkflowRuntime,
  'roleRegistry' | 'config' | 'workflowForChild' | 'reportLanguageForChild'
>

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
    const language = workflow.reportLanguageForChild(child.id)
    if (entry.binding.role === 'REPORT') {
      disposers.push(installReportEnvironmentSection(childCtx, language))
      disposers.push(installReportLanguageGuidanceSection(childCtx, language))
      // Release the gate's per-session state with the scope it belonged to. A
      // surviving session self-heals: the next guard call re-seeds from the log.
      disposers.push(() => { skillLoadTracker.forget(String(child.id)) })
    }
    disposers.push(registerRoleSkills(childCtx, entry.binding.role, language))
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
