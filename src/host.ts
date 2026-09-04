/**
 * AutoReportDSH host-plane plugin: workflow runtime, role guard, and
 * `/init`. Child report routing is a separate overlay row because
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
import { installTurnGuards } from './workflow/turn-guard.js'
import { syncManagedResources } from './workspace/resource-sync.js'

export const name = 'autoreportdsh-host'
// `apply()` registers the host-wide `/init` command through the commands
// service.  Keep both services in the activation contract so the lookup below
// cannot race startup and silently skip command registration.
export const inject = ['tools', 'commands', 'shellEnv']

const DEFAULT_WAIT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

const DEFAULT_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: DEFAULT_WAIT_MS,
  delegationIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
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
    delegationIdleTimeoutMs: raw.delegationIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(raw.pythonExecutable === undefined ? {} : { pythonExecutable: raw.pythonExecutable }),
  }
}

/**
 * Apply the AutoReport host-plane plugin.
 *
 * This single registration owns every host-plane piece (PLAN.md §2): the
 * workflow runtime service (`autoreportWorkflow`, provided via the Service
 * effect), the global monotonic role guard, first-turn settings-snapshot
   * initialization plus `/init`, and artifact observation over every
 * session's committed tool stream.
 * @param ctx - host-plane context the Loader activates this plugin under.
 * @param config - optional overlay configuration.
 * @param options - optional home overrides for tests; production resolves
 *   the DSH home itself.
 */
export async function apply(ctx: Context, config: Partial<Config> = {}, options: RuntimeOptions = {}): Promise<void> {
  const resolved = resolveHostConfig(config)
  const runtime = new AutoReportWorkflowRuntime(ctx, resolved, options)
  if (options.skipResourceSync !== true) {
    try {
      const outcomes = await syncManagedResources({ overlayRoot: runtime.overlayRoot })
      const failed = outcomes.filter(entry => entry.status === 'failed').length
      if (failed > 0) {
        try {
          ctx.logger.warn('autoreportdsh: resource sync kept overlay copies for %d failed file(s)', failed)
        } catch {
          // A bare test Context may lack a working logger.
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger.warn('autoreportdsh: resource sync skipped: %s', message)
      } catch {
        // A bare test Context may lack a working logger.
      }
    }
  }
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
      overlayRoot: runtime.overlayRoot,
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
            text: "init is available only in an 'autoreport' session.",
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
