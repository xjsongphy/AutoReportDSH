/**
 * AutoReportDSH host-plane plugin: workflow runtime, role guard, and
 * `/report-init`. Child report routing is a separate overlay row because
 * DSH continuable setups are process-global.
 *
 * @module autoreportdsh-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { isAutoReportMainSession } from './membership.js'
import { createRoleToolGuard } from './policy/tool-guard.js'
import { installAutoReportPythonEnv } from './python-env.js'
import AutoReportWorkflowRuntime, { type RuntimeOptions } from './runtime.js'
import { createReportInitCommand } from './workspace/command.js'
import { loadProjectSettings, saveProjectSettings, workspaceIdForRoot } from './settings.js'
import { installReferencesSkills } from './skills-references.js'
import { installTurnGuards } from './workflow/turn-guard.js'

export const name = 'autoreportdsh-host'
export const inject = ['tools']

const DEFAULT_WAIT_MS = 600_000

const DEFAULT_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: DEFAULT_WAIT_MS,
}

/**
 * Resolve plugin configuration without dropping exact-optional fields as undefined.
 * @param raw - overlay/row config.
 */
export function resolveHostConfig(raw: Partial<Config> = {}): Config {
  return {
    defaultReportLanguage: raw.defaultReportLanguage ?? DEFAULT_CONFIG.defaultReportLanguage,
    workspaceRoot: raw.workspaceRoot ?? DEFAULT_CONFIG.workspaceRoot,
    specialistModel: raw.specialistModel ?? DEFAULT_CONFIG.specialistModel,
    delegationWaitTimeoutMs: raw.delegationWaitTimeoutMs ?? DEFAULT_WAIT_MS,
    ...(raw.pythonExecutable === undefined ? {} : { pythonExecutable: raw.pythonExecutable }),
  }
}

/**
 * Apply the AutoReport host-plane plugin.
 *
 * This single registration owns every host-plane piece (PLAN.md §2): the
 * workflow runtime service (`autoreportWorkflow`, provided via the Service
 * effect), the global monotonic role guard, first-turn settings-snapshot
 * initialization plus `/report-init`, and artifact observation with external
 * manifest projection over every session's committed tool stream.
 * @param ctx - host-plane context the Loader activates this plugin under.
 * @param config - optional overlay configuration.
 * @param options - optional home overrides for tests; production resolves
 *   the DSH home itself.
 */
export function apply(ctx: Context, config: Partial<Config> = {}, options: RuntimeOptions = {}): void {
  const resolved = resolveHostConfig(config)
  installReferencesSkills(ctx)
  const runtime = new AutoReportWorkflowRuntime(ctx, resolved, options)
  ctx.tools.guard(createRoleToolGuard({
    registry: runtime.roleRegistry,
    isMainSession: sessionId => runtime.isMainSession(sessionId),
    ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
  }))
  installTurnGuards(ctx, {
    roleRegistry: runtime.roleRegistry,
    isMainSession: sessionId => runtime.isMainSession(sessionId),
    getProjection: sessionId => runtime.projectionFor(sessionId),
  })
  installAutoReportPythonEnv(ctx, {
    ownsSession: session => runtime.ownsSession(session),
    snapshotPythonExecutable: session =>
      runtime.projectionFor(String(session.id))?.meta?.settings?.pythonExecutable,
  })
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    const definition = createReportInitCommand({
      reportLanguage: resolved.defaultReportLanguage,
      currentDefaultReportLanguage: () => runtime.currentUserSettings().defaultReportLanguage,
      ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
      // External project settings live under the harness home, keyed by the
      // invoked workspace root — never inside the experiment workspace.
      // The runtime's settingsHome override (tests/isolated homes) applies.
      projectStore: root => ({
        load: () => loadProjectSettings(options.settingsHome, workspaceIdForRoot(root)),
        save: next => saveProjectSettings(options.settingsHome, workspaceIdForRoot(root), next),
      }),
    })
    commands.register({
      ...definition,
      async handler(invocation) {
        // Commands are registered by the host-wide command service, so unlike
        // preset-scoped tools their visibility alone cannot establish product
        // membership. Reject before parsing, saving project settings, or
        // materializing files: a stock session must have no AutoReport side
        // effects merely because the overlay is loaded.
        if (!isAutoReportMainSession(invocation.agent.session)) {
          return {
            kind: 'error',
            text: "report-init is available only in an 'autoreport-main' session.",
          }
        }
        const result = await definition.handler(invocation)
        if (result.kind === 'success') runtime.maybeInitialize(invocation.agent.session)
        return result
      },
    })
  }
}

export default AutoReportWorkflowRuntime
