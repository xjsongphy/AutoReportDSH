/**
 * AutoReportDSH host-plane plugin: workflow runtime, role guard, and
 * `/report-init`. Child report routing is a separate overlay row because
 * DSH continuable setups are process-global.
 *
 * @module autoreportdsh-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { createRoleToolGuard } from './policy/tool-guard.js'
import AutoReportWorkflowRuntime from './runtime.js'
import { createReportInitCommand } from './workspace/command.js'
import { loadProjectSettings, saveProjectSettings, workspaceIdForRoot } from './settings.js'

export const name = 'autoreportdsh-host'
export const inject = ['tools']

const DEFAULT_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  defaultLatexEngine: 'latexmk',
  defaultPythonEnv: undefined,
  workspaceRoot: undefined,
  specialistModel: undefined,
  executionTimeoutMs: 600_000,
}

/**
 * Resolve plugin configuration without dropping exact-optional fields as undefined.
 * @param raw - overlay/row config.
 */
export function resolveHostConfig(raw: Partial<Config> = {}): Config {
  return {
    defaultReportLanguage: raw.defaultReportLanguage ?? DEFAULT_CONFIG.defaultReportLanguage,
    defaultLatexEngine: raw.defaultLatexEngine ?? DEFAULT_CONFIG.defaultLatexEngine,
    defaultPythonEnv: raw.defaultPythonEnv ?? DEFAULT_CONFIG.defaultPythonEnv,
    workspaceRoot: raw.workspaceRoot ?? DEFAULT_CONFIG.workspaceRoot,
    specialistModel: raw.specialistModel ?? DEFAULT_CONFIG.specialistModel,
    executionTimeoutMs: raw.executionTimeoutMs ?? DEFAULT_CONFIG.executionTimeoutMs,
  }
}

/**
 * Apply the AutoReport host-plane plugin.
 * @param ctx - host-plane context the Loader activates this plugin under.
 * @param config - optional overlay configuration.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const resolved = resolveHostConfig(config)
  const runtime = new AutoReportWorkflowRuntime(ctx, resolved)
  ctx.tools.guard(createRoleToolGuard({
    registry: runtime.roleRegistry,
    isMainSession: sessionId => runtime.isMainSession(sessionId),
    ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
  }))
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    const definition = createReportInitCommand({
      reportLanguage: resolved.defaultReportLanguage,
      ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
      // External project settings live under the harness home, keyed by the
      // invoked workspace root — never inside the experiment workspace.
      projectStore: root => ({
        load: () => loadProjectSettings(undefined, workspaceIdForRoot(root)),
        save: next => saveProjectSettings(undefined, workspaceIdForRoot(root), next),
      }),
    })
    commands.register({
      ...definition,
      async handler(invocation) {
        const result = await definition.handler(invocation)
        if (result.kind === 'success') runtime.maybeInitialize(invocation.agent.session)
        return result
      },
    })
  }
}

export default AutoReportWorkflowRuntime
