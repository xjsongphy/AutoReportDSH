/** Role-scoped bounded literal search over DSH's filesystem provider. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeWorkspaceRelativePath, type DirectoryFileSystem } from './list-directory.js'

const MAX_DEPTH = 4
const MAX_ENTRIES = 512
const MAX_FILES = 128
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_MATCHES = 100
const MAX_LINE_CHARS = 16 * 1024
const MAX_PREVIEW_CHARS = 2_000
const HIDDEN_INTERNAL = new Set(['.autoreport', '.checkpoints', '.git'])

interface FsTargetLike {
  readonly displayPath: string
}

/** Filesystem capabilities needed for safe content search. */
export interface SearchFileSystem extends DirectoryFileSystem {
  stat(target: FsTargetLike, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  streamText(target: FsTargetLike, signal?: AbortSignal): Promise<AsyncIterable<string>>
}

export interface GrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface GrepOutput {
  readonly pattern: string
  readonly matches: readonly GrepMatch[]
  readonly files_scanned: number
  readonly bytes_scanned: number
  readonly skipped_files: number
  readonly truncated: boolean
}

interface SearchState {
  readonly matches: GrepMatch[]
  bytesScanned: number
  filesScanned: number
  skippedFiles: number
  truncated: boolean
  stop: boolean
}

function normalizeInclude(glob: string | undefined): RegExp | undefined {
  if (glob === undefined) return undefined
  if (glob.trim().length === 0 || glob.length > 256 || glob.startsWith('!')) {
    throw new Error('include must be one positive glob of 1–256 characters')
  }
  const parts = glob.replaceAll('\\', '/').split('/')
  if (parts.some(part => part === '..')) throw new Error('include cannot traverse outside the workspace')
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? ''
    if (char === '*' && glob[i + 1] === '*') {
      i += 1
      if (glob[i + 1] === '/') {
        i += 1
        source += '(?:.*/)?'
      } else source += '.*'
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += '.|{}()[]^$+\\'.includes(char) ? '\\' + char : char
  }
  const anchored = glob.includes('/') ? '^' + source + '$' : '(?:^|/)' + source + '$'
  return new RegExp(anchored, 'iu')
}

function insideAny(fs: SearchFileSystem, roots: readonly FsTargetLike[], target: FsTargetLike): boolean {
  return roots.some(root => fs.contains(root, target))
}

function canTraverse(fs: SearchFileSystem, roots: readonly FsTargetLike[], directory: FsTargetLike): boolean {
  return roots.some(root => fs.contains(root, directory) || fs.contains(directory, root))
}

async function resolveWithoutSymlinks(
  fs: SearchFileSystem,
  workspace: FsTargetLike,
  logicalPath: string,
  signal: AbortSignal,
): Promise<FsTargetLike> {
  let current = workspace
  for (const part of logicalPath === '.' ? [] : logicalPath.split('/')) {
    const entry = await fs.lstat(part, { cwd: current.displayPath }, signal)
    if (entry?.type === 'symlink') throw new Error('grep does not follow symbolic links')
    const next = await fs.resolve(part, { cwd: current.displayPath, signal })
    if (!fs.contains(workspace, next)) throw new Error('grep path is outside the experiment workspace')
    current = next
  }
  return current
}

function isMatch(line: string, pattern: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? line.includes(pattern)
    : line.toLocaleLowerCase().includes(pattern.toLocaleLowerCase())
}

function makeLineConsumer(
  path: string,
  pattern: string,
  caseSensitive: boolean,
  state: SearchState,
): (chunk: string, final?: boolean) => void {
  let pending = ''
  let lineNumber = 1
  let discardingLongLine = false
  const recordLine = (line: string): void => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    if (isMatch(clean, pattern, caseSensitive)) {
      state.matches.push({
        path,
        line: lineNumber,
        text: clean.length > MAX_PREVIEW_CHARS ? clean.slice(0, MAX_PREVIEW_CHARS) + '…' : clean,
      })
      if (state.matches.length >= MAX_MATCHES) {
        state.truncated = true
        state.stop = true
      }
    }
    lineNumber += 1
  }

