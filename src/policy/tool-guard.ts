/**
 * Synchronous AutoReport role guard over DSH's immutable ToolExecution.
 *
 * The guard is an execution backstop in addition to role-scoped tool rosters.
 * It enforces role membership, file/discovery scopes, process policy, and
 * defense-in-depth write-path checks against role writable roots.
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
import { DSH_ROLE_CONTROL_TOOL_NAMES, rolePolicy, type AutoReportRole, type ReportRolePolicy } from '../roles.js'
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
  /** Actual DSH base for relative mutations and bash/pwsh workdir; defaults to the role root. */
  readonly relativeWriteRootOf?: ((session: { id: unknown; header?: { cwd?: string } }, role: AutoReportRole, workspaceRoot: string) => string) | undefined
  /** Exact registered skill bundle roots the current role may read. */
  readonly readableResourceRootsOf?: ((sessionId: SessionId, role: AutoReportRole) => readonly string[]) | undefined
}

interface ResolvedRole {
  readonly role: AutoReportRole
  readonly policy: ReportRolePolicy
  readonly workspaceRoot: string
  readonly relativeWriteRoot: string
  readonly readableResourceRoots: readonly string[]
}

type Mutation =
  | { readonly kind: 'none' }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'malformed'; readonly reason: string }

type ReadTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'discover'; readonly path: string }
  | { readonly kind: 'search'; readonly path: string }
  | { readonly kind: 'malformed'; readonly reason: string }

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

function hasUriScheme(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) && !/^[A-Za-z]:[\\/]/u.test(path)
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
    return { kind: 'discover', path }
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
    return { kind: 'search', path }
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

interface ResolvedPolicyRoot {
  readonly logical: string
  readonly canonical: string
}

/** Refuse a configured role root that resolves through a symlink into a sibling subtree. */
function resolvedPolicyRoots(resolved: ResolvedRole, roots: readonly string[]): ResolvedPolicyRoot[] {
  return roots.flatMap(root => {
    const logical = resolve(resolved.workspaceRoot, root === '.' ? '' : root)
    const canonical = canonicalPath(logical)
    return contained(logical, canonical) ? [{ logical, canonical }] : []
  })
}

/**
 * Sentinel resolution: the calling session never selected AutoReport (an
 * ordinary root, an ordinary DSH continuable child, or an agentless call).
 * The guard must NOT restrict it — "unknown to AutoReport" means "not our
 * session", not "invalid AutoReport session".
 */
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
    const workspaceRoot = canonicalPath(configuredRoot)
    const role = entry.binding.role
    const defaultWritableRoot = rolePolicy(role).writableRoots[0]
    if (defaultWritableRoot === undefined) return undefined
    return {
      role,
      policy: entry.policy,
      workspaceRoot,
      relativeWriteRoot: canonicalPath(options.relativeWriteRootOf?.(session, role, workspaceRoot)
        ?? resolve(workspaceRoot, defaultWritableRoot)),
      readableResourceRoots: (options.readableResourceRootsOf?.(session.id, role) ?? []).map(canonicalPath),
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
  const workspaceRoot = canonicalPath(configuredRoot)
  const defaultWritableRoot = rolePolicy('MAIN').writableRoots[0]
  if (defaultWritableRoot === undefined) return undefined
  return {
    role: 'MAIN',
    policy: rolePolicy('MAIN'),
    workspaceRoot,
    relativeWriteRoot: canonicalPath(options.relativeWriteRootOf?.(session, 'MAIN', workspaceRoot)
      ?? resolve(workspaceRoot, defaultWritableRoot)),
    readableResourceRoots: (options.readableResourceRootsOf?.(session.id, 'MAIN') ?? []).map(canonicalPath),
  }
}

function targetDenial(target: string, resolved: ResolvedRole): string | undefined {
  if (hasUriScheme(target)) return `AutoReport does not support URI write paths: ${target}; ${directoryHelp(resolved)}`
  if (target.includes('\0')) return `AutoReport write target contains a NUL byte; ${directoryHelp(resolved)}`
  // DSH's filesystem tools resolve relative mutations from the sandbox policy
  // workspaceRoot, which AutoReport pins to the role root. Absolute paths keep
  // their ordinary workspace/host meaning and are checked against the same
  // role root below.
  const absolute = canonicalPath(isAbsolute(target)
    ? target
    : resolve(resolved.relativeWriteRoot, target))
  if (!contained(resolved.workspaceRoot, absolute)) {
    return `AutoReport ${resolved.role} cannot write outside the experiment workspace: ${target}; ${directoryHelp(resolved)}`
  }
  const allowed = resolvedPolicyRoots(resolved, resolved.policy.writableRoots)
    .some(root => contained(root.logical, absolute) && contained(root.canonical, absolute))
  return allowed
    ? undefined
    : `AutoReport ${resolved.role} may write only ${resolved.policy.writableRoots.join(', ')}: ${target}; ${directoryHelp(resolved)}`
}

function readableDirectories(resolved: ResolvedRole): string {
  return resolved.policy.readableRoots.map(root => root === '.' ? '.' : `${root}/`).join(', ')
}

function directoryHelp(resolved: ResolvedRole): string {
  const discoverable = resolved.policy.discoverableRoots.map(root => `${root}/`).join(', ')
  const writable = resolved.policy.writableRoots.map(root => `${root}/`).join(', ')
  const skillRoots = resolved.readableResourceRoots.length === 0
    ? ''
    : `; registered skill resource roots: ${resolved.readableResourceRoots.join(', ')}`
  return `discoverable directories: ${discoverable}; allowed read directories: ${readableDirectories(resolved)}${skillRoots}; allowed write directories: ${writable}`
}

