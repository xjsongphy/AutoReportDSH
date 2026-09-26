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
import { isAbsolute, resolve } from 'node:path'
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
import { createListDirectoryTool, type DirectoryFileSystem } from './tools/list-directory.js'
import { MAIN_SKILL_NAMES, skillNamesForRole } from './skills-preset.js'
import { loadBundledSkills } from './workspace/skill-loader.js'

export const name = 'autoreport-host'
// `apply()` registers the host-wide `/init` command through the commands
// service.  Keep both services in the activation contract so the lookup below
// cannot race startup and silently skip command registration.
export const inject = ['tools', 'commands', 'shellEnv']

const DEFAULT_WAIT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const FILE_PATH_TOOLS = ['read', 'read_image', 'write', 'edit'] as const

function hasUriScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) && !/^[A-Za-z]:[\\/]/u.test(path)
}

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
  if (resolved.workspaceRoot !== undefined) {
    if (hasUriScheme(resolved.workspaceRoot)) {
      throw new Error('AutoReport workspaceRoot must be a local filesystem path; URI workspaces are not supported by its role policy')
    }
    resolved.workspaceRoot = resolve(resolved.workspaceRoot)
  }
  const runtime = new AutoReportWorkflowRuntime(ctx, resolved, options)
  const bundledSkillRoots = new Map(
    loadBundledSkills().flatMap(skill => skill.directory === undefined ? [] : [[skill.name, skill.directory] as const]),
  )
  // DSH tools are inherited through agent scopes. Register same-name variants
  // in each AutoReport agent's own scope so the model sees role-specific shell
  // and path guidance while execution still uses the stock implementations.
  ctx.on('agent/created', async ({ agent }) => {
    const session = agent.session
    const role: AutoReportRole | undefined = runtime.roleFor(String(agent.id))
      ?? (isAutoReportMainSession(session) ? 'MAIN' : undefined)
    if (role === undefined) return undefined
    const sessionRoot = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0
      ? resolve(session.header.cwd)
      : undefined
    const workspaceRoot = resolved.workspaceRoot ?? sessionRoot
    if (sandboxPolicy === undefined && resolved.workspaceRoot !== undefined
      && (sessionRoot === undefined || resolve(resolved.workspaceRoot) !== sessionRoot)) {
      throw new Error(
        `AutoReport ${role} requires DSH sandboxPolicy when configured workspaceRoot ${resolve(resolved.workspaceRoot)} differs from session cwd ${sessionRoot ?? '(missing)'}; without the service DSH resolves relative file and bash paths from session cwd`,
      )
    }
    const mutationRoot = workspaceRoot
    // DSH's sandbox policy root wins for writes and bash when available. Without
    // it, DSH file tools and bash use the immutable session cwd.
    const relativeMutationRoot = sandboxPolicy !== undefined && mutationRoot !== undefined
      ? roleWritableRoot(mutationRoot, role)
      : sessionRoot ?? workspaceRoot
    if (workspaceRoot !== undefined && (role === 'MAIN' || role === 'THEORY')) {
      const fileSystem = ctx.get('fs') as DirectoryFileSystem | undefined
      agent.ctx.tools.register(createListDirectoryTool(workspaceRoot, agent, fileSystem))
    }
    const bash = role === 'THEORY' ? undefined : agent.ctx.tools.get('bash', agent)
    if (bash !== undefined) {
      const writable = rolePolicy(role).writableRoots.map(root => `${root}/`).join(', ')
      const readable = rolePolicy(role).readableRoots.map(root => `${root}/`).join(', ')
      const bashCwd = relativeMutationRoot
      const canonicalOutputNote = 'Paths such as Report/main.typ in personas, manifests, and report_workflow are workspace-canonical. Bash paths and relative workdir use its current directory; do not repeat a role-directory prefix when bash is already in that directory.'
      const guidance = role === 'MAIN'
        ? ` AutoReport MAIN: use list for workspace inventory. File reads are allowed under ${readable}; bash starts in ${bashCwd ?? 'the session workspace'}${sandboxPolicy === undefined ? '' : ' (Outline/)'} and relative workdir/command paths use that directory as their base. Bash writes are allowed only under Outline/. ${canonicalOutputNote} `
          + 'Do not use bash for theory, analysis, plotting, report writing, or compilation. Process reads are not path-restricted by the current DSH sandbox, so use file tools for role-scoped reads.'
        : ` AutoReport ${role}: use bash only for commands needed by your assigned specialist task. Bash starts in ${bashCwd ?? 'the session workspace'}${sandboxPolicy === undefined ? '' : ` (${rolePolicy(role).writableRoots[0]}/)`}; relative workdir and command paths resolve from there. File reads are allowed under ${readable}; writes are confined to ${writable}. ${canonicalOutputNote} Process reads are not path-restricted by the current DSH sandbox, so use file tools for role-scoped reads.`
      agent.ctx.tools.register({ ...bash, description: `${bash.description}${guidance}` })
    }
    // The stock filesystem schemas leave the path base implicit. Make the
    // session-workspace rule explicit for AutoReport without changing the
    // inherited tool implementations or their argument schemas.
    for (const name of FILE_PATH_TOOLS) {
      const tool = agent.ctx.tools.get(name, agent)
      if (tool === undefined) continue
      const isMutation = name === 'write' || name === 'edit'
      const relativeRoot = isMutation ? relativeMutationRoot : workspaceRoot
      const relativePathGuidance = relativeRoot === undefined
        ? 'The absolute path base for relative paths is unavailable in this session; use an absolute path when the base is uncertain.'
        : `Relative paths resolve from ${relativeRoot}.`
      const filePathGuidance = isMutation
        ? `AutoReport file paths: workspace-canonical output identifiers (for manifests and handoffs) include the role directory, e.g. \`Report/main.typ\`. This tool's relative paths resolve from ${relativeRoot ?? 'the DSH session workspace'}; if that is the role root, write \`main.typ\` without repeating \`Report/\`. ${relativePathGuidance} Absolute workspace paths are accepted when they remain inside this role's writable directory.`
        : `AutoReport file paths: reads use workspace-root-relative paths such as \`Theory/formulas.md\`, allowed under ${rolePolicy(role).readableRoots.join(', ')}. ${relativePathGuidance} The \`list\` path, manifest paths, and report_workflow produced_files are also workspace-relative. Skill resources use the absolute resourceBase shown when the skill is loaded.`
      if ((name === 'read' || name === 'read_image') && workspaceRoot !== undefined) {
        const execute = tool.execute
        agent.ctx.tools.register({
          ...tool,
          description: `${tool.description} ${filePathGuidance}`,
          async execute(args, execution) {
            const fields = typeof args === 'object' && args !== null && !Array.isArray(args)
              ? args as Record<string, unknown>
              : undefined
            const path = fields === undefined ? undefined : fields['file_path']
            if (typeof path !== 'string' || isAbsolute(path)) return execute(args, execution)
            return execute({ ...fields, file_path: resolve(workspaceRoot, path) }, execution)
          },
        })
      } else {
        agent.ctx.tools.register({
          ...tool,
          description: `${tool.description} ${filePathGuidance}`,
        })
      }
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
    relativeWriteRootOf: (session, role, workspaceRoot) => sandboxPolicy === undefined
      ? (typeof session.header?.cwd === 'string' ? resolve(session.header.cwd) : workspaceRoot)
      : roleWritableRoot(workspaceRoot, role),
    readableResourceRootsOf: (sessionId, role) => {
      if (role !== 'MAIN' && role !== 'REPORT') return []
      const language = role === 'REPORT'
        ? runtime.reportLanguageForChild(sessionId as SessionId)
        : undefined
      const skillNames = role === 'MAIN'
        ? MAIN_SKILL_NAMES
        : skillNamesForRole('REPORT', language ?? 'latex')
      return skillNames.flatMap(skillName => {
        const root = bundledSkillRoots.get(skillName)
        return root === undefined ? [] : [root]
      })
    },
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
