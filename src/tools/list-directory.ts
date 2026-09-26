/** Bounded, content-free workspace directory discovery for roles without a shell. */
import { readdirSync, realpathSync, statSync } from 'node:fs'
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

/** List names only. Resolve the requested directory before traversal; never
 * follow a link found inside it, and never cross the experiment root. */
export function listWorkspaceDirectory(workspaceRoot: string, path = '.', depth = 1): DirectoryListing {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('path must be a non-empty directory path')
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw new Error(`depth must be an integer from 1 through ${MAX_DEPTH}`)
  }
  const root = realpathSync.native(workspaceRoot)
  const requested = resolve(root, path)
  const target = realpathSync.native(requested)
  if (!contained(root, target)) throw new Error('directory is outside the experiment workspace')
  if (!statSync(target).isDirectory()) throw new Error('path is not a directory')

  const listing: DirectoryListing = {
    path: relative(root, target).split(sep).join('/') || '.',
    directories: [], files: [], links: [], truncated: false,
  }
  let count = 0
  const walk = (directory: string, level: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (HIDDEN_INTERNAL.has(entry.name)) continue
      if (count >= MAX_ENTRIES) {
        listing.truncated = true
        return
      }
      count += 1
      const absolute = resolve(directory, entry.name)
      const name = relative(target, absolute).split(sep).join('/')
      if (entry.isSymbolicLink()) listing.links.push(name)
      else if (entry.isDirectory()) {
        listing.directories.push(name)
        if (level < depth) walk(absolute, level + 1)
      } else listing.files.push(name)
      if (listing.truncated) return
    }
  }
  walk(target, 1)
  return listing
}

/** A role-local read-only tool, bound to the agent that owns the scope. */
export function createListDirectoryTool(workspaceRoot: string, owner: Agent) {
  return defineTool({
    name: 'list_directory',
    description: 'List workspace directory and file names without reading file contents. Use depth 1–4 for a bounded recursive view; this tool never follows listed symlinks.',
    parameters: {
      path: { type: 'string', description: 'Workspace-relative directory (default: workspace root). Absolute paths must remain inside the workspace.' },
      depth: { type: 'number', description: 'Levels to list, 1–4; default 1.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent?.id !== owner.id) throw new Error('list_directory requires its owning AutoReport agent')
      return { ...listWorkspaceDirectory(workspaceRoot, args.path, args.depth) }
    },
  })
}