function readableTargetDenial(target: string, resolved: ResolvedRole, base = resolved.workspaceRoot): string | undefined {
  if (hasUriScheme(target)) return `remote URI paths are not supported by the AutoReport workspace policy; ${directoryHelp(resolved)}`
  if (target.includes('\0')) return `path contains a NUL byte; ${directoryHelp(resolved)}`
  const absolute = canonicalPath(isAbsolute(target) ? target : resolve(base, target))
  if (resolved.readableResourceRoots.some(root => contained(root, absolute))) return undefined
  if (!contained(resolved.workspaceRoot, absolute)) return `path is outside the experiment workspace: ${target}; ${directoryHelp(resolved)}`
  const allowed = resolvedPolicyRoots(resolved, resolved.policy.readableRoots)
    .some(root => contained(root.logical, absolute) && contained(root.canonical, absolute))
  return allowed
    ? undefined
    : `path is not readable by AutoReport ${resolved.role}; ${directoryHelp(resolved)}`
}

function workspaceDiscoveryDenial(
  target: string,
  roots: readonly string[],
  resolved: ResolvedRole,
  capability: 'discover' | 'read',
): string | undefined {
  if (hasUriScheme(target)) return `${capability} URI paths are not supported by the AutoReport workspace policy; ${directoryHelp(resolved)}`
  if (target.includes('\0')) return `${capability} path contains a NUL byte; ${directoryHelp(resolved)}`
  const absolute = canonicalPath(resolve(resolved.workspaceRoot, target))
  if (!contained(resolved.workspaceRoot, absolute)) {
    return `${capability} path is outside the experiment workspace: ${target}; ${directoryHelp(resolved)}`
  }
  // list/grep may walk down from a parent, but those tools independently
  // filter every returned entry/content read against the declared roots.
  const allowedRoots = resolvedPolicyRoots(resolved, roots)
  const allowed = allowedRoots.some(root => (
    contained(root.canonical, absolute) && contained(root.logical, absolute)
  ) || (
    contained(absolute, root.canonical) && contained(absolute, root.logical)
  ))
  return allowed
    ? undefined
    : `${capability} path is outside this role's ${capability === 'discover' ? 'discoverable' : 'readable'} roots: ${target}; ${directoryHelp(resolved)}`
}

function discoverableTargetDenial(target: string, resolved: ResolvedRole): string | undefined {
  return workspaceDiscoveryDenial(target, resolved.policy.discoverableRoots, resolved, 'discover')
}

function grepTargetDenial(target: string, resolved: ResolvedRole): string | undefined {
  return workspaceDiscoveryDenial(target, resolved.policy.readableRoots, resolved, 'read')
}

function bashWriteTargetDenial(target: string, resolved: ResolvedRole, cwd: string): string | undefined {
  if (hasUriScheme(target)) return `URI write paths are not supported by AutoReport: ${target}; ${directoryHelp(resolved)}`
  if (target.includes('\0')) return `write target contains a NUL byte; ${directoryHelp(resolved)}`
  if (target === '/dev/null' || target === 'NUL') return undefined
  const absolute = canonicalPath(isAbsolute(target) ? target : resolve(cwd, target))
  if (!contained(resolved.workspaceRoot, absolute)) {
    return `write target is outside the experiment workspace: ${target}; ${directoryHelp(resolved)}`
  }
  const allowed = resolvedPolicyRoots(resolved, resolved.policy.writableRoots)
    .some(root => contained(root.logical, absolute) && contained(root.canonical, absolute))
  return allowed
    ? undefined
    : `write target is outside this role's writable directories: ${target}; ${directoryHelp(resolved)}`
}

const COMMON_BASH_COMMANDS = [
  'awk', 'basename', 'cat', 'cd', 'cp', 'cut', 'dirname', 'du', 'echo', 'false', 'file', 'find', 'grep', 'head',
  'ls', 'mkdir', 'mv', 'printf', 'pwd', 'rg', 'rm', 'sed', 'sort', 'stat', 'tail', 'touch', 'tr', 'true', 'uniq', 'wc', 'which',
] as const
const COMMON_PWSH_COMMANDS = [
  'add-content', 'clear-host', 'copy-item', 'export-csv', 'format-list', 'format-table',
  'foreach-object', 'get-childitem', 'get-command', 'get-content', 'get-date', 'get-filehash',
  'get-item', 'get-location', 'get-member', 'get-process', 'import-csv', 'join-path',
  'measure-object', 'move-item', 'new-item', 'out-file', 'remove-item', 'resolve-path',
  'select-object', 'select-string', 'set-content', 'set-location', 'sort-object', 'split-path',
  'test-path', 'where-object', 'write-error', 'write-host', 'write-output',
] as const
const PWSH_ALIASES: Readonly<Record<string, string>> = {
  ac: 'add-content', cat: 'get-content', cd: 'set-location', cp: 'copy-item', dir: 'get-childitem',
  echo: 'write-output', erase: 'remove-item', foreach: 'foreach-object', ft: 'format-table',
  gc: 'get-content', gci: 'get-childitem', gl: 'get-location', gm: 'get-member', ls: 'get-childitem',
  measure: 'measure-object', mi: 'move-item', mv: 'move-item', ni: 'new-item',
  pwd: 'get-location', rm: 'remove-item', rmdir: 'remove-item', sc: 'set-content', select: 'select-object',
  sls: 'select-string', sort: 'sort-object', type: 'get-content', where: 'where-object',
}
const PWSH_PATH_READ_COMMANDS = new Set([
  'get-childitem', 'get-content', 'get-filehash', 'get-item', 'import-csv', 'resolve-path',
  'select-string', 'test-path',
])
const PWSH_PATH_WRITE_COMMANDS = new Set([
  'add-content', 'export-csv', 'move-item', 'new-item', 'out-file', 'remove-item', 'set-content',
])
const DANGEROUS_BASH_COMMANDS = new Set([
  'chmod', 'chown', 'dd', 'kill', 'mkfs', 'mount', 'reboot', 'rmdir', 'shutdown', 'sudo', 'su',
  'umount', 'unlink',
])

function shellSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|&\n])/u).map(part => part.trim()).filter(Boolean)
}

/** Remove here-document bodies before inspecting shell command heads. */
function stripHereDocBodies(command: string): string {
  const lines = command.split(/\r?\n/u)
  const output: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index++] ?? ''
    output.push(line)
    const documents = [...line.matchAll(/<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|([^\s;|&]+))/gu)]
    for (const match of documents) {
      const stripTabs = match[1] === '-'
      const delimiter = match[2] ?? match[3] ?? match[4]
      if (delimiter === undefined) continue
      while (index < lines.length) {
        const bodyLine = lines[index++] ?? ''
        const terminator = stripTabs ? bodyLine.replace(/^\t+/u, '') : bodyLine
        if (terminator === delimiter) break
      }
    }
  }
  return output.join('\n')
}

/** Return simple command heads for the ordinary shell separators used by tool calls. */
function commandHeads(command: string): string[] {
  return shellSegments(command)
    .map(part => part.replace(/^(?:\([^)]*\)\s*)+/u, ''))
    .map(part => part.match(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*([A-Za-z0-9_.-]+)/u)?.[1]?.toLowerCase())
    .filter((head): head is string => head !== undefined)
}

function commandWords(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(Boolean)
}

function fileOperands(head: string, words: readonly string[]): string[] {
  const args = [...words]
  while (args[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=\S*$/u.test(args[0])) args.shift()
  if (args[0] === head) args.shift()
  const positional: string[] = []
  const optionFiles: string[] = []
  let skipNext = false
  let fileOption = false
  let explicitPattern = false
  let rgFilesMode = false
  for (const arg of args) {
    if (skipNext) {
      if (fileOption) optionFiles.push(arg)
      fileOption = false
      skipNext = false
      continue
    }
    if (arg === '--') continue
    if (head === 'head' || head === 'tail') {
      if (['-n', '--lines', '-c', '--bytes'].includes(arg)) {
        skipNext = true
        continue
      }
    }
    if (head === 'stat' && ['-c', '--format', '-f', '--file-system'].includes(arg)) {
      skipNext = true
      continue
    }
    if (head === 'file' && ['-m', '--magic-file'].includes(arg)) {
      skipNext = true
      continue
    }
    if (['cp', 'mv'].includes(head) && ['-t', '--target-directory'].includes(arg)) {
      skipNext = true
      continue
    }
    if (['cp', 'mv'].includes(head) && arg.startsWith('--target-directory=')) continue
    if (head === 'cp' && ['-S', '--suffix'].includes(arg)) {
      skipNext = true
      continue
    }
    if (head === 'cp' && arg.startsWith('--suffix=')) continue
    if (['grep', 'rg'].includes(head)) {
      if (['-e', '--regexp'].includes(arg)) {
        explicitPattern = true
        skipNext = true
        continue
      }
      if (['-f', '--file'].includes(arg)) {
        skipNext = true
        fileOption = true
        continue
      }
      if (['-g', '--glob', '-t', '--type', '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context'].includes(arg)) {
        skipNext = true
        continue
      }
      if (arg.startsWith('-e') && arg.length > 2 || arg.startsWith('--regexp=')) {
        explicitPattern = true
        continue
      }
      if (head === 'rg' && arg === '--files') {
        rgFilesMode = true
        continue
      }
      if (arg.startsWith('-f') && arg.length > 2 || arg.startsWith('--file=')) {
        optionFiles.push(arg.startsWith('--file=') ? arg.slice('--file='.length) : arg.slice(2))
        continue
      }
      if (arg.startsWith('-g') && arg.length > 2 || arg.startsWith('--glob=')) continue
      if (arg.startsWith('--')) continue
    }
    if (head === 'du' && ['-d', '--max-depth', '--threshold'].includes(arg)) {
      skipNext = true
      continue
    }
    if (head === 'du' && (arg.startsWith('--max-depth=') || arg.startsWith('--threshold='))) continue
    if (head === 'mkdir' && ['-m', '--mode', '-Z', '--context'].includes(arg)) {
      skipNext = true
      continue
    }
    if (head === 'touch' && ['-d', '--date', '-t', '--time', '-r', '--reference'].includes(arg)) {
      skipNext = true
      continue
    }
    if (arg.startsWith('-')) continue
    positional.push(arg)
  }
  if (head === 'cp' || head === 'mv') {
    const targetDirectory = args.findIndex(arg => arg === '-t' || arg === '--target-directory')
    const sources = targetDirectory >= 0 ? positional : positional.slice(0, -1)
    return [...sources.filter(path => path !== '-'), ...optionFiles]
  }
  if (head === 'find') {
    const first = args[0]
    return [first === undefined || first.startsWith('-') || first === '!' ? '.' : first]
  }
  if (head === 'mineru-open-api' && args[0] === 'extract') {
    return args[1] === undefined || args[1].startsWith('-') ? [] : [args[1]]
  }
  if (['pdfinfo', 'pdftotext', 'pdftoppm'].includes(head)) {
    const input = args.find(arg => !arg.startsWith('-'))
    return input === undefined ? [] : [input]
  }
  if (head === 'mineru-open-api' && args[0] === 'extract') {
    return args[1] === undefined || args[1].startsWith('-') ? [] : [args[1]]
  }
  if (['pdfinfo', 'pdftotext', 'pdftoppm'].includes(head)) {
    const input = args.find(arg => !arg.startsWith('-'))
    return input === undefined ? [] : [input]
  }
  if (['ls', 'du'].includes(head)) return positional.length > 0 ? positional : ['.']
  if (['mkdir', 'touch'].includes(head)) return positional
  if (['grep', 'rg'].includes(head)) {
    if (rgFilesMode) return positional.length > 0 ? [...positional, ...optionFiles] : ['.']
    const files = explicitPattern ? positional : positional.slice(1)
    return [...(files.length === 0 ? (head === 'rg' ? ['.'] : []) : files), ...optionFiles]
  }
  if (['cat', 'head', 'tail', 'file', 'stat', 'wc'].includes(head)) return positional.filter(path => path !== '-')
  return []
}

function redirectionPaths(words: readonly string[]): { reads: string[]; writes: string[] } {
  const reads: string[] = []
  const writes: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (word.startsWith('<<')) continue
    if (word === '>' || word === '>>' || word === '>|' || word === '2>' || word === '2>>' || word === '&>' || word === '&>>') {
      const target = words[index + 1]
      if (target !== undefined && target !== '&1' && target !== '&2') writes.push(target)
      index += 1
      continue
    }
    if (word === '<' || word === '0<') {
      const target = words[index + 1]
      if (target !== undefined) reads.push(target)
      index += 1
      continue
    }
    const attached = /^(?:([0-9]?)(>>?|>\||<)|(&>>|&>))(.+)$/u.exec(word)
    if (attached === null) continue
    const op = attached[2] ?? attached[3]
    const target = attached[4]
    if (target === undefined || target === '&1' || target === '&2') continue
    if (op === '<') reads.push(target)
    else writes.push(target)
  }
  return { reads, writes }
}

