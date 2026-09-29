/** Bounded, content-free workspace directory discovery for roles without a shell. */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_DEPTH = 4
const MAX_ENTRIES = 512
const HIDDEN_INTERNAL = new Set(['.autoreport', '.checkpoints', '.git'])

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export interface DirectoryListing {
  path: string
  directories: string[]
  files: string[]
  links: string[]
  truncated: boolean
}

/** Structural subset of DSH's `ctx.fs` used for provider-neutral inventory. */
export interface DirectoryFileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ displayPath: string }>
  contains(parent: { displayPath: string }, child: { displayPath: string }): boolean
  stat(target: { displayPath: string }, signal?: AbortSignal): Promise<{ type: string } | undefined>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<{ type: string } | undefined>
  listDir(target: { displayPath: string }, signal?: AbortSignal): Promise<{
    name: string
    type: string
    target: { displayPath: string }
  }[]>
}

/** List names only. Resolve the requested directory before traversal; never
 * follow a link found inside it, and never cross the experiment root. */
export function listWorkspaceDirectory(
  workspaceRoot: string,
  path = '.',
  depth = 1,
  discoverableRoots: readonly string[] = ['.'],
): DirectoryListing {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('path must be a non-empty directory path')
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new Error(`depth must be an integer from 1 through ${MAX_DEPTH}`)
  }
  const logicalPath = normalizeWorkspaceRelativePath(path)
  const root = realpathSync.native(workspaceRoot)
  const requested = resolve(root, logicalPath)
  let cursor = root
  for (const part of logicalPath === '.' ? [] : logicalPath.split('/')) {
    cursor = resolve(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('list does not follow symbolic links')
  }
  const target = realpathSync.native(requested)
  if (!contained(root, target)) throw new Error('directory is outside the experiment workspace')
  const roots = discoverableRoots.map(entry => resolve(root, normalizeWorkspaceRelativePath(entry)))
  const canTraverse = (directory: string): boolean => roots.some(allowed => contained(allowed, directory))
  if (!canTraverse(target)) throw new Error('directory names are outside this role\'s discoverable roots')
  if (!statSync(target).isDirectory()) throw new Error('path is not a directory')

  const listing: DirectoryListing = {
    path: logicalPath,
    directories: [], files: [], links: [], truncated: false,
  }
  let count = 0
  const walk = (directory: string, level: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (HIDDEN_INTERNAL.has(entry.name)) continue
      const absolute = resolve(directory, entry.name)
      const name = relative(target, absolute).split(sep).join('/')
      const insideRoot = roots.some(allowed => contained(allowed, absolute))
      const leadsToRoot = roots.some(allowed => contained(absolute, allowed))
      if (!insideRoot && !leadsToRoot) continue
      if (count >= MAX_ENTRIES) {
        listing.truncated = true
        return
      }
      count += 1
      if (entry.isSymbolicLink()) {
        if (insideRoot) listing.links.push(name)
      } else if (entry.isDirectory()) {
        listing.directories.push(name)
        if (level < depth && canTraverse(absolute)) walk(absolute, level + 1)
      } else if (insideRoot) listing.files.push(name)
      if (listing.truncated) return
    }
  }
  walk(target, 1)
  return listing
}

/** Normalize workspace-relative listing paths without inspecting provider display paths. */
export function normalizeWorkspaceRelativePath(path: string): string {
  if (isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) {
    throw new Error('list path must be workspace-relative')
  }
  const parts: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new Error('directory is outside the experiment workspace')
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/') || '.'
}

async function resolveWithoutSymlinks(
  fs: DirectoryFileSystem,
  workspace: { displayPath: string },
  logicalPath: string,
  signal?: AbortSignal,
): Promise<{ displayPath: string }> {
  let current = workspace
  for (const part of logicalPath === '.' ? [] : logicalPath.split('/')) {
    const entry = await fs.lstat(part, { cwd: current.displayPath }, signal)
    if (entry?.type === 'symlink') throw new Error('list does not follow symbolic links')
    const next = await fs.resolve(part, {
      cwd: current.displayPath,
      ...(signal === undefined ? {} : { signal }),
    })
    if (!fs.contains(workspace, next)) throw new Error('directory is outside the experiment workspace')
    current = next
  }
  return current
}

