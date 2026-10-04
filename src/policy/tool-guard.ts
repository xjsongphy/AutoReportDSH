/**
 * Synchronous AutoReport role guard over DSH's immutable ToolExecution.
 *
 * The guard is an execution backstop in addition to role-scoped tool rosters,
 * and it stays deliberately small because the permission model is small:
 *
 * 1. Read scope is the whole experiment workspace for every role — the guard
 *    enforces only the workspace boundary, never role boundaries.
 * 2. The single writable root per role is the real boundary. `write`/`edit`
 *    targets are resolved against the experiment root (all model paths are
 *    workspace-relative) and must land inside the role's writable root;
 *    DSH's native sandbox re-checks the same property at process level.
 * 3. Process tools exist only for roles with `hasProcessTool`, and shell
 *    calls are never parsed — the OS sandbox owns their write effects.
 *
 * Filesystem targets are canonicalized through the closest existing ancestor
 * so a workspace symlink cannot escape a role's writable roots.
 *
 * Coexistence: only AutoReport-owned sessions are restricted — a MAIN root is
 * one actually running the `autoreport` preset, or explicitly wired as Main, and
 * a specialist child is one bound in the RoleRegistry. Every other caller passes
 * through untouched so stock DSH sessions keep their native policy when the
 * overlay is loaded.
 * @module
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import { isAutoReportPreset, resolveAgentPreset } from '../membership.js'
import { DSH_ROLE_CONTROL_TOOL_NAMES, ROLE_PROCESS_TOOL, rolePolicy, type AutoReportRole, type ReportRolePolicy } from '../roles.js'
import type { RoleRegistry } from '../workflow/role-registry.js'

/** Inputs needed by the role guard. */
export interface RoleGuardOptions {
  /** Synchronous specialist authorization projection. */
  readonly registry: RoleRegistry
  /** Main session identity; Main is not a child role binding. */
  readonly mainSessionId?: SessionId | undefined
  /** Alternate Main identity check for multiple live parent sessions. */
  readonly isMainSession?: ((sessionId: SessionId) => boolean) | undefined
  /** Optional explicit workspace root, otherwise each session's immutable cwd. */
  readonly workspaceRoot?: string | undefined
  /** Exact registered skill bundle roots the current role may read. */
  readonly readableResourceRootsOf?: ((sessionId: SessionId, role: AutoReportRole) => readonly string[]) | undefined
}

interface ResolvedRole {
  readonly role: AutoReportRole
  readonly policy: ReportRolePolicy
  readonly workspaceRoot: string
  readonly readableResourceRoots: readonly string[]
}

type Mutation =
  | { readonly kind: 'none' }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'malformed'; readonly reason: string }

type ReadTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'malformed'; readonly reason: string }

/** Model-facing tools whose success mutates workspace files; observed by the artifact observer. */
export const MUTATION_TOOL_NAMES = new Set([
  'write', 'edit', 'delete', 'delete_file', 'apply_patch', 'str_replace_editor',
])

/** DSH tools deliberately omitted from every AutoReport model surface. */
const HIDDEN_DSH_TOOL_NAMES = new Set(['glob', 'str_replace_editor'])

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function stringField(args: Readonly<Record<string, unknown>>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function hasUriScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) && !/^[A-Za-z]:[\\/]/u.test(path)
}

/** Extract Codex-style patch targets without interpreting patch content. */
function patchTargets(args: Readonly<Record<string, unknown>>): Mutation {
  const paths = new Set<string>()
  const patch = typeof args['patch'] === 'string' ? args['patch'] : undefined
  if (patch !== undefined) {
    for (const line of patch.split('\n')) {
      for (const prefix of ['*** Update File: ', '*** Delete File: ', '*** Add File: ']) {
        if (line.startsWith(prefix)) {
          const target = line.slice(prefix.length).trim()
          if (target.length > 0) paths.add(target)
        }
      }
    }
    if (paths.size === 0) return { kind: 'malformed', reason: 'apply_patch names no file targets' }
  }
  return paths.size === 0
    ? { kind: 'none' }
    : { kind: 'paths', paths: [...paths] }
}