function writeOperands(head: string, words: readonly string[]): { sources: string[]; target?: string } {
  const args = [...words]
  if (args[0] === head) args.shift()
  const positional: string[] = []
  let targetDirectory: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (['cp', 'mv'].includes(head) && (arg === '-t' || arg === '--target-directory')) {
      targetDirectory = args[index + 1]
      index += 1
      continue
    }
    if (['cp', 'mv'].includes(head) && arg.startsWith('--target-directory=')) {
      targetDirectory = arg.slice('--target-directory='.length)
      continue
    }
    if (head === 'cp' && ['-S', '--suffix'].includes(arg)) {
      index += 1
      continue
    }
    if (arg === '--' || arg.startsWith('-')) continue
    positional.push(arg)
  }
  if (targetDirectory !== undefined) return { sources: positional, target: targetDirectory }
  const target = positional.at(-1)
  return { sources: positional.slice(0, -1), ...(target === undefined ? {} : { target }) }
}

function compilerOperands(head: string, words: readonly string[]): { input?: string; output?: string } {
  const args = [...words]
  if (args[0] === head) args.shift()
  if (head === 'typst') {
    if (args[0] !== 'compile') return {}
    const positional = args.slice(1).filter(arg => !arg.startsWith('-'))
    return {
      ...(positional[0] === undefined ? {} : { input: positional[0] }),
      ...(positional[1] === undefined ? {} : { output: positional[1] }),
    }
  }
  const input = args.find(arg => !arg.startsWith('-'))
  if (input === undefined) return {}
  const pdf = input.replace(/\.[^./\\]+$/u, '.pdf')
  return { input, output: pdf }
}

/** Split PowerShell's simple top-level command separators while honoring quotes. */
function powerShellSegments(command: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote: 'single' | 'double' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === 'double' && char === '`') {
      index += 1
      continue
    }
    if (quote === 'single' && char === "'" && command[index + 1] === "'") {
      index += 1
      continue
    }
    if (char === "'" && quote !== 'double') quote = quote === 'single' ? undefined : 'single'
    else if (char === '"' && quote !== 'single') quote = quote === 'double' ? undefined : 'double'
    if (quote !== undefined) continue
    const pair = command.slice(index, index + 2)
    if (char === ';' || char === '|' || char === '\n' || pair === '&&' || pair === '||') {
      const segment = command.slice(start, index).trim()
      if (segment.length > 0) segments.push(segment)
      if (pair === '&&' || pair === '||') index += 1
      start = index + 1
    }
  }
  const final = command.slice(start).trim()
  if (final.length > 0) segments.push(final)
  return segments
}

/** Tokenize simple PowerShell command text for a role preflight. */
function powerShellWords(segment: string): string[] {
  return [...segment.matchAll(/"(?:`.|[^"`])*"|'(?:''|[^'])*'|[^\s]+/gu)]
    .map(match => {
      const token = match[0] ?? ''
      if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1).replaceAll('`"', '"')
      if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
      return token
    })
}

function normalizePowerShellHead(value: string): string | undefined {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase()
  if (leaf === undefined || leaf.length === 0 || leaf.startsWith('$') || leaf.startsWith('[')) return undefined
  if (/[\\/]/u.test(value) || /^[a-z]:/iu.test(value)) return undefined
  const withoutExtension = leaf.replace(/\.(?:exe|cmd|bat|com)$/iu, '')
  return PWSH_ALIASES[withoutExtension] ?? withoutExtension
}

interface PowerShellCommand {
  readonly head: string
  readonly words: readonly string[]
}

function parsePowerShellCommand(segment: string): PowerShellCommand | undefined {
  const words = powerShellWords(segment)
  let index = 0
  if (words[index] === '&') index += 1
  // Reject script blocks, assignments, and other constructs whose invoked
  // commands cannot be checked by this deliberately shallow preflight.
  const rawHead = words[index]
  if (rawHead === undefined || rawHead === '{' || rawHead === '(' || rawHead.includes('=')) return undefined
  const head = normalizePowerShellHead(rawHead)
  if (head === undefined) return undefined
  return { head, words: [head, ...words.slice(index + 1)] }
}

function supportedPowerShellCommands(role: AutoReportRole): Set<string> {
  return new Set([...COMMON_PWSH_COMMANDS, ...rolePolicy(role).processCommands.map(command => command.toLowerCase())])
}

