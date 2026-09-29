/** Workspace-relative paths used by AutoReport's structured tools. */
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface WorkspacePath {
  readonly absolute: string
  readonly relative: string
}

/** Canonical workspace-relative spelling for structured tool and workflow paths. */
export function normalizeWorkspaceRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const slashed = raw.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/u.test(slashed)) return null
  const segments: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join('/')
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve an existing tool input against the immutable experiment workspace. */
export function existingWorkspacePath(workspaceRoot: string, input: string): WorkspacePath {
  if (input.length === 0 || input.includes('\0')) throw new Error('path must be a non-empty workspace path')
  const root = realpathSync(workspaceRoot)
  const normalized = isAbsolute(input) ? input : normalizeWorkspaceRelativePath(input)
  if (normalized === null) throw new Error(`invalid workspace-relative path: ${input}`)
  const lexical = resolve(root, normalized)
  const inputWithinWorkspace = isAbsolute(input) && within(resolve(workspaceRoot), resolve(input))
  if (!within(root, lexical) && !inputWithinWorkspace) throw new Error(`path escapes the workspace: ${input}`)
  const absolute = realpathSync(lexical)
  if (!within(root, absolute)) throw new Error(`path resolves outside the workspace: ${input}`)
  return { absolute, relative: relative(root, absolute).split(sep).join('/') }
}

/** Assert that a resolved file belongs to one role's output directory. */
export function assertWorkspaceRoot(path: WorkspacePath, root: string): void {
  if (path.relative !== root && !path.relative.startsWith(`${root}/`)) {
    throw new Error(`path must be inside ${root}/: ${path.relative}`)
  }
}

/** Create fixed tool-owned directories without following a workspace symlink. */
export function ensureOwnedDirectory(workspaceRoot: string, rootName: string, parts: readonly string[]): string {
  const workspace = realpathSync(workspaceRoot)
  let current = workspace
  for (const part of [rootName, ...parts]) {
    if (part.length === 0 || part === '.' || part === '..' || part.includes(sep)) throw new Error('invalid output directory component')
    current = join(current, part)
    if (!existsSync(current)) mkdirSync(current)
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory() || !within(workspace, realpathSync(current))) {
      throw new Error(`unsafe output directory: ${current}`)
    }
  }
  return current
}
