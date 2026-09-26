/**
 * AutoReportDSH host-plane plugin: workflow runtime, role guard, and
 * `/init`. Child report routing is a separate overlay row because
 * DSH continuable setups are process-global.
 *
 * @module autoreport-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolve } from 'node:path'
import type { Config } from './config.js'
import { isAutoReportMainSession } from './membership.js'
import { rolePolicy, type AutoReportRole } from './roles.js'
import { installSandboxOverride } from './policy/sandbox-override.js'
import { roleWritableRoot } from './policy/sandbox-roots.js'
import { createRoleToolGuard } from './policy/tool-guard.js'
import { createSkillGateGuard, skillLoadTracker } from './policy/skill-gate.js'
import { installAutoReportPythonEnv } from './python-env.js'
import { installAutoReportPythonContext } from './python-context.js'
import AutoReportWorkflowRuntime, { type RuntimeOptions } from './runtime.js'
import { createReportInitCommand, parseReportInitInput, resolveWorkspaceRoot } from './workspace/command.js'
import { createReportResetCommand, parseReportResetInput } from './workspace/reset.js'
import { describeDshVersionSupport, readRunningDshVersion } from './dsh-version.js'
import { installTurnGuards } from './workflow/turn-guard.js'
import { createListDirectoryTool } from './tools/list-directory.js'

export const name = 'autoreport-host'
// `apply()` registers the host-wide `/init` command through the commands
// service.  Keep both services in the activation contract so the lookup below
// cannot race startup and silently skip command registration.
export const inject = ['tools', 'commands', 'shellEnv']

const DEFAULT_WAIT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const FILE_PATH_TOOLS = ['read', 'read_image', 'write', 'edit'] as const

function initializeWorkflowIfOwnWorkspace(
  runtime: AutoReportWorkflowRuntime,
  session: Parameters<AutoReportWorkflowRuntime['workflowRootFor']>[0],
  commandRoot: string | undefined,
): void {
  const workflowRoot = runtime.workflowRootFor(session)
  if (workflowRoot === undefined || commandRoot === undefined) return
  if (resolve(workflowRoot) !== resolve(commandRoot)) return
  runtime.maybeInitialize(session)
}

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
  // Version transparency, never a gate: the pin in docs/dependencies.md means
  // "verified", not "exclusive". An unverified pair usually works — say so
  // once, so a mid-session breakage can be attributed in one glance.
  //
  // No session-vocabulary registration happens here, and none is needed: the
  // plugin keeps its own records in its own log (`src/workflow/store.ts`), so a
  // session log it produced stays inside DSH's own event vocabulary and every
  // harness build reads it unmodified.
  const support = describeDshVersionSupport(options.runningDshVersion ?? readRunningDshVersion())
  if (support.verified) ctx.logger.info(support.message)
  else ctx.logger.warn(support.message)
  // Role isolation resolves each AutoReport session's writable root through
  // the host sandbox policy at enforcement time. Bare unit-test contexts may
  // omit the service; a real deployment must accept the override — install
  // self-checks and fails loud rather than silently widening every role to
  // the experiment workspace.
  const sandboxPolicy = ctx.get('sandboxPolicy') as Parameters<typeof installSandboxOverride>[0] | undefined
  const resolved = resolveHostConfig(config)
  const runtime = new AutoReportWorkflowRuntime(ctx, resolved, options)
  // DSH tools are inherited through agent scopes. Register same-name variants
  // in each AutoReport agent's own scope so the model sees role-specific shell
  // and path guidance while execution still uses the stock implementations.
  ctx.on('agent/created', async ({ agent }) => {
    const session = agent.session
    const role: AutoReportRole | undefined = runtime.roleFor(String(agent.id))
      ?? (isAutoReportMainSession(session) ? 'MAIN' : undefined)
    if (role === undefined) return undefined
    const workspaceRoot = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0
      ? resolve(session.header.cwd)
      : undefined
    const mutationRoot = resolved.workspaceRoot ?? workspaceRoot
    // Under AutoReport's sandbox override, write/edit resolve relative paths
    // from the role's writable directory; reads still use the session cwd.
    const writeEditRoot = sandboxPolicy !== undefined && mutationRoot !== undefined
      ? roleWritableRoot(mutationRoot, role)
      : workspaceRoot
    if (workspaceRoot !== undefined && (role === 'MAIN' || role === 'THEORY')) {
      agent.ctx.tools.register(createListDirectoryTool(workspaceRoot, agent))
    }
    const bash = role === 'THEORY' ? undefined : agent.ctx.tools.get('bash', agent)
    if (bash !== undefined) {
      const writable = rolePolicy(role).writableRoots.join(', ')
      const guidance = role === 'MAIN'
        ? ' AutoReport MAIN: use list_directory for workspace inventory. Bash writes are allowed only under Outline/. '
          + 'Do not use bash for theory, analysis, plotting, report writing, or compilation.'
        : ` AutoReport ${role}: use bash only for commands needed by your assigned specialist task. Writes are confined to ${writable}.`
      agent.ctx.tools.register({ ...bash, description: `${bash.description}${guidance}` })
    }
    // The stock filesystem schemas leave the path base implicit. Make the
    // session-workspace rule explicit for AutoReport without changing the
    // inherited tool implementations or their argument schemas.
    for (const name of FILE_PATH_TOOLS) {
      const tool = agent.ctx.tools.get(name, agent)
      if (tool === undefined) continue
      const isMutation = name === 'write' || name === 'edit'
      const relativeRoot = isMutation ? writeEditRoot : workspaceRoot
      const relativePathGuidance = relativeRoot === undefined
        ? 'The absolute path base for relative paths is unavailable in this session; use an absolute path when the base is uncertain.'
        : `Relative paths resolve from ${relativeRoot}.`
      const filePathGuidance = isMutation
        ? `AutoReport file paths: for this role's writable directory, prefer paths relative to its root, such as \`main.typ\`. ${relativePathGuidance} Absolute paths are accepted when they remain inside this role's writable directory.`
        : `AutoReport file paths: for workspace files, prefer workspace-relative paths such as \`Report/main.typ\`. ${relativePathGuidance} Absolute paths are also accepted.`
      agent.ctx.tools.register({
        ...tool,
        description: `${tool.description} ${filePathGuidance}`,
      })
    }
    const strReplaceEditor = agent.ctx.tools.get('str_replace_editor', agent)
    if (strReplaceEditor !== undefined && workspaceRoot !== undefined) {
      agent.ctx.tools.register({
        ...strReplaceEditor,
        description: `${strReplaceEditor.description} AutoReport path context: the absolute workspace root for this agent is ${workspaceRoot}. This tool requires absolute paths; use that directory as the base for workspace files.`,
      })
    }
    // Rehydrate resident activations only after Main's scoped tools are ready,
    // so resumed specialists inherit the same composed workspace as before.
    if (role === 'MAIN') await runtime.restoreResidentRoles(agent)
    return undefined
  })
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
  ctx.tools.guard(createRoleToolGuard({
    registry: runtime.roleRegistry,
    isMainSession: sessionId => runtime.isMainSession(sessionId),
    ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
  }))
  // Report-skill gate: a REPORT child may not edit report files or run its
  // compiler before it has loaded the skill governing that action. The refusal
  // names the skill and the model loads it with DSH's own `skill` tool, so the
  // transcript records a real agent tool call and the harness fabricates
  // nothing. Loads are read from the durable stream for the same reason.
  ctx.on('session/event', (session, event) => {
    skillLoadTracker.observe(session, event)
  })
  ctx.tools.guard(createSkillGateGuard({
    roleOf: sessionId => runtime.roleFor(sessionId),
    languageOf: sessionId => runtime.reportLanguageForChild(sessionId as SessionId),
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
  // Dynamic Python-environment context on every owned session. The DSH loop
  // snapshots it per step and appends a user-role message only when the
  // rendered text changes, so an environment switch mid-conversation reaches
  // the model without rewriting the cached history prefix.
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.effect(
      () => installAutoReportPythonContext(promptCtx, {
        ownsSession: session => runtime.ownsSession(session),
        snapshotPythonExecutable: session =>
          runtime.projectionFor(String(session.id))?.meta?.settings?.pythonExecutable,
      }),
      'autoreport.pythonContext()',
    )
  })
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    const definition = createReportInitCommand({
      reportLanguage: resolved.defaultReportLanguage,
      currentDefaultReportLanguage: () => runtime.currentUserSettings().defaultReportLanguage,
      ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
      // The authoritative per-workspace language lives in the runtime's
      // settings section; recording it there is also what makes the host switch
      // the workspace's templates. The seam reads the runtime lazily: the
      // settings provider arrives through an inject callback, so it is not
      // mounted yet when this command is registered.
      languageStore: {
        read: root => runtime.languageStore?.read(root),
        write: (root, language) => { runtime.languageStore?.write(root, language) },
      },
    })
    commands.register({
      ...definition,
      async handler(invocation) {
        // Commands are registered by the host-wide command service, so unlike
        // preset-scoped tools their visibility alone cannot establish product
        // membership. Reject before parsing or materializing files: a stock
        // session must have no AutoReport side effects merely because the
        // overlay is loaded.
        if (!isAutoReportMainSession(invocation.agent.session)) {
          return {
            kind: 'error',
            text: "init is available only in an 'autoreport' session.",
          }
        }
        const result = await definition.handler(invocation)
        if (result.kind === 'success') {
          const parsed = parseReportInitInput(invocation.rawInput)
          if (!('error' in parsed)) {
            const commandRoot = resolveWorkspaceRoot(
              parsed.directory,
              invocation,
              resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot },
            )
            initializeWorkflowIfOwnWorkspace(runtime, invocation.agent.session, commandRoot)
          }
        }
        return result
      },
    })
    const resetDefinition = createReportResetCommand({
      reportLanguage: resolved.defaultReportLanguage,
      currentDefaultReportLanguage: () => runtime.currentUserSettings().defaultReportLanguage,
      ...(resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot }),
      // Read-only here: a reset never chooses a language, it re-materializes
      // the templates of the workspace's recorded one.
      languageStore: {
        read: root => runtime.languageStore?.read(root),
        write: () => {},
      },
      // Clearing the board belongs to the session that typed the command, and
      // only when the directory it named is that session's own workspace.
      workflow: {
        root: session => runtime.workflowRootFor(session),
        reset: async session => { await runtime.resetWorkflow(session) },
      },
    })
    commands.register({
      ...resetDefinition,
      async handler(invocation) {
        if (!isAutoReportMainSession(invocation.agent.session)) {
          return {
            kind: 'error',
            text: "reset is available only in an 'autoreport' session.",
          }
        }
        const result = await resetDefinition.handler(invocation)
        // The reset dropped this session's workflow with its files; admit the
        // fresh one now so the board, the workspace root, and the settings
        // snapshot are consistent before the next turn reads them.
        if (result.kind === 'success') {
          const parsed = parseReportResetInput(invocation.rawInput)
          if (!('error' in parsed)) {
            const commandRoot = resolveWorkspaceRoot(
              parsed.directory,
              invocation,
              resolved.workspaceRoot === undefined ? {} : { workspaceRoot: resolved.workspaceRoot },
            )
            initializeWorkflowIfOwnWorkspace(runtime, invocation.agent.session, commandRoot)
          }
        }
        return result
      },
    })
  }

  // The host may be loaded after persisted Main agents have already been
  // materialized. Run the same durable-binding restore path used by the
  // created listener so those sessions do not wait for another user turn.
  const existingAgents = ctx.get('agents') as { list?: () => Agent[] } | undefined
  await Promise.all((existingAgents?.list?.() ?? [])
    .filter(agent => isAutoReportMainSession(agent.session))
    .map(agent => runtime.restoreResidentRoles(agent)))
}

export default AutoReportWorkflowRuntime