function powerShellHelp(resolved: ResolvedRole): string {
  return `role-constrained PowerShell commands: ${[...supportedPowerShellCommands(resolved.role)].sort().join(', ')}; ${directoryHelp(resolved)}`
}

interface PowerShellOperands {
  readonly paths: readonly string[]
  readonly positional: readonly string[]
}

function powerShellOperands(
  words: readonly string[],
  pathParameters: readonly string[],
  valueParameters: readonly string[] = [],
): PowerShellOperands {
  const paths: string[] = []
  const positional: string[] = []
  const pathFlags = new Set(pathParameters.map(value => value.toLowerCase()))
  const valueFlags = new Set([...pathParameters, ...valueParameters].map(value => value.toLowerCase()))
  for (let index = 1; index < words.length; index += 1) {
    const value = words[index] ?? ''
    if (value === '>' || value === '>>' || /^\d+>>?$/u.test(value)) {
      const destination = words[index + 1]
      if (destination !== undefined && destination !== '&1' && destination !== '&2') paths.push(destination)
      index += 1
      continue
    }
    if (value.startsWith('-')) {
      const match = /^(-[^:=]+)(?::|=)(.*)$/u.exec(value)
      const flag = (match?.[1] ?? value).toLowerCase()
      const inline = match?.[2]
      if (pathFlags.has(flag) && inline !== undefined && inline.length > 0) paths.push(inline)
      else if (valueFlags.has(flag) && inline === undefined) {
        const parameterValue = words[index + 1]
        if (parameterValue !== undefined) {
          if (pathFlags.has(flag)) paths.push(parameterValue)
          index += 1
        }
      }
      continue
    }
    if (value === '&') continue
    positional.push(value)
  }
  return { paths, positional }
}