/** Async inventory through DSH's filesystem capability, with root containment and symlink checks. */
export async function listWorkspaceDirectoryFromFs(
  fs: DirectoryFileSystem,
  workspaceRoot: string,
  path = '.',
  depth = 1,
  signal?: AbortSignal,
  discoverableRoots: readonly string[] = ['.'],
): Promise<DirectoryListing> {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('path must be a non-empty directory path')
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new Error(`depth must be an integer from 1 through ${MAX_DEPTH}`)
  }
  const logicalPath = normalizeWorkspaceRelativePath(path)
  const root = await fs.resolve(workspaceRoot, signal === undefined ? {} : { signal })
  const target = await resolveWithoutSymlinks(fs, root, logicalPath, signal)
  if (!fs.contains(root, target)) throw new Error('directory is outside the experiment workspace')
  const roots = await Promise.all(discoverableRoots.map(entry => resolveWithoutSymlinks(
    fs,
    root,
    normalizeWorkspaceRelativePath(entry),
    signal,
  )))
  if (roots.some(allowed => !fs.contains(root, allowed))) {
    throw new Error('discoverable root resolves outside the experiment workspace')
  }
  const canTraverse = (directory: { displayPath: string }): boolean => roots.some(allowed => fs.contains(allowed, directory))
  if (!canTraverse(target)) throw new Error('directory names are outside this role\'s discoverable roots')
  const info = await fs.stat(target, signal)
  if (info?.type !== 'directory') throw new Error('path is not a directory')

  const listing: DirectoryListing = {
    path: logicalPath,
    directories: [], files: [], links: [], truncated: false,
  }
  let count = 0
  const walk = async (directory: { displayPath: string }, level: number, parentPath: string): Promise<void> => {
    const entries = await fs.listDir(directory, signal)
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (HIDDEN_INTERNAL.has(entry.name)) continue
      const name = parentPath.length === 0 ? entry.name : `${parentPath}/${entry.name}`
      const pathInfo = await fs.lstat(
        entry.name,
        { cwd: directory.displayPath },
        signal,
      )
      const parentDiscoverable = roots.some(allowed => fs.contains(allowed, directory))
      if (pathInfo?.type === 'symlink') {
        if (parentDiscoverable) {
          if (count >= MAX_ENTRIES) {
            listing.truncated = true
            return
          }
          count += 1
          listing.links.push(name)
        }
        continue
      }
      const insideRoot = roots.some(allowed => fs.contains(allowed, entry.target))
      const leadsToRoot = roots.some(allowed => fs.contains(entry.target, allowed))
      if (!insideRoot && !leadsToRoot) continue
      if (count >= MAX_ENTRIES) {
        listing.truncated = true
        return
      }
      count += 1
      if (!fs.contains(root, entry.target)) {
        if (insideRoot) listing.links.push(name)
      } else if (entry.type === 'directory') {
        listing.directories.push(name)
        if (level < depth && canTraverse(entry.target)) await walk(entry.target, level + 1, name)
      } else if (insideRoot) listing.files.push(name)
      if (listing.truncated) return
    }
  }
  await walk(target, 1, '')
  return listing
}

/** A role-local read-only tool, bound to the agent that owns the scope. */
export function createListDirectoryTool(
  workspaceRoot: string,
  owner: Agent,
  fs?: DirectoryFileSystem,
  discoverableRoots: readonly string[] = ['.'],
) {
  return defineTool({
    name: 'list',
    description: 'List workspace directory and file names without reading file contents. The path is workspace-relative; depth is bounded to 1–4 and listed symlinks are never followed.',
    parameters: {
      path: { type: 'string', description: 'Workspace-relative directory (default: workspace root); absolute paths and URI paths are not accepted.' },
      depth: { type: 'number', description: 'Levels to list, 1–4; default 1.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent?.id !== owner.id) throw new Error('list requires its owning AutoReport agent')
      const logicalPath = normalizeWorkspaceRelativePath(args.path ?? '.')
      const listing = fs === undefined
        ? listWorkspaceDirectory(workspaceRoot, logicalPath, args.depth, discoverableRoots)
        : await listWorkspaceDirectoryFromFs(fs, workspaceRoot, logicalPath, args.depth, exec.signal, discoverableRoots)
      return { ...listing }
    },
  })
}
