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
import { installSandboxOverride } from './policy/sandbox-override.js'
import { roleWritableRoot } from './policy/sandbox-roots.js'
import { createRoleToolGuard } from './policy/tool-guard.js'
import { installAutoReportPythonEnv } from './python-env.js'
import AutoReportWorkflowRuntime, { type RuntimeOptions } from './runtime.js'
import { createReportInitCommand } from './workspace/command.js'
import { loadProjectSettings, saveProjectSettings, workspaceIdForRoot } from './settings.js'
import { registerAutoReportSessionEvents } from './session-events.js'
import { describeDshVersionSupport, readRunningDshVersion } from './dsh-version.js'
import { installTurnGuards } from './workflow/turn-guard.js'

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
  // This must run before any AutoReport session is created or resumed: DSH
  // validates the persisted event vocabulary at the session boundary, outside
  // the agent loop. Registration makes the `autoreport/*` records loadable in
  // this process; failing when neither loadability mechanism exists keeps the
  // plugin from silently writing logs that no reader can open.
  const compatibility = await registerAutoReportSessionEvents({
    ...(options.sessionEventProbe === undefined ? {} : { markerProbe: options.sessionEventProbe }),
  })
  // Version transparency, never a gate: the pin in docs/dependencies.md means
  // "verified", not "exclusive". An unverified pair usually works — say so
  // once, so a mid-session breakage can be attributed in one glance.
  const support = describeDshVersionSupport(options.runningDshVersion ?? readRunningDshVersion())
  if (support.verified) ctx.logger.info(support.message)
  else ctx.logger.warn(support.message)
  if (!compatibility.markerPersisted) {
    ctx.logger.warn(
      'autoreportdsh: this DSH cannot persist the ignorable session-event marker; '
      + `${'autoreport/*'} records are loadable only in processes that load this plugin, `
      + 'not by a plain dsh or a future build. Upgrade DSH to make the logs portable.',
    )
  }
  // Role isolation resolves each AutoReport session's writable root through
  // the host sandbox policy at enforcement time. Bare unit-test contexts may
  // omit the service; a real deployment must accept the override — install
  // self-checks and fails loud rather than silently widening every role to
  // the experiment workspace.
  const sandboxPolicy = ctx.get('sandboxPolicy') as Parameters<typeof installSandboxOverride>[0] | undefined
  const resolved = resolveHostConfig(config)
  const runtime = new AutoReportWorkflowRuntime(ctx, resolved, options)
  if (sandboxPolicy !== undefined) {
    installSandboxOverride(sandboxPolicy, {
      roleRootOf: session => {
        const role = runtime.roleFor(String(session.id))
        if (role === undefined) return undefined
        const root = resolved.workspaceRoot ?? (typeof session.header?.cwd === 'string' ? session.header.cwd : undefined)
        if (root === undefined || root.length === 0) return undefined
        return roleWritableRoot(root, role)
      },
      probeRoot: roleWritableRoot(resolved.workspaceRoot ?? process.cwd(), 'MAIN'),
    })
  }
  // Resource refresh is deliberately explicit (`pnpm run sync:resources`),
  // never a startup side effect. Bundled resources keep a fresh/offline
  // install deterministic and prevent a mutable remote prompt from being
  // loaded merely by opening DSH.
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