function powerShellPathDenial(command: string, resolved: ResolvedRole, workdir: string): string | undefined {
  let cwd = canonicalPath(workdir)
  for (const segment of powerShellSegments(command)) {
    const parsed = parsePowerShellCommand(segment)
    if (parsed === undefined) {
      return `AutoReport ${resolved.role} cannot preflight this PowerShell expression; use a simple allowlisted command; ${powerShellHelp(resolved)}`
    }
    const { head, words } = parsed
    if (head === 'set-location') {
      const paths = powerShellOperands(words, ['-Path', '-LiteralPath']).paths
      const directory = paths[0] ?? powerShellOperands(words, [], ['-PassThru']).positional[0]
      if (directory !== undefined) {
        const denial = readableTargetDenial(directory, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot Set-Location to ${directory}: ${denial}`
        cwd = canonicalPath(isAbsolute(directory) ? directory : resolve(cwd, directory))
      }
      continue
    }

    if (PWSH_PATH_READ_COMMANDS.has(head) && head !== 'select-string') {
      const operands = powerShellOperands(words, ['-Path', '-LiteralPath'], [
        '-Encoding', '-ReadCount', '-TotalCount', '-Tail', '-Stream', '-Filter', '-Include', '-Exclude', '-Depth', '-Delimiter', '-Header',
      ])
      const targets = operands.paths.length > 0 ? operands.paths : operands.positional.slice(0, 1)
      for (const target of targets) {
        const denial = readableTargetDenial(target, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot read ${target} with ${head}: ${denial}`
      }
    }
    if (head === 'select-string') {
      const operands = powerShellOperands(words, ['-Path', '-LiteralPath'], ['-Pattern', '-Context', '-Encoding'])
      for (const target of operands.paths) {
        const denial = readableTargetDenial(target, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot read ${target} with Select-String: ${denial}`
      }
    }
    if (head === 'copy-item' || head === 'move-item') {
      const sources = powerShellOperands(words, ['-Path', '-LiteralPath'], ['-Filter', '-Include', '-Exclude'])
      const destinations = powerShellOperands(words, ['-Destination', '-Target'])
      const sourceTargets = sources.paths.length > 0 ? sources.paths : sources.positional.slice(0, -1)
      const destination = destinations.paths.at(-1) ?? sources.positional.at(-1)
      for (const target of sourceTargets) {
        const denial = readableTargetDenial(target, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot read ${target} with ${head}: ${denial}`
        if (head === 'move-item') {
          const writeDenial = bashWriteTargetDenial(target, resolved, cwd)
          if (writeDenial !== undefined) return `AutoReport ${resolved.role} cannot move ${target}: ${writeDenial}`
        }
      }
      if (destination !== undefined) {
        const denial = bashWriteTargetDenial(destination, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write ${destination} with ${head}: ${denial}`
      }
    }
    if (PWSH_PATH_WRITE_COMMANDS.has(head) && head !== 'copy-item' && head !== 'move-item') {
      const pathParameters = head === 'new-item'
        ? ['-Path', '-LiteralPath', '-FilePath', '-Name']
        : ['-Path', '-LiteralPath', '-FilePath']
      const operands = powerShellOperands(words, pathParameters, [
        '-ItemType', '-Value', '-Encoding', '-Delimiter', '-NoTypeInformation', '-Force', '-Recurse', '-Confirm',
      ])
      const targets = operands.paths.length > 0 ? operands.paths : operands.positional.slice(0, 1)
      for (const target of targets) {
        const denial = bashWriteTargetDenial(target, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write ${target} with ${head}: ${denial}`
      }
    }

    if (['python', 'python3', 'node', 'gnuplot', 'pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic', 'typst', 'pdfinfo', 'pdftotext', 'pdftoppm', 'qpdf', 'uv'].includes(head)) {
      const compile = ['latexmk', 'tectonic', 'xelatex', 'pdflatex', 'lualatex'].includes(head)
        || (head === 'typst' && words[1]?.toLowerCase() === 'compile')
      if (compile) {
        const targets = compilerOperands(head, words)
        if (targets.input !== undefined) {
          const denial = readableTargetDenial(targets.input, resolved, cwd)
          if (denial !== undefined) return `AutoReport ${resolved.role} cannot compile unreadable input ${targets.input}: ${denial}`
        }
        if (targets.output !== undefined) {
          const denial = bashWriteTargetDenial(targets.output, resolved, cwd)
          if (denial !== undefined) return `AutoReport ${resolved.role} cannot write compiler output ${targets.output}: ${denial}`
        }
        const cwdDenial = bashWriteTargetDenial('.', resolved, cwd)
        if (cwdDenial !== undefined) return `AutoReport ${resolved.role} cannot compile in this directory: ${cwdDenial}`
      } else {
        const uvRun = head === 'uv' && words[1]?.toLowerCase() === 'run'
        const nativeHead = uvRun ? normalizePowerShellHead(words[2] ?? '') ?? 'uv' : head
        const nativeWords = uvRun ? [nativeHead, ...words.slice(3)] : words
        const scriptWords = nativeWords.slice(1)
        const scriptIndex = scriptWords.findIndex((value, index) => {
          const lower = value.toLowerCase()
          if (['-c', '-m', '-x', '-w', '-e'].includes(lower)) return false
          return !value.startsWith('-') && (index === 0 || !['-c', '-m', '-x', '-w', '-e'].includes((scriptWords[index - 1] ?? '').toLowerCase()))
        })
        const script = scriptIndex < 0 ? undefined : scriptWords[scriptIndex]
        if (script !== undefined && /\.(?:py|pyw|js|mjs|cjs|plt|gp)$/iu.test(script)) {
          const denial = readableTargetDenial(script, resolved, cwd)
          if (denial !== undefined) return `AutoReport ${resolved.role} cannot execute unreadable input ${script}: ${denial}`
        }
        if (['pdftotext', 'pdfinfo', 'pdftoppm'].includes(nativeHead)) {
          const positional = scriptWords.filter(value => !value.startsWith('-'))
          const input = positional[0]
          if (input !== undefined) {
            const denial = readableTargetDenial(input, resolved, cwd)
            if (denial !== undefined) return `AutoReport ${resolved.role} cannot read ${input} with ${nativeHead}: ${denial}`
          }
        }
        if (nativeHead === 'pdftotext' || nativeHead === 'pdftoppm') {
          const positional = scriptWords.filter(value => !value.startsWith('-'))
          const output = positional[1]
          if (output !== undefined && output !== '-') {
            const denial = bashWriteTargetDenial(output, resolved, cwd)
            if (denial !== undefined) return `AutoReport ${resolved.role} cannot write extracted text ${output}: ${denial}`
          }
        }
      }
    }
    const redirects = powerShellOperands(words, [], [])
    for (const target of redirects.paths) {
      const denial = bashWriteTargetDenial(target, resolved, cwd)
      if (denial !== undefined) return `AutoReport ${resolved.role} cannot write ${target} through PowerShell redirection: ${denial}`
    }
  }
  return undefined
}

function pwshPolicyDenial(command: string, resolved: ResolvedRole, workdir: string): string | undefined {
  if (resolved.policy.process !== 'role-aware') {
    return `AutoReport ${resolved.role} has no general process execution capability; ${directoryHelp(resolved)}`
  }
  const supported = supportedPowerShellCommands(resolved.role)
  const commands = powerShellSegments(command).map(parsePowerShellCommand)
  if (commands.length === 0 || commands.some(item => item === undefined)) {
    return `unsupported or complex PowerShell expression; ${powerShellHelp(resolved)}`
  }
  const unsupported = commands.find(item => item !== undefined && !supported.has(item.head))
  if (unsupported !== undefined) {
    return `unsupported PowerShell command "${unsupported.head}" for AutoReport ${resolved.role}; ${powerShellHelp(resolved)}`
  }
  const envMutation = commands.some(item => {
    if (item === undefined) return false
    const words = item.words.map(value => value.toLowerCase())
    return item.head === 'uv'
      ? words[1] === 'venv' || (words[1] === 'pip' && ['install', 'uninstall', 'sync'].includes(words[2] ?? ''))
      : ['python', 'python3'].includes(item.head) && words[1] === '-m' && words[2] === 'pip'
        && ['install', 'uninstall'].includes(words[3] ?? '')
  })
  if (envMutation) return 'AutoReport specialists cannot mutate Python packages or environments; report missing_dependency to MAIN'
  return powerShellPathDenial(command, resolved, workdir)
}

function bashPathDenial(command: string, resolved: ResolvedRole, workdir: string): string | undefined {
  let cwd = canonicalPath(workdir)
  for (const segment of shellSegments(command)) {
    const words = commandWords(segment)
    const head = commandHeads(segment)[0]
    if (head === undefined) continue
    if (head === 'cd') {
      const directory = words[1]
      if (directory !== undefined) {
        const denial = readableTargetDenial(directory, resolved, cwd)
        if (denial !== undefined) {
          return `AutoReport ${resolved.role} cannot cd to ${directory}: ${denial}`
        }
        cwd = canonicalPath(isAbsolute(directory) ? directory : resolve(cwd, directory))
      }
      continue
    }
    for (const operand of fileOperands(head, words)) {
      const denial = readableTargetDenial(operand, resolved, cwd)
      if (denial !== undefined) {
        return `AutoReport ${resolved.role} cannot read ${operand} with ${head}: ${denial}`
      }
    }
    const redirects = redirectionPaths(words)
    for (const operand of redirects.reads) {
      const denial = readableTargetDenial(operand, resolved, cwd)
      if (denial !== undefined) return `AutoReport ${resolved.role} cannot read ${operand} through shell input redirection: ${denial}`
    }
    for (const target of redirects.writes) {
      const denial = bashWriteTargetDenial(target, resolved, cwd)
      if (denial !== undefined) return `AutoReport ${resolved.role} cannot write ${target} through shell redirection: ${denial}`
    }
    if (head === 'mineru-open-api' && words[1] === 'extract') {
      const outputIndex = words.findIndex(word => word === '-o' || word === '--output')
      const output = outputIndex < 0 ? undefined : words[outputIndex + 1]
      if (output !== undefined) {
        const denial = bashWriteTargetDenial(output, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write extraction output ${output}: ${denial}`
      }
    }
    if (head === 'mineru-open-api' && words[1] === 'extract') {
      const outputIndex = words.findIndex(word => word === '-o' || word === '--output')
      const output = outputIndex < 0 ? undefined : words[outputIndex + 1]
      if (output !== undefined) {
        const denial = bashWriteTargetDenial(output, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write extraction output ${output}: ${denial}`
      }
    }
    if (head === 'pdftotext') {
      const output = words.slice(1).filter(word => !word.startsWith('-'))[1]
      if (output !== undefined && output !== '-') {
        const denial = bashWriteTargetDenial(output, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write extracted text ${output}: ${denial}`
      }
    }
    if (head === 'mkdir' || head === 'touch') {
      for (const target of fileOperands(head, words)) {
        const denial = bashWriteTargetDenial(target, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write ${target} with ${head}: ${denial}`
      }
    }
    if (['latexmk', 'tectonic', 'xelatex', 'pdflatex', 'lualatex'].includes(head)
      || (head === 'typst' && words[1] === 'compile')) {
      const compile = compilerOperands(head, words)
      if (compile.input !== undefined) {
        const denial = readableTargetDenial(compile.input, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot compile unreadable input ${compile.input}: ${denial}`
      }
      const cwdWriteDenial = bashWriteTargetDenial('.', resolved, cwd)
      if (cwdWriteDenial !== undefined) return `AutoReport ${resolved.role} cannot compile in this directory: ${cwdWriteDenial}`
      if (compile.output !== undefined) {
        const denial = bashWriteTargetDenial(compile.output, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write compiler output ${compile.output}: ${denial}`
      }
    }
    if (head === 'cp' || head === 'mv') {
      const transfer = writeOperands(head, words)
      if (head === 'mv') {
        for (const source of transfer.sources) {
          const denial = bashWriteTargetDenial(source, resolved, cwd)
          if (denial !== undefined) return `AutoReport ${resolved.role} cannot move source ${source}: ${denial}`
        }
      }
      if (transfer.target !== undefined) {
        const denial = bashWriteTargetDenial(transfer.target, resolved, cwd)
        if (denial !== undefined) return `AutoReport ${resolved.role} cannot write ${transfer.target} with ${head}: ${denial}`
      }
    }
  }
  return undefined
}

function rmPolicyDenial(command: string, resolved: ResolvedRole, workdir: string | undefined): string | undefined {
  let cwd = canonicalPath(workdir ?? resolved.workspaceRoot)
  for (const segment of shellSegments(command)) {
    const rm = /^rm\s+(.+)$/u.exec(segment)
    if (rm !== null) {
      const rawArgs = rm[1]?.trim().split(/\s+/u) ?? []
      const args = rawArgs.filter(arg => !arg.startsWith('-'))
      if (rawArgs.some(arg => /^-[^-]*[rR]|^--recursive$/u.test(arg))) {
        return `recursive rm is blocked for AutoReport ${resolved.role}; ${bashHelp(resolved)}`
      }
      if (args.length === 0 || args.some(arg => isAbsolute(arg) || arg.split(/[\\/]/u).includes('..'))) {
        return `rm requires explicit files inside this role's writable directories; ${bashHelp(resolved)}`
      }
      const permitted = args.every(arg => {
        const target = canonicalPath(resolve(cwd, arg))
        return resolved.policy.writableRoots.some(root =>
          contained(canonicalPath(resolve(resolved.workspaceRoot, root)), target))
      })
      if (!permitted) return `rm may remove files only inside this role's writable directories; ${bashHelp(resolved)}`
    }
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))$/u.exec(segment)
    const directory = cd?.[1] ?? cd?.[2] ?? cd?.[3]
    if (directory !== undefined) cwd = canonicalPath(resolve(cwd, directory))
  }
  return undefined
}

function packageMutationDenial(command: string, role: AutoReportRole): string | undefined {
  for (const segment of shellSegments(stripHereDocBodies(command))) {
    const words = commandWords(segment).map(word => word.toLowerCase())
    const headIndex = words.findIndex(word => /^[a-z0-9_.-]+$/u.test(word))
    const head = words[headIndex]
    const tail = headIndex < 0 ? [] : words.slice(headIndex + 1)
    const mutatesEnvironment = head === 'uv'
      ? (tail[0] === 'venv' || (tail[0] === 'pip' && ['install', 'sync', 'uninstall'].includes(tail[1] ?? ''))
        || (tail[0] === 'tool' && tail[1] === 'install'))
      : (head === 'python' || head === 'python3') && tail[0] === '-m' && tail[1] === 'pip'
        && ['install', 'uninstall'].includes(tail[2] ?? '')
    if (mutatesEnvironment) {
      return `AutoReport ${role} cannot mutate Python packages or environments from Bash; request the dedicated MAIN environment capability`
    }
  }
  return undefined
}

function bashPolicyDenial(command: string, resolved: ResolvedRole, workdir: string): string | undefined {
  if (resolved.policy.process !== 'role-aware') {
    return `AutoReport ${resolved.role} has no general process execution capability; ${directoryHelp(resolved)}`
  }
  const shell = stripHereDocBodies(command)
  const supported = supportedBashCommands(resolved.role)
  const heads = commandHeads(shell)
  if (heads.length === 0) return `unsupported empty or compound command; ${bashHelp(resolved)}`
  const dangerous = heads.find(head => DANGEROUS_BASH_COMMANDS.has(head))
  if (dangerous !== undefined) {
    return `dangerous command "${dangerous}" is blocked for AutoReport ${resolved.role}; ${bashHelp(resolved)}`
  }
  const environmentDenial = packageMutationDenial(shell, resolved.role)
  if (environmentDenial !== undefined) return environmentDenial
  const unsupported = heads.find(head => !supported.has(head))
  if (unsupported !== undefined) {
    return `unsupported command "${unsupported}" for AutoReport ${resolved.role}; ${bashHelp(resolved)}`
  }
  const pathDenial = bashPathDenial(shell, resolved, workdir)
  if (pathDenial !== undefined) return pathDenial
  const rmDenial = rmPolicyDenial(shell, resolved, workdir)
  if (rmDenial !== undefined) return rmDenial
  // This command check is defense in depth. The role-aware executor applies
  // the operating-system filesystem view to this command and its descendants.
  return undefined
}

function supportedBashCommands(role: AutoReportRole): Set<string> {
  const common = role === 'MAIN' ? [] : COMMON_BASH_COMMANDS
  return new Set([...common, ...rolePolicy(role).processCommands])
}

function bashHelp(resolved: ResolvedRole): string {
  const commands = [...supportedBashCommands(resolved.role)].sort()
  return `role-aware bash commands: ${commands.join(', ')}; ${directoryHelp(resolved)}`
}

/** Create the parent for an authorized file mutation, without repairing the workspace. */
function prepareMutationParent(
  exec: Readonly<ToolExecution>,
  target: string,
  resolved: ResolvedRole,
): string | undefined {
  if (exec.name === 'delete' || exec.name === 'delete_file') return undefined
  const absolute = isAbsolute(target)
    ? resolve(target)
    : resolve(resolved.relativeWriteRoot, target)
  try {
    mkdirSync(dirname(absolute), { recursive: true })
    return undefined
  } catch (error: unknown) {
    const writable = resolved.policy.writableRoots.join(', ')
    const detail = error instanceof Error ? error.message : String(error)
    return 'AutoReport ' + resolved.role
      + ' could not create its writable directory (' + writable + ') for ' + target
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
    const protectedCall = call.kind !== 'none' || read.kind !== 'none' || sandboxPermissionsEscalation(exec)
      || shellCall || exec.name === 'glob' || exec.name === 'grep'
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
    if (exec.name === 'glob') {
      return `AutoReport disables process-backed glob; use list for names or the role-scoped grep tool for file contents; ${directoryHelp(resolved)}`
    }
    if (exec.name === 'pwsh') {
      return 'AutoReport PowerShell process execution is disabled until a role-aware Windows filesystem backend is available'
    }
    if (exec.name === 'bash' && process.platform === 'win32') {
      return 'AutoReport process execution is unavailable on Windows until a role-aware filesystem backend is available'
    }
    if (sandboxPermissionsEscalation(exec)) {
      return 'AutoReport denies generic sandbox escalation; use the dedicated MAIN environment capability for package changes'
    }
    if (exec.name === 'bash' && resolved.policy.process !== 'role-aware') {
      return `AutoReport ${resolved.role} has no general process execution capability; use its dedicated tools and assigned specialists`
    }
    if (!resolved.policy.tools.includes(exec.name)) {
      return `AutoReport ${resolved.role} has no declared capability for ${exec.name}; use its role-scoped tools`
    }
    if (shellCall) {
      const expectedShell = process.platform === 'win32' ? 'pwsh' : 'bash'
      if (exec.name !== expectedShell) {
        if (exec.name === 'pwsh') return 'AutoReport PowerShell process execution is disabled on this platform; use the role Bash tool'
        return `AutoReport ${exec.name} is unavailable on ${process.platform}; use the platform role shell ${expectedShell}`
      }
      if (resolved.policy.process !== 'role-aware') {
        return `AutoReport ${resolved.role} has no general process execution capability; use its dedicated tools and assigned specialists`
      }
      const shellName = expectedShell
      const args = record(exec.arguments)
      const command = args === undefined ? undefined : stringField(args, 'command')
      if (command === undefined) {
        const help = shellName === 'bash' ? bashHelp(resolved) : powerShellHelp(resolved)
        return `unsupported ${shellName} call: command string is required; ${help}`
      }
      const workdirArg = args === undefined ? undefined : stringField(args, 'workdir')
      const workdir = workdirArg === undefined
        ? resolved.relativeWriteRoot
        : canonicalPath(isAbsolute(workdirArg) ? workdirArg : resolve(resolved.relativeWriteRoot, workdirArg))
      if (workdirArg !== undefined) {
        const workdirDenial = readableTargetDenial(workdirArg, resolved, resolved.relativeWriteRoot)
        if (workdirDenial !== undefined) {
          return `AutoReport ${resolved.role} cannot use ${shellName} workdir ${workdirArg}: ${workdirDenial}`
        }
      }
      const denial = shellName === 'bash'
        ? bashPolicyDenial(command, resolved, workdir)
        : pwshPolicyDenial(command, resolved, workdir)
      if (denial !== undefined) return denial
    }
    if (!protectedCall) return undefined
    if (call.kind === 'malformed') return `AutoReport denied ${exec.name}: ${call.reason}`
    if (read.kind === 'malformed') return `AutoReport denied ${exec.name}: ${read.reason}; ${directoryHelp(resolved)}`
    if (read.kind === 'path') {
      const denial = readableTargetDenial(read.path, resolved)
      if (denial !== undefined) return `AutoReport denied ${exec.name} read: ${denial}`
    }
    if (read.kind === 'discover') {
      const denial = discoverableTargetDenial(read.path, resolved)
      if (denial !== undefined) return `AutoReport denied ${exec.name} discovery: ${denial}`
    }
    if (read.kind === 'search') {
      const denial = grepTargetDenial(read.path, resolved)
      if (denial !== undefined) return `AutoReport denied ${exec.name} read: ${denial}`
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