  return (chunk, final = false): void => {
    let start = 0
    while (start < chunk.length && !state.stop) {
      const newline = chunk.indexOf('\n', start)
      const end = newline < 0 ? chunk.length : newline
      const segment = chunk.slice(start, end)
      if (discardingLongLine) {
        if (newline < 0) return
        discardingLongLine = false
        lineNumber += 1
        start = newline + 1
        continue
      }
      const remaining = MAX_LINE_CHARS - pending.length
      if (segment.length > remaining) {
        state.truncated = true
        pending = ''
        if (newline < 0) {
          discardingLongLine = true
          return
        }
        lineNumber += 1
        start = newline + 1
        continue
      }
      pending += segment
      if (newline < 0) return
      recordLine(pending)
      pending = ''
      start = newline + 1
    }
    if (final && !discardingLongLine && pending.length > 0 && !state.stop) recordLine(pending)
  }
}

async function scanFile(
  fs: SearchFileSystem,
  target: FsTargetLike,
  path: string,
  pattern: string,
  caseSensitive: boolean,
  signal: AbortSignal,
  state: SearchState,
): Promise<void> {
  if (state.filesScanned >= MAX_FILES) {
    state.truncated = true
    state.stop = true
    return
  }
  state.filesScanned += 1
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file') {
    state.skippedFiles += 1
    return
  }
  if ((info.size ?? 0) > MAX_FILE_BYTES) {
    state.skippedFiles += 1
    state.truncated = true
    return
  }
  if (state.bytesScanned >= MAX_TOTAL_BYTES) {
    state.skippedFiles += 1
    state.truncated = true
    state.stop = true
    return
  }
  if (info.size !== undefined && state.bytesScanned + info.size > MAX_TOTAL_BYTES) {
    state.skippedFiles += 1
    state.truncated = true
    state.stop = true
    return
  }
  try {
    const consume = makeLineConsumer(path, pattern, caseSensitive, state)
    let fileBytes = 0
    for await (const chunk of await fs.streamText(target, signal)) {
      signal.throwIfAborted()
      const chunkBytes = new TextEncoder().encode(chunk).byteLength
      if (fileBytes + chunkBytes > MAX_FILE_BYTES || state.bytesScanned + chunkBytes > MAX_TOTAL_BYTES) {
        state.truncated = true
        if (state.bytesScanned + chunkBytes > MAX_TOTAL_BYTES) state.stop = true
        break
      }
      fileBytes += chunkBytes
      state.bytesScanned += chunkBytes
      consume(chunk)
      if (state.stop) return
    }
    consume('', true)
  } catch (error: unknown) {
    if (signal.aborted) throw error
    // Binary, unreadable, or provider-specific non-text files do not stop
    // discovery of other readable files.
    state.skippedFiles += 1
  }
}

