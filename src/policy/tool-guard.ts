/**
 * Synchronous AutoReport role guard over DSH's immutable ToolExecution.
 *
 * The guard is authorization, not visibility. Domain invariants DSH cannot
 * represent: role membership, sandbox_permissions escalation denial, and
 * defense-in-depth write-path checks against role writable roots. THEORY has
 * no shell execution capability, matching the original AutoReport role tools.
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
  /** Actual DSH base for relative mutations and bash workdir; defaults to the role root. */
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
    return path === undefined
      ? { kind: 'malformed', reason: 'str_replace_editor view requires path' }
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
    // A shallow root inventory is useful to orient MAIN and THEORY, without
    // exposing contents or permitting traversal into unrelated role folders.
    if ((path === '.' || path.replace(/[\\/]+$/u, '') === '.') && depth === 1) return { kind: 'none' }
    return { kind: 'path', path }
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
  const allowed = resolved.policy.writableRoots.some(root =>
    contained(canonicalPath(resolve(resolved.workspaceRoot, root)), absolute))
  return allowed
    ? undefined
    : `AutoReport ${resolved.role} may write only ${resolved.policy.writableRoots.join(', ')}: ${target}; ${directoryHelp(resolved)}`
}

function readableDirectories(resolved: ResolvedRole): string {
  return resolved.policy.readableRoots.map(root => root === '.' ? '.' : `${root}/`).join(', ')
}

function directoryHelp(resolved: ResolvedRole): string {
  const writable = resolved.policy.writableRoots.map(root => `${root}/`).join(', ')
  const skillRoots = resolved.readableResourceRoots.length === 0
    ? ''
    : `; registered skill resource roots: ${resolved.readableResourceRoots.join(', ')}`
  return `allowed read directories: ${readableDirectories(resolved)}${skillRoots}; allowed write directories: ${writable}`
}

function readableTargetDenial(target: string, resolved: ResolvedRole, base = resolved.workspaceRoot): string | undefined {
  if (hasUriScheme(target)) return `remote URI paths are not supported by the AutoReport workspace policy; ${directoryHelp(resolved)}`
  if (target.includes('\0')) return `path contains a NUL byte; ${directoryHelp(resolved)}`
  const absolute = canonicalPath(isAbsolute(target) ? target : resolve(base, target))
  if (resolved.readableResourceRoots.some(root => contained(root, absolute))) return undefined
  if (!contained(resolved.workspaceRoot, absolute)) return `path is outside the experiment workspace: ${target}; ${directoryHelp(resolved)}`
  const allowed = resolved.policy.readableRoots.some(root =>
    contained(canonicalPath(resolve(resolved.workspaceRoot, root)), absolute))
  return allowed
    ? undefined
    : `path is not readable by AutoReport ${resolved.role}; ${directoryHelp(resolved)}`
}

function bashWriteTargetDenial(target: string, resolved: ResolvedRole, cwd: string): string | undefined {
  if (hasUriScheme(target)) return `URI write paths are not supported by AutoReport: ${target}; ${directoryHelp(resolved)}`
  if (target.includes('\0')) return `write target contains a NUL byte; ${directoryHelp(resolved)}`
  if (target === '/dev/null' || target === 'NUL') return undefined
  const absolute = canonicalPath(isAbsolute(target) ? target : resolve(cwd, target))
  if (!contained(resolved.workspaceRoot, absolute)) {
    return `write target is outside the experiment workspace: ${target}; ${directoryHelp(resolved)}`
  }
  const allowed = resolved.policy.writableRoots.some(root =>
    contained(canonicalPath(resolve(resolved.workspaceRoot, root)), absolute))
  return allowed
    ? undefined
    : `write target is outside this role's writable directories: ${target}; ${directoryHelp(resolved)}`
}

const COMMON_BASH_COMMANDS = [
  'awk', 'basename', 'cat', 'cd', 'cp', 'cut', 'dirname', 'du', 'echo', 'false', 'file', 'find', 'grep', 'head',
  'ls', 'mkdir', 'mv', 'printf', 'pwd', 'rg', 'rm', 'sed', 'sort', 'stat', 'tail', 'touch', 'tr', 'true', 'uniq', 'wc', 'which',
] as const
const ROLE_BASH_COMMANDS: Readonly<Record<AutoReportRole, readonly string[]>> = {
  MAIN: ['jq', 'mdls', 'mineru-open-api', 'pdfinfo', 'pdftoppm', 'pdftotext', 'uv'],
  THEORY: [],
  DATA_ANALYSIS: ['node', 'pdfinfo', 'pdftotext', 'python', 'python3', 'uv'],
  PLOTTING: ['gnuplot', 'node', 'pdfinfo', 'python', 'python3', 'uv'],
  REPORT: ['latexmk', 'pandoc', 'pdfinfo', 'pdflatex', 'pdftoppm', 'pdftotext', 'python', 'python3', 'qpdf', 'tectonic', 'typst', 'uv', 'xelatex'],
}
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

