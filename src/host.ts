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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Config } from './config.js'
import { isAutoReportMainSession } from './membership.js'
import { DSH_ROLE_ESCAPE_TOOL_NAMES, ROLE_PROCESS_TOOL, rolePolicy, type AutoReportRole } from './roles.js'
import { installFilesystemScopeContext } from './filesystem-scope.js'
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
import { createGrepTool, type SearchFileSystem } from './tools/grep.js'
import { skillNamesForRole } from './skills-preset.js'
import { loadBundledSkills } from './workspace/skill-loader.js'
import { restrictInheritedShell } from './policy/role-tool-visibility.js'

export const name = 'autoreport-host'
// `apply()` registers the host-wide `/init` command through the commands
// service.  Keep both services in the activation contract so the lookup below
// cannot race startup and silently skip command registration.
export const inject = ['tools', 'commands', 'shellEnv']

const DEFAULT_WAIT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
/** Tools whose relative paths the adapter rewrites to absolute workspace paths. */
const FILE_PATH_TOOLS = ['read', 'read_image', 'write', 'edit'] as const

function hasUriScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) && !/^[A-Za-z]:[\\/]/u.test(path)
}

/**
 * Bind the platform shell to AutoReport's simple process policy: the session
 * starts at the experiment workspace root (navigation only) and the DSH
 * sandbox — pinned to the role's writable root — owns every write effect.
 * No command inspection happens here.
 */
function wrapRoleAwareShell(
  shell: ToolDefinition,
  role: AutoReportRole,
  workspaceRoot: string,
): ToolDefinition {
  const baseParameters = (shell as unknown as { parameters?: Readonly<Record<string, unknown>> }).parameters ?? {}
  const parameters: Record<string, unknown> = { ...baseParameters }
  delete parameters['run_in_background']
  delete parameters['sandbox_permissions']
  delete parameters['justification']
  const execute = shell.execute.bind(shell)
  return {
    ...shell,
    parameters: parameters as ToolDefinition['parameters'],
    description: `AutoReport ${role} shell execution runs with the DSH sandbox rooted at the role's writable root; writes outside it are rejected by the operating system. Every path is workspace-relative and the session starts at the workspace root. Background execution and generic sandbox escalation are unavailable.`,
    async execute(args, execution) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('role shell requires an argument object')
      }
      const fields = args as Record<string, unknown>
      if (typeof fields['command'] !== 'string' || fields['command'].length === 0) {
        throw new Error('role shell requires a non-empty command')
      }
      if (fields['run_in_background'] === true || fields['sandbox_permissions'] !== undefined) {
        throw new Error('role shell does not support background execution or generic sandbox escalation')
      }
      const requestedWorkdir = fields['workdir']
      if (requestedWorkdir !== undefined && typeof requestedWorkdir !== 'string') {
        throw new Error('role shell workdir must be a string')
      }
      const cwd = requestedWorkdir === undefined
        ? workspaceRoot
        : isAbsolute(requestedWorkdir)
          ? resolve(requestedWorkdir)
          : resolve(workspaceRoot, requestedWorkdir)
      return execute({ ...fields, command: fields['command'], workdir: cwd }, execution)
    },
  }
}

function restrictRoleToolSurface(agent: Agent, role: AutoReportRole, processToolAvailable: boolean): () => void {
  const policy = rolePolicy(role)
  // Agent-local registrations (list/grep everywhere; specialist manifest/
  // report_workflow are mounted in the child scope): restrict() names globals
  // only, so these stay out of the allow list.
  const agentLocalTools = role === 'MAIN'
    ? new Set(['list', 'grep'])
    : new Set(['list', 'grep', 'manifest', 'report_workflow', 'compile_report', 'render_report_page'])
  const allowed = policy.tools.filter(name => {
    if (agentLocalTools.has(name)) return false
    if (name === ROLE_PROCESS_TOOL && !processToolAvailable) return false
    return agent.ctx.tools.get(name, agent) !== undefined
  })
  const deny = DSH_ROLE_ESCAPE_TOOL_NAMES.filter(name =>
    !policy.tools.includes(name) && agent.ctx.tools.get(name, agent) !== undefined)
  return agent.ctx.tools.restrict({ allow: allowed, ...(deny.length === 0 ? {} : { deny }) })
}