/** Describe a mutation call using current DSH tool schemas. */
function mutation(exec: Readonly<ToolExecution>): Mutation {
  const args = record(exec.arguments)
  switch (exec.name) {
    case 'write':
    case 'edit': {
      const path = args === undefined ? undefined : stringField(args, 'file_path')
      return path === undefined
        ? { kind: 'malformed', reason: `${exec.name} requires file_path` }
        : { kind: 'paths', paths: [path] }
    }
    case 'str_replace_editor': {
      if (args === undefined) return { kind: 'malformed', reason: 'str_replace_editor requires arguments' }
      if (args['command'] === 'view') return { kind: 'none' }
      if (!['create', 'str_replace', 'insert'].includes(String(args['command']))) {
        return { kind: 'malformed', reason: 'str_replace_editor carries an unknown command' }
      }
      const path = stringField(args, 'path')
      if (path === undefined) return { kind: 'malformed', reason: 'str_replace_editor mutation requires path' }
      return !isAbsolute(path)
        ? { kind: 'malformed', reason: 'str_replace_editor path must be absolute' }
        : { kind: 'paths', paths: [path] }
    }
    // DSH currently mounts no delete/apply-patch tool. These strict adapters
    // protect the AutoReport/Codex-compatible variants if mounted later.
    case 'delete':
    case 'delete_file': {
      const path = args === undefined ? undefined : stringField(args, 'file_path', 'path')
      return path === undefined
        ? { kind: 'malformed', reason: `${exec.name} requires file_path or path` }
        : { kind: 'paths', paths: [path] }
    }
    case 'apply_patch':
      return args === undefined
        ? { kind: 'malformed', reason: 'apply_patch requires arguments' }
        : patchTargets(args)
    default:
      return { kind: 'none' }
  }
}

/** Extract paths from the model-facing read tools without trusting their spelling. */
function readTarget(exec: Readonly<ToolExecution>): ReadTarget {
  const args = record(exec.arguments)
  if (args === undefined) return { kind: 'none' }
  if (exec.name === 'read' || exec.name === 'read_image') {
    const path = stringField(args, 'file_path')
    if (path !== undefined && hasUriScheme(path)) {
      return { kind: 'malformed', reason: 'remote URI paths are not supported by the AutoReport workspace policy' }
    }
    return path === undefined
      ? { kind: 'malformed', reason: `${exec.name} requires file_path` }
      : { kind: 'path', path }
  }
  if (exec.name === 'str_replace_editor' && args['command'] === 'view') {
    const path = stringField(args, 'path')
    if (path === undefined) return { kind: 'malformed', reason: 'str_replace_editor view requires path' }
    return !isAbsolute(path)
      ? { kind: 'malformed', reason: 'str_replace_editor path must be absolute' }
      : { kind: 'path', path }
  }
  if (exec.name === 'list') {
    const path = stringField(args, 'path') ?? '.'
    const depth = args['depth'] ?? 1
    if (isAbsolute(path) || hasUriScheme(path)) {
      return { kind: 'malformed', reason: 'list path must be workspace-relative' }
    }
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 4) {
      return { kind: 'malformed', reason: 'list depth must be an integer from 1 through 4' }
    }
    return { kind: 'none' }
  }
  if (exec.name === 'grep') {
    const path = stringField(args, 'path') ?? '.'
    const pattern = stringField(args, 'pattern')
    if (pattern === undefined || pattern.length > 256) {
      return { kind: 'malformed', reason: 'grep requires a literal pattern from 1 through 256 characters' }
    }
    if (isAbsolute(path) || hasUriScheme(path)) {
      return { kind: 'malformed', reason: 'grep path must be workspace-relative' }
    }
    return { kind: 'none' }
  }
  return { kind: 'none' }
}