function rmPolicyDenial(command: string, resolved: ResolvedRole, workdir?: string): string | undefined {
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

function bashPolicyDenial(command: string, resolved: ResolvedRole, workdir: string): string | undefined {
  const shell = stripHereDocBodies(command)
  const supported = supportedBashCommands(resolved.role)
  const heads = commandHeads(shell)
  if (heads.length === 0) return `unsupported empty or compound command; ${bashHelp(resolved)}`
  const dangerous = heads.find(head => DANGEROUS_BASH_COMMANDS.has(head))
  if (dangerous !== undefined) {
    return `dangerous command "${dangerous}" is blocked for AutoReport ${resolved.role}; ${bashHelp(resolved)}`
  }
  const unsupported = heads.find(head => !supported.has(head))
  if (unsupported !== undefined) {
    return `unsupported command "${unsupported}" for AutoReport ${resolved.role}; ${bashHelp(resolved)}`
  }
  const pathDenial = bashPathDenial(shell, resolved, workdir)
  if (pathDenial !== undefined) return pathDenial
  const rmDenial = rmPolicyDenial(shell, resolved, workdir)
  if (rmDenial !== undefined) return rmDenial
  // Textual command screening helps explain common refusals; it is not an OS
  // process boundary. In particular, an allowed interpreter can still read
  // arbitrary files until DSH carries readableRoots into its subprocess sandbox.
  return undefined
}

function supportedBashCommands(role: AutoReportRole): Set<string> {
  return new Set([...COMMON_BASH_COMMANDS, ...ROLE_BASH_COMMANDS[role]])
}

function bashHelp(resolved: ResolvedRole): string {
  return `advisory supported commands for this role: ${[...supportedBashCommands(resolved.role)].sort().join(', ')}; ${directoryHelp(resolved)}; this preflight is not an OS process read boundary`
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
 * MAIN may request sandbox escalation — the host approval flow prompts the
 * user, and an approved call is how MAIN installs packages into the selected
 * Python environment. Specialists keep the hard denial: they report
 * `missing_dependency` instead of acting on the environment.
 * @param options - registry and Main/workspace identity inputs.
 * @returns synchronous fail-closed DSH guard.
 */
export function createRoleToolGuard(options: RoleGuardOptions): ToolGuard {
  return exec => {
    const call = mutation(exec)
    const read = readTarget(exec)
    const protectedCall = call.kind !== 'none' || read.kind !== 'none' || sandboxPermissionsEscalation(exec) || exec.name === 'bash'
    const resolved = resolveRole(exec, options)
    // Not an AutoReport-owned session: preserve stock DSH policy untouched.
    if (resolved === FOREIGN) return undefined
    if (resolved === undefined) return protectedCall
      ? `AutoReport denied ${exec.name}: calling agent has no valid role binding`
      : undefined

    if (sandboxPermissionsEscalation(exec)) {
      if (resolved.role !== 'MAIN') {
        return 'AutoReport denies sandbox_permissions escalation for specialist roles; report missing dependencies to MAIN instead'
      }
      // MAIN passes through to DSH's approval flow: the user decides on the
      // prompt, and a denied request never executes. Write-path checks still
      // apply to the mutation targets of a non-escalated call below.
      if (call.kind === 'malformed') return `AutoReport denied ${exec.name}: ${call.reason}`
      return undefined
    }
    if (resolved.role === 'THEORY' && exec.name === 'bash') {
      return `unsupported command tool for AutoReport THEORY: no shell execution is assigned to this role; use read, read_image, list, write, or edit instead; ${directoryHelp(resolved)}; data reduction belongs to DATA_ANALYSIS`
    }
    if (exec.name === 'bash') {
      const args = record(exec.arguments)
      const command = args === undefined ? undefined : stringField(args, 'command')
      if (command === undefined) return `unsupported bash call: command string is required; ${bashHelp(resolved)}`
      const workdirArg = args === undefined ? undefined : stringField(args, 'workdir')
      const workdir = workdirArg === undefined
        ? resolved.relativeWriteRoot
        : canonicalPath(isAbsolute(workdirArg) ? workdirArg : resolve(resolved.relativeWriteRoot, workdirArg))
      if (workdirArg !== undefined) {
        const workdirDenial = readableTargetDenial(workdirArg, resolved, resolved.relativeWriteRoot)
        if (workdirDenial !== undefined) {
          return `AutoReport ${resolved.role} cannot use bash workdir ${workdirArg}: ${workdirDenial}`
        }
      }
      const denial = bashPolicyDenial(command, resolved, workdir)
      if (denial !== undefined) return denial
    }
    if (!protectedCall) return undefined
    if (call.kind === 'malformed') return `AutoReport denied ${exec.name}: ${call.reason}`
    if (read.kind === 'malformed') return `AutoReport denied ${exec.name}: ${read.reason}; ${directoryHelp(resolved)}`
    if (read.kind === 'path') {
      const denial = readableTargetDenial(read.path, resolved)
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
