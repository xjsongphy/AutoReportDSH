/**
 * Synchronous AutoReport role guard over DSH's immutable ToolExecution.
 *
 * The guard is authorization, not visibility. Presets omit generic shell tools,
 * but this guard still denies them if composition drifts. Filesystem targets are
 * canonicalized through the closest existing ancestor so a workspace symlink
 * cannot escape a role's writable roots.
 * @module
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import { rolePolicy, type AutoReportRole, type ReportRolePolicy } from '../roles.js'
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
}

interface ResolvedRole {
  readonly role: AutoReportRole
  readonly policy: ReportRolePolicy
  readonly workspaceRoot: string
}

type Mutation =
  | { readonly kind: 'none' }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'unrestricted-exec' }

/** Executors the role guard refuses outright; specialists must use report_exec. */
export const UNRESTRICTED_EXECUTORS = new Set([
  'bash',
  'pwsh',
  'bash_persistent',
  'pwsh_persistent',
  'terminal',
  'terminal_open',
])

/** Model-facing tools whose success mutates workspace files; observed by the artifact observer. */
export const MUTATION_TOOL_NAMES = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'delete',
  'delete_file',
  'apply_patch',
])

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

/** Extract Codex-style patch targets without interpreting patch content. */
function patchTargets(args: Readonly<Record<string, unknown>>): Mutation {
  const patch = stringField(args, 'patch', 'input')
  if (patch === undefined) return { kind: 'malformed', reason: 'apply_patch requires string patch input' }
  const paths: string[] = []
  for (const line of patch.split(/\r?\n/u)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line)
    if (match?.[1] !== undefined) paths.push(match[1])
  }
  return paths.length > 0
    ? { kind: 'paths', paths }
    : { kind: 'malformed', reason: 'apply_patch contains no recognized file headers' }
}

/** Describe a mutation call using current DSH tool schemas. */
function mutation(exec: Readonly<ToolExecution>): Mutation {
  if (UNRESTRICTED_EXECUTORS.has(exec.name)) return { kind: 'unrestricted-exec' }
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
      return path === undefined
        ? { kind: 'malformed', reason: 'str_replace_editor mutation requires path' }
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

function resolveRole(exec: Readonly<ToolExecution>, options: RoleGuardOptions): ResolvedRole | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const configuredRoot = options.workspaceRoot ?? session.header.cwd
  if (configuredRoot === undefined) return undefined
  const workspaceRoot = canonicalPath(configuredRoot)
  if (
    (options.mainSessionId !== undefined && session.id === options.mainSessionId)
    || options.isMainSession?.(session.id) === true
  ) {
    return { role: 'MAIN', policy: rolePolicy('MAIN'), workspaceRoot }
  }
  const entry = options.registry.lookup(session.id)
  return entry === undefined
    ? undefined
    : { role: entry.binding.role, policy: entry.policy, workspaceRoot }
}

function targetDenial(target: string, resolved: ResolvedRole): string | undefined {
  if (target.includes('\0')) return 'AutoReport write target contains a NUL byte'
  const absolute = canonicalPath(isAbsolute(target) ? target : resolve(resolved.workspaceRoot, target))
  if (!contained(resolved.workspaceRoot, absolute)) {
    return `AutoReport ${resolved.role} cannot write outside the experiment workspace: ${target}`
  }
  const allowed = resolved.policy.writableRoots.some(root =>
    contained(canonicalPath(resolve(resolved.workspaceRoot, root)), absolute))
  return allowed
    ? undefined
    : `AutoReport ${resolved.role} may write only ${resolved.policy.writableRoots.join(', ')}: ${target}`
}

/**
 * Create the monotonic role guard registered through `ctx.tools.guard()`.
 * @param options - registry and Main/workspace identity inputs.
 * @returns synchronous fail-closed DSH guard.
 */
export function createRoleToolGuard(options: RoleGuardOptions): ToolGuard {
  return exec => {
    const call = mutation(exec)
    const protectedCall = call.kind !== 'none' || exec.name === 'report_exec' || exec.name === 'compile_report'
    if (!protectedCall) return undefined

    const resolved = resolveRole(exec, options)
    if (resolved === undefined) return `AutoReport denied ${exec.name}: calling agent has no valid role binding`

    if (call.kind === 'unrestricted-exec') {
      return `AutoReport ${resolved.role} must use report_exec instead of unrestricted ${exec.name}`
    }
    if (call.kind === 'malformed') return `AutoReport denied ${exec.name}: ${call.reason}`
    if (exec.name === 'report_exec' && resolved.role === 'MAIN') {
      return 'AutoReport MAIN cannot execute processes; delegate to a specialist'
    }
    if (exec.name === 'compile_report' && resolved.role !== 'REPORT') {
      return 'AutoReport compile_report is available only to REPORT'
    }
    if (call.kind === 'paths') {
      for (const path of call.paths) {
        const denied = targetDenial(path, resolved)
        if (denied !== undefined) return denied
      }
    }
    return undefined
  }
}