/** Canonicalize a path through its closest existing ancestor. */
function canonicalPath(path: string): string {
  let cursor = resolve(path)
  const suffix: string[] = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  let canonical = cursor
  try {
    canonical = realpathSync.native(cursor)
  } catch {
    // A missing/unreadable filesystem root remains its absolute spelling; the
    // containment check below cannot manufacture authority from that failure.
  }
  return resolve(canonical, ...suffix)
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const FOREIGN = 'foreign'

function resolveRole(
  exec: Readonly<ToolExecution>,
  options: RoleGuardOptions,
): ResolvedRole | typeof FOREIGN | undefined {
  const session = exec.agent?.session
  if (session === undefined) return FOREIGN
  const configuredRoot = options.workspaceRoot ?? session.header.cwd

  // A synchronous RoleRegistry binding is the authoritative specialist
  // identity: `send_to_agent` reserves the child BEFORE publishing it, so a
  // bound child is fail-closed from its very first tool call onward.
  const entry = options.registry.lookup(session.id)
  if (entry !== undefined) {
    if (configuredRoot === undefined) return undefined
    return {
      role: entry.binding.role,
      policy: entry.policy,
      workspaceRoot: canonicalPath(configuredRoot),
      readableResourceRoots: (options.readableResourceRootsOf?.(session.id, entry.binding.role) ?? []).map(canonicalPath),
    }
  }
  // Unbound continuable child: an ordinary DSH child (stock report tool,
  // stock write policy) that this global overlay must leave untouched.
  if (session.header.parentSession !== undefined) return FOREIGN

  // Top-level session: MAIN when explicitly wired (single-parent hosts and
  // tests) or when the session actually runs the AutoReport Main preset
  // (header value or a later logged preset selection). Any other root is a
  // stock DSH session whose native behavior must be preserved.
  const explicitMain = (options.mainSessionId !== undefined && session.id === options.mainSessionId)
    || options.isMainSession?.(session.id) === true
  if (!explicitMain && !isAutoReportPreset(resolveAgentPreset(session))) return FOREIGN
  if (configuredRoot === undefined) return undefined
  return {
    role: 'MAIN',
    policy: rolePolicy('MAIN'),
    workspaceRoot: canonicalPath(configuredRoot),
    readableResourceRoots: (options.readableResourceRootsOf?.(session.id, 'MAIN') ?? []).map(canonicalPath),
  }
}

function writableHelp(resolved: ResolvedRole): string {
  return `the role writable root is ${resolved.policy.writableRoot}/`
}

/** Workspace-boundary denial for a read target; role boundaries never apply to reads. */
function readBoundaryDenial(target: string, resolved: ResolvedRole): string | undefined {
  if (hasUriScheme(target) || target.includes('\0')) {
    return `AutoReport does not support URI or NUL read paths: ${target}`
  }
  const absolute = canonicalPath(isAbsolute(target) ? target : resolve(resolved.workspaceRoot, target))
  const withinWorkspace = contained(resolved.workspaceRoot, absolute)
  const withinSkillResource = resolved.readableResourceRoots.some(root => contained(root, absolute))
  if (!withinWorkspace && !withinSkillResource) {
    const roots = [resolved.workspaceRoot, ...resolved.readableResourceRoots]
      .map(root => `"${root}"`).join(', ')
    return `AutoReport ${resolved.role} can read only the experiment workspace and its skill resources. `
      + `Readable directories for this role: ${roots}. Requested path: ${target}`
  }
  return undefined
}

/** Single writable-root check for a mutation target; all paths are workspace-relative. */
function targetDenial(target: string, resolved: ResolvedRole): string | undefined {
  if (hasUriScheme(target)) return `AutoReport does not support URI write paths: ${target}; ${writableHelp(resolved)}`
  if (target.includes('\0')) return `AutoReport write target contains a NUL byte; ${writableHelp(resolved)}`
  const absolute = canonicalPath(isAbsolute(target)
    ? target
    : resolve(resolved.workspaceRoot, target))
  if (!contained(resolved.workspaceRoot, absolute)) {
    return `AutoReport ${resolved.role} cannot write outside the experiment workspace: ${target}; ${writableHelp(resolved)}`
  }
  const writableRoot = canonicalPath(resolve(resolved.workspaceRoot, resolved.policy.writableRoot))
  if (!contained(writableRoot, absolute)) {
    return `AutoReport ${resolved.role} writes only inside ${resolved.policy.writableRoot}/: ${target}`
  }
  return undefined
}

function prepareMutationParent(
  exec: Readonly<ToolExecution>,
  target: string,
  resolved: ResolvedRole,
): string | undefined {
  if (exec.name === 'delete' || exec.name === 'delete_file') return undefined
  const absolute = isAbsolute(target)
    ? resolve(target)
    : resolve(resolved.workspaceRoot, target)
  try {
    mkdirSync(dirname(absolute), { recursive: true })
    return undefined
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return 'AutoReport ' + resolved.role
      + ' could not create its writable directory (' + resolved.policy.writableRoot + ') for ' + target
      + '; run /init to repair the workspace (' + detail + ')'
  }
}

function sandboxPermissionsEscalation(exec: Readonly<ToolExecution>): boolean {
  const args = record(exec.arguments)
  return args !== undefined && typeof args['sandbox_permissions'] === 'string'
}

/**
 * Create the monotonic role guard registered through `ctx.tools.guard()`.
 * Generic process escalation is never permitted. MAIN uses its dedicated
 * environment tool for package changes; specialists report `missing_dependency`.
 * @param options - registry and Main/workspace identity inputs.
 * @returns synchronous fail-closed DSH guard.
 */
export function createRoleToolGuard(options: RoleGuardOptions): ToolGuard {
  return exec => {
    const call = mutation(exec)
    const read = readTarget(exec)
    const shellCall = exec.name === 'bash' || exec.name === 'pwsh'
    const specializedCall = exec.name === 'compile_report' || exec.name === 'render_report_page'
      || exec.name === 'extract_pdf' || exec.name === 'install_python_package'
    const protectedCall = call.kind !== 'none' || read.kind !== 'none' || sandboxPermissionsEscalation(exec)
      || shellCall
      || specializedCall
      || DSH_ROLE_CONTROL_TOOL_NAMES.includes(exec.name as typeof DSH_ROLE_CONTROL_TOOL_NAMES[number])
    const resolved = resolveRole(exec, options)
    // Not an AutoReport-owned session: preserve stock DSH policy untouched.
    if (resolved === FOREIGN) return undefined
    if (resolved === undefined) return protectedCall
      ? `AutoReport denied ${exec.name}: calling agent has no valid role binding`
      : undefined

    if (DSH_ROLE_CONTROL_TOOL_NAMES.includes(exec.name as typeof DSH_ROLE_CONTROL_TOOL_NAMES[number])
      && !resolved.policy.tools.includes(exec.name)) {
      return `AutoReport ${resolved.role} cannot use ${exec.name}; delegate through the fixed AutoReport role workflow`
    }
    if (exec.name === 'compile_report' && resolved.role !== 'REPORT') return 'compile_report belongs to REPORT'
    if (exec.name === 'render_report_page' && resolved.role !== 'REPORT') return 'render_report_page belongs to REPORT'
    if (exec.name === 'extract_pdf' && resolved.role !== 'MAIN') return 'extract_pdf belongs to MAIN'
    if (exec.name === 'install_python_package' && resolved.role !== 'MAIN') return 'install_python_package belongs to MAIN'
    if (sandboxPermissionsEscalation(exec)) {
      return 'AutoReport denies generic sandbox escalation; use the dedicated MAIN environment capability for package changes'
    }
    if (shellCall) {
      if (!resolved.policy.hasProcessTool) {
        return `AutoReport ${resolved.role} has no process tool; use its dedicated tools and assigned specialists`
      }
      if (exec.name !== ROLE_PROCESS_TOOL) {
        return `AutoReport process execution on ${process.platform} uses the ${ROLE_PROCESS_TOOL} tool; ${exec.name} is unavailable`
      }
      // A preset-mounted stock shell can replace the AutoReport compute shell,
      // which is foreground-only; background jobs are outside the role model.
      if (record(exec.arguments)?.['run_in_background'] === true) {
        return `AutoReport shell calls are foreground-only; ${resolved.role} cannot start background jobs`
      }
    }
    if (!resolved.policy.tools.includes(exec.name)) {
      // Restricted DSH tools should fall through to the registry's ordinary
      // UNKNOWN_TOOL result instead of teaching the model about hidden tools.
      if (HIDDEN_DSH_TOOL_NAMES.has(exec.name)) return undefined
      return `AutoReport ${resolved.role} has no declared capability for ${exec.name}; use its role-scoped tools`
    }
    if (!protectedCall) return undefined
    if (call.kind === 'malformed') return `AutoReport denied ${exec.name}: ${call.reason}`
    if (read.kind === 'malformed') return `AutoReport denied ${exec.name}: ${read.reason}`
    if (read.kind === 'path') {
      const denial = readBoundaryDenial(read.path, resolved)
      if (denial !== undefined) return `AutoReport denied ${exec.name}: ${denial}`
    }
    if (call.kind === 'paths') {
      for (const path of call.paths) {
        const denied = targetDenial(path, resolved)
        if (denied !== undefined) return denied
        const preparation = prepareMutationParent(exec, path, resolved)
        if (preparation !== undefined) return preparation
      }
    }
    return undefined
  }
}