/** Fail before a model request if prompt policy and executable capabilities diverge. */
function assertRoleToolSurface(agent: Agent, role: AutoReportRole, processToolAvailable: boolean): void {
  const policy = rolePolicy(role)
  if (typeof agent.ctx.tools.schemas !== 'function') return
  const expected = policy.tools.filter(name => name !== ROLE_PROCESS_TOOL || processToolAvailable)
  const schemas = agent.ctx.tools.schemas(agent)
  const actual = schemas.map(schema => schema.name).sort()
  const expectedSorted = [...expected].sort()
  const missing = expectedSorted.filter(name => !actual.includes(name))
  const unexpected = actual.filter(name => !expectedSorted.includes(name))
  const uncallable = actual.filter(name => {
    const definition = agent.ctx.tools.get(name, agent)
    return definition === undefined || definition.name !== name || typeof definition.execute !== 'function'
  })
  const descriptionMismatches = schemas.filter(schema =>
    agent.ctx.tools.get(schema.name, agent)?.description !== schema.description,
  ).map(schema => schema.name)
  if (missing.length > 0 || unexpected.length > 0 || uncallable.length > 0 || descriptionMismatches.length > 0) {
    throw new Error(
      `AutoReport ${role} tool surface mismatch: missing=[${missing.join(', ')}], `
      + `unexpected=[${unexpected.join(', ')}], uncallable=[${uncallable.join(', ')}], `
      + `descriptionMismatch=[${descriptionMismatches.join(', ')}]`,
    )
  }
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
  const liveAgents = new Map<string, Agent>()
  const mainShellFilters = new Map<Agent, () => void>()
  const configuredRoles = new Map<Agent, { role: AutoReportRole; workspaceRoot: string; dispose: () => void }>()
  const refreshMainShell = (agent: Agent) => {
    const active = mainShellFilters.get(agent)
    if (!isAutoReportMainSession(agent.session)) {
      active?.()
      mainShellFilters.delete(agent)
      return
    }
    if (active !== undefined || agent.ctx?.tools === undefined) return
    mainShellFilters.set(agent, restrictInheritedShell(agent.ctx, agent, 'MAIN'))
  }
  const bundledSkillRoots = new Map(
    loadBundledSkills().flatMap(skill => skill.directory === undefined ? [] : [[skill.name, skill.directory] as const]),
  )
  const readableResourceRootsFor = (sessionId: string, role: AutoReportRole): string[] => {
    if (role !== 'REPORT') return []
    const language = runtime.reportLanguageForChild(sessionId as SessionId) ?? 'latex'
    return skillNamesForRole('REPORT', language).flatMap(skillName => {
      const root = bundledSkillRoots.get(skillName)
      return root === undefined ? [] : [root]
    })
  }
  // DSH tools are inherited through agent scopes. Register role-local list and
  // grep tools, plus same-name shell/path variants, so content search stays on
  // ctx.fs and process/workdir guidance follows each AutoReport role.
  const configureRoleAgent = async (agent: Agent): Promise<void> => {
    const session = agent.session
    const role: AutoReportRole | undefined = runtime.roleFor(String(agent.id))
      ?? (isAutoReportMainSession(session) ? 'MAIN' : undefined)
    const existing = configuredRoles.get(agent)
    if (role === undefined) {
      existing?.dispose()
      configuredRoles.delete(agent)
      return
    }
    const sessionRoot = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0
      ? resolve(session.header.cwd)
      : undefined
    const workspaceRoot = resolved.workspaceRoot ?? sessionRoot
    if (workspaceRoot === undefined) {
      existing?.dispose()
      configuredRoles.delete(agent)
      throw new Error(`AutoReport ${role} cannot configure tools without a workspace root`)
    }
    if (existing?.role === role && existing.workspaceRoot === workspaceRoot) return
    existing?.dispose()
    configuredRoles.delete(agent)
    if (sandboxPolicy === undefined && resolved.workspaceRoot !== undefined
      && (sessionRoot === undefined || resolve(resolved.workspaceRoot) !== sessionRoot)) {
      throw new Error(
        `AutoReport ${role} requires DSH sandboxPolicy when configured workspaceRoot ${resolve(resolved.workspaceRoot)} differs from session cwd ${sessionRoot ?? '(missing)'}; without the service DSH resolves relative file and shell paths from session cwd`,
      )
    }
    const releases: Array<() => void> = []
    const register = (tool: ToolDefinition): void => { releases.push(agent.ctx.tools.register(tool)) }
    const dispose = (): void => { for (const release of releases.reverse()) release() }
    const readableRoots = [workspaceRoot, ...readableResourceRootsFor(String(agent.id), role)]
    try {
      const fileSystem = ctx.get('fs') as DirectoryFileSystem | undefined
      const searchFileSystem = ctx.get('fs') as SearchFileSystem | undefined
      register(createListDirectoryTool(workspaceRoot, agent, fileSystem))
      register(createGrepTool(workspaceRoot, agent, searchFileSystem))
      let processToolAvailable = false
      if (rolePolicy(role).hasProcessTool) {
        const shell = agent.ctx.tools.get(ROLE_PROCESS_TOOL, agent)
        if (shell !== undefined) {
          register(wrapRoleAwareShell(shell, role, workspaceRoot))
          processToolAvailable = true
        }
      }
      // The stock filesystem schemas leave the path base implicit. AutoReport
      // unifies all model-facing paths to experiment-workspace-relative: the
      // adapter rewrites every relative path to an absolute workspace path and
      // the DSH sandbox (rooted at the writable root) enforces writes.
      for (const name of FILE_PATH_TOOLS) {
        const tool = agent.ctx.tools.get(name, agent)
        if (tool === undefined) continue
        const isMutation = name === 'write' || name === 'edit'
        const relativePathGuidance = `Relative paths resolve from ${workspaceRoot}.`
        const filePathGuidance = isMutation
          ? `AutoReport path semantics: paths are experiment-workspace-relative, e.g. \`Report/main.typ\`. ${relativePathGuidance} This role may write only inside ${rolePolicy(role).writableRoot}/.`
          : `AutoReport path semantics: paths are experiment-workspace-relative; the \`list\` and \`grep\` paths, manifest paths, and report_workflow produced_files use the same convention. ${relativePathGuidance} Skill resources use the absolute resourceBase shown when the skill is loaded.`
        const operationGuidance = name === 'read'
          ? 'read accepts a file path only; it does not list directory contents, does not expand wildcard characters such as `*`, and never guesses filenames. Use list to inspect a directory.'
          : ''
        const execute = tool.execute
        register({
          ...tool,
          description: `${tool.description} ${filePathGuidance} ${operationGuidance}`.trim(),
          async execute(args, execution) {
            const fields = typeof args === 'object' && args !== null && !Array.isArray(args)
              ? args as Record<string, unknown>
              : undefined
            const path = fields === undefined ? undefined : fields['file_path']
            if (typeof path !== 'string') return execute(args, execution)
            if (/[*?[\]]/u.test(path)) {
              throw new Error(
                `${name} does not expand wildcard characters; "${path}" is not a literal file path. `
                + 'Use list on the literal parent directory to discover actual filenames.',
              )
            }
            const targetPath = isAbsolute(path) ? path : resolve(workspaceRoot, path)
            if ((name === 'read' || name === 'read_image') && fileSystem !== undefined) {
              const target = await fileSystem.resolve(targetPath, { signal: execution.signal })
              const info = await fileSystem.stat(target, execution.signal)
              if (info?.type === 'directory') {
                const directory = relative(workspaceRoot, target.displayPath).split(sep).join('/') || '.'
                throw new Error(
                  `${name} accepts a file path, not a directory. Use list with path "${directory}" to inspect entries. `
                  + `Readable directories: ${readableRoots.map(path => `"${path}"`).join(', ')}.`,
                )
              }
              if (info === undefined) {
                const directory = relative(workspaceRoot, target.displayPath).split(sep).join('/') || '.'
                throw new Error(
                  `file "${path}" does not exist. Do not guess additional filenames; `
                  + `use list with path "${directory}" to discover actual names.`,
                )
              }
            }
            return isAbsolute(path) ? execute(args, execution) : execute({ ...fields, file_path: targetPath }, execution)
          },
        })
      }
      releases.push(restrictRoleToolSurface(agent, role, processToolAvailable))
      assertRoleToolSurface(agent, role, processToolAvailable)
      configuredRoles.set(agent, { role, workspaceRoot, dispose })
      // Rehydrate resident activations only after Main's scoped tools are ready,
      // so resumed specialists inherit the same composed workspace as before.
      if (role === 'MAIN') await runtime.restoreResidentRoles(agent)
    } catch (error) {
      configuredRoles.delete(agent)
      dispose()
      throw error
    }
  }
  const disposeRoleAgent = (agent: Agent): void => {
    configuredRoles.get(agent)?.dispose()
    configuredRoles.delete(agent)
  }
  ctx.on('agent/created', async ({ agent }) => {
    liveAgents.set(String(agent.id), agent)
    refreshMainShell(agent)
    await configureRoleAgent(agent)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    if (liveAgents.get(String(agent.id)) === agent) liveAgents.delete(String(agent.id))
    mainShellFilters.get(agent)?.()
    mainShellFilters.delete(agent)
    disposeRoleAgent(agent)
    return undefined
  }, { global: true })
  ctx.on('agent-preset/selected', async (sessionId, _agentPreset) => {
    const key = String(sessionId)
    const agent = liveAgents.get(key)
      ?? (ctx.get('agents') as { list?: () => Agent[] } | undefined)?.list?.()
        .find(candidate => String(candidate.session.id) === key)
    if (agent === undefined) return
    refreshMainShell(agent)
    // DSH publishes this unscoped event after committing the selected preset.
    // Web may have created the Agent earlier under `standard`, so compose the
    // AutoReport tools now, before its first model request is assembled.
    await configureRoleAgent(agent)
  }, { global: true })
  for (const agent of (ctx.get('agents') as { list?: () => Agent[] } | undefined)?.list?.() ?? []) {
    liveAgents.set(String(agent.id), agent)
    refreshMainShell(agent)
    await configureRoleAgent(agent)
  }
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
    readableResourceRootsOf: (sessionId, role) => {
      return readableResourceRootsFor(String(sessionId), role)
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
        roleOf: session => runtime.roleFor(String(session.id)),
        snapshotPythonExecutable: session =>
          runtime.projectionFor(String(session.id))?.meta?.settings?.pythonExecutable,
      }),
      'autoreport.pythonContext()',
    )
    promptCtx.effect(
      () => installFilesystemScopeContext(promptCtx, {
        roleOf: session => runtime.roleFor(String(session.id))
          ?? (isAutoReportMainSession(session) ? 'MAIN' : undefined),
        workspaceRootOf: session => resolved.workspaceRoot
          ?? (typeof session.header?.cwd === 'string' ? resolve(session.header.cwd) : undefined),
      }),
      'autoreport.filesystemScopeContext()',
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