async function searchWorkspace(
  fs: SearchFileSystem,
  workspaceRoot: string,
  readableRoots: readonly string[],
  input: { pattern: string; path: string; include?: string; caseSensitive: boolean },
  signal: AbortSignal,
): Promise<GrepOutput> {
  if (input.pattern.length === 0 || input.pattern.length > 256) {
    throw new Error('pattern must contain 1–256 literal characters')
  }
  const logicalPath = normalizeWorkspaceRelativePath(input.path)
  const include = normalizeInclude(input.include)
  const workspace = await fs.resolve(workspaceRoot, { signal })
  const query = await resolveWithoutSymlinks(fs, workspace, logicalPath, signal)
  if (!fs.contains(workspace, query)) throw new Error('grep path is outside the experiment workspace')
  const roots = await Promise.all(readableRoots.map(async root =>
    resolveWithoutSymlinks(fs, workspace, normalizeWorkspaceRelativePath(root), signal)))
  const queryInfo = await fs.stat(query, signal)
  if (queryInfo === undefined) throw new Error('grep path does not exist: ' + logicalPath)
  if (queryInfo.type !== 'file' && queryInfo.type !== 'directory') throw new Error('grep path is not a regular file or directory')
  if (queryInfo.type === 'file' && !insideAny(fs, roots, query)) {
    throw new Error('grep file is outside this role\'s readable roots')
  }
  if (queryInfo.type === 'directory' && !canTraverse(fs, roots, query)) {
    throw new Error('grep directory is outside this role\'s readable roots and contains none of them')
  }

  const state: SearchState = { matches: [], bytesScanned: 0, filesScanned: 0, skippedFiles: 0, truncated: false, stop: false }
  const matchesInclude = (path: string): boolean => include === undefined || include.test(path)
  if (queryInfo.type === 'file') {
    if (matchesInclude(logicalPath)) {
      await scanFile(fs, query, logicalPath, input.pattern, input.caseSensitive, signal, state)
    }
  } else {
    let entryCount = 0
    const walk = async (directory: FsTargetLike, relativeDirectory: string, level: number): Promise<void> => {
      const entries = await fs.listDir(directory, signal)
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (state.stop) return
        if (HIDDEN_INTERNAL.has(entry.name)) continue
        if (entryCount >= MAX_ENTRIES) {
          state.truncated = true
          state.stop = true
          return
        }
        entryCount += 1
        const entryPath = relativeDirectory.length === 0 ? entry.name : relativeDirectory + '/' + entry.name
        const pathInfo = await fs.lstat(entry.name, { cwd: directory.displayPath }, signal)
        if (pathInfo?.type === 'symlink' || !fs.contains(workspace, entry.target)) continue
        if (entry.type === 'directory') {
          if (level >= MAX_DEPTH) {
            if (canTraverse(fs, roots, entry.target)) state.truncated = true
            continue
          }
          if (canTraverse(fs, roots, entry.target)) await walk(entry.target, entryPath, level + 1)
        } else if (entry.type === 'file' && insideAny(fs, roots, entry.target) && matchesInclude(entryPath)) {
          await scanFile(fs, entry.target, entryPath, input.pattern, input.caseSensitive, signal, state)
        }
      }
    }
    await walk(query, logicalPath === '.' ? '' : logicalPath, 1)
  }
  return {
    pattern: input.pattern,
    matches: state.matches,
    files_scanned: state.filesScanned,
    bytes_scanned: state.bytesScanned,
    skipped_files: state.skippedFiles,
    truncated: state.truncated,
  }
}

/** A role-local grep tool that never invokes a shell or process search utility. */
export function createGrepTool(
  workspaceRoot: string,
  owner: Agent,
  readableRoots: readonly string[],
  fs?: SearchFileSystem,
) {
  return defineTool({
    name: 'grep',
    description: 'Search workspace files for a literal text string through the DSH filesystem provider, not a subprocess. Results are capped by file count, bytes, line length, and match count; use the workspace-relative path/include arguments to narrow the search. Role scope comes from the AutoReport filesystem context.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Literal text to find; case-insensitive unless case_sensitive is true.' },
      path: { type: 'string', description: 'Workspace-relative file or directory to search; defaults to the workspace root. Only files in this role\'s readable roots are searched.' },
      include: { type: 'string', description: 'Optional workspace-relative glob, such as **/*.md or *.csv.' },
      case_sensitive: { type: 'boolean', description: 'Match letter case exactly; defaults to false.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent?.id !== owner.id) throw new Error('grep requires its owning AutoReport agent')
      if (fs === undefined) throw new Error('safe grep requires the DSH filesystem provider; no process-backed fallback is available')
      const result = await searchWorkspace(fs, workspaceRoot, readableRoots, {
        pattern: args.pattern,
        path: args.path ?? '.',
        ...(args.include === undefined ? {} : { include: args.include }),
        caseSensitive: args.case_sensitive === true,
      }, exec.signal)
      return {
        pattern: result.pattern,
        matches: result.matches.map(match => ({ path: match.path, line: match.line, text: match.text })),
        files_scanned: result.files_scanned,
        bytes_scanned: result.bytes_scanned,
        skipped_files: result.skipped_files,
        truncated: result.truncated,
      }
    },
  })
}
