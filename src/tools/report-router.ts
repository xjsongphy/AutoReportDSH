import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { installReportTool } from '@deepseek-ai/dsh-tool-subagent-report'
import { snapshotDir } from '../artifacts/artifact-policy.js'
import { AUTOREPORT_SCHEMA_VERSION, type ArtifactSnapshot } from '../workflow/events.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { createPlatformIsolationBackend, type IsolationBackend } from '../policy/isolation/index.js'
import { createReportExecTool, runIsolated } from './report-exec.js'
import { createCompileReportTool } from './compile-report.js'
import { installWorkflowReportTool } from './report-workflow.js'
import { registerRoleSkills } from '../skills-preset.js'

export const name = 'autoreportdsh-report-router'
export const inject = ['subagents', 'tools', 'systemPrompt', 'subprocess', 'autoreportWorkflow']

/** Router inputs shared by every specialist branch. */
type RoutedWorkflow = Pick<AutoReportWorkflowRuntime, 'roleRegistry' | 'config' | 'workflowForChild'>

/**
 * Install DSH's agent-scoped selection seam for a concrete specialist route.
 * The workflow snapshot wins; composition is a compatibility fallback for logs
 * written before snapshots existed. Main inheritance installs nothing, leaving
 * DSH's normal parent-route inheritance untouched.
 */
export function installSpecialistModelSelection(childCtx: Context, workflow: RoutedWorkflow): (() => void) | undefined {
  const child = childCtx.agent as Agent
  const snapshot = workflow.workflowForChild(child.id)?.runtime.state.projection().meta?.settings
  const selected = snapshot?.specialistModel
  const route = selected === undefined
    ? workflow.config.specialistModel
    : selected.inheritMain ? undefined : selected
  if (route === undefined) return undefined
  const selection: ModelSelection = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
  return installModelSelection(childCtx, { current: selection, assembled: undefined })
}

/**
 * Build the REPORT-only `compile_report` registration over the same shared
 * isolated runner `report_exec` uses (PLAN.md §2.12): caller identity through
 * the synchronous registry (REPORT only), platform isolation backend over
 * DSH's subprocess seam, and process artifacts committed onto the owning MAIN
 * session. Registration never touches platform tooling; the isolation
 * backend and its executable resolution are constructed lazily per call.
 */
function installCompileReportTool(
  childCtx: Context,
  hostCtx: Context,
  workflow: RoutedWorkflow & Pick<AutoReportWorkflowRuntime, 'commit'>,
  child: Agent,
): () => void {
  const subprocess = hostCtx.subprocess
  if (subprocess === undefined) {
    throw new Error('autoreportdsh: compile_report requires the subprocess service')
  }
  const resolveCallerRole = (exec: Readonly<ToolExecution>): { sessionId: string; workspaceRoot: string } => {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('compile_report requires an owning agent')
    const entry = workflow.roleRegistry.lookup(session.id)
    if (entry === undefined || entry.binding.role !== 'REPORT') {
      throw new Error('AutoReport compile_report is available only to REPORT')
    }
    const root = workflow.config.workspaceRoot ?? session.header.cwd
    if (root === undefined || root.length === 0) {
      throw new Error('compile_report requires a workspace root or session cwd')
    }
    return { sessionId: String(session.id), workspaceRoot: root }
  }
  let isolation: IsolationBackend | undefined
  return childCtx.tools.register(createCompileReportTool({
    config: workflow.config,
    resolveCallerRole,
    runner: request => {
      // Per-call construction keeps registration side-effect free while each
      // compilation still resolves through the deployment's executable lookup.
      isolation ??= createPlatformIsolationBackend(
        (command, signal) => subprocess.resolveExecutable(command, {}, signal),
      )
      return runIsolated(
        {
          subprocess,
          isolation,
          maxOutputBytes: 65_536,
          createTemp: async () => {
            const { mkdtemp } = await import('node:fs/promises')
            const { tmpdir } = await import('node:os')
            return mkdtemp(`${tmpdir()}/autoreportdsh-`)
          },
          removeTemp: async path => {
            const { rm } = await import('node:fs/promises')
            await rm(path, { recursive: true, force: true })
          },
        },
        request,
        { externalSignal: request.externalSignal, timeoutMs: request.timeoutMs },
      )
    },
    listFilesFiltered: root => snapshotDir(root),
    commitArtifact: snapshot => {
      const owner = workflow.workflowForChild(child.id)
      if (owner === undefined) return
      const artifact: ArtifactSnapshot = {
        version: AUTOREPORT_SCHEMA_VERSION,
        path: snapshot.path,
        status: snapshot.status,
        producedBy: 'REPORT',
        origin: 'process',
        recordedAt: snapshot.recordedAt,
      }
      workflow.commit(owner.session, 'autoreport/artifact', artifact)
    },
  }))
}

/**
 * Route one continuable child's report surface by pre-provisioned role.
 * AutoReport children get the structured protocol plus `report_exec` (and
 * `compile_report` for REPORT only); ordinary DSH children keep the
 * maintained stock implementation.
 * @param childCtx - unpublished continuable child scope.
 * @param hostCtx - host context carrying shared services.
 * @param workflow - AutoReport role registry, config, and owning-session lookup.
 * @returns child-scoped disposer.
 */
export function installRoutedReportTool(
  childCtx: Context,
  hostCtx: Context,
  workflow: RoutedWorkflow & Pick<AutoReportWorkflowRuntime, 'commit'>,
): () => void {
  const child = childCtx.agent as Agent
  const entry = workflow.roleRegistry.lookup(child.id)
  if (entry === undefined) return installReportTool(childCtx, hostCtx, 'next-step')

  const disposeReport = installWorkflowReportTool(childCtx, hostCtx, entry.binding.role)
  const disposers: (() => void)[] = []
  try {
    const disposeModelSelection = installSpecialistModelSelection(childCtx, workflow)
    if (disposeModelSelection !== undefined) disposers.push(disposeModelSelection)
    const language = workflow.workflowForChild(child.id)?.runtime.state.projection().meta?.settings?.reportLanguage
      ?? workflow.config.defaultReportLanguage
    disposers.push(registerRoleSkills(childCtx, entry.binding.role, language))
    disposers.push(childCtx.tools.register(createReportExecTool(hostCtx, {
      registry: workflow.roleRegistry,
      ...(workflow.config.workspaceRoot === undefined ? {} : { workspaceRoot: workflow.config.workspaceRoot }),
    })))
    if (entry.binding.role === 'REPORT') {
      disposers.push(installCompileReportTool(childCtx, hostCtx, workflow, child))
    }
  } catch (error: unknown) {
    for (const dispose of [...disposers.reverse(), disposeReport]) {
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
    for (const dispose of [...disposers.reverse(), disposeReport]) {
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
