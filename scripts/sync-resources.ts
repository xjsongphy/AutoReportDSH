/**
 * Incrementally synchronize externally maintained AutoReport resources.
 *
 * This is deliberately an explicit development/release action, never startup
 * work: normal report sessions remain offline and use the last bundled copy.
 * The GitHub tree API supplies immutable blob ids, so an upstream commit that
 * changes only a/b downloads only a/b and never re-fetches c.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = '.sync-state.json'
const API_BASE = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'

/** One externally owned file deliberately included in the package. */
export interface ManagedResource {
  readonly id: string
  readonly owner: string
  readonly repository: string
  readonly remotePath: string
  /** Repository-relative destination; must stay below `resources/`. */
  readonly destination: string
}

/** The entire current external-sync surface. Add entries here intentionally. */
export const MANAGED_RESOURCES: readonly ManagedResource[] = [
  {
    id: 'mineru-skill',
    owner: 'xjsongphy',
    repository: 'skills',
    remotePath: 'mineru/SKILL.md',
    destination: 'resources/skills/mineru.md',
  },
]

interface SyncedResourceState {
  readonly commit: string
  readonly blob: string
  readonly remotePath: string
  readonly destination: string
  readonly syncedAt: string
}

interface SyncState {
  readonly schemaVersion: 1
  readonly resources: Readonly<Record<string, SyncedResourceState>>
}

interface CommitResponse {
  readonly sha?: unknown
  readonly commit?: { readonly tree?: { readonly sha?: unknown } }
}

interface TreeResponse {
  readonly tree?: readonly { readonly path?: unknown; readonly type?: unknown; readonly sha?: unknown }[]
}

export interface SyncOutcome {
  readonly id: string
  readonly destination: string
  readonly status: 'updated' | 'unchanged'
  readonly commit: string
  readonly blob: string
}

export interface SyncOptions {
  /** Repository root; injectable for tests. */
  readonly root?: string
  /** Fetch implementation; injectable to test remote deltas without a network. */
  readonly fetchFn?: typeof fetch
  /** Managed files; injectable for future resource groups and tests. */
  readonly resources?: readonly ManagedResource[]
  /** Clock; injectable for deterministic state tests. */
  readonly now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validState(value: unknown): value is SyncState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.resources)) return false
  return Object.values(value.resources).every(entry => isRecord(entry)
    && typeof entry.commit === 'string'
    && typeof entry.blob === 'string'
    && typeof entry.remotePath === 'string'
    && typeof entry.destination === 'string'
    && typeof entry.syncedAt === 'string')
}

async function loadState(path: string): Promise<SyncState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!validState(parsed)) throw new Error('schema is invalid')
    return parsed
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, resources: {} }
    throw new Error(`AutoReport resource sync state ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${String(path.split('/').at(-1) ?? 'resource')}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, body)
    await rename(temporary, path)
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function resourceTarget(root: string, destination: string): string {
  const resourcesRoot = resolve(root, 'resources')
  const target = resolve(root, destination)
  const path = relative(resourcesRoot, target)
  if (path === '' || path === '..' || path.startsWith('../')) {
    throw new Error(`AutoReport resource destination must be a file below resources/: ${destination}`)
  }
  return target
}

async function fetchJson<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  const response = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function fetchText(fetchFn: typeof fetch, url: string): Promise<string> {
  const response = await fetchFn(url)
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.text()
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`AutoReport resource sync received no ${label}`)
  return value
}

function validateSkill(body: string, resource: ManagedResource): void {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(body)
  if (frontmatter === null || !/^name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/mu.test(frontmatter[0]) || !/^description:\s*\S/mu.test(frontmatter[0])) {
    throw new Error(`AutoReport resource sync rejected ${resource.id}: expected valid SKILL.md frontmatter`)
  }
  if (resource.id === 'mineru-skill' && !/^name:\s*mineru\s*$/mu.test(frontmatter[0])) {
    throw new Error('AutoReport resource sync rejected mineru-skill: upstream skill name must remain mineru')
  }
}

/**
 * Query the upstream commit/tree and download only files whose blob differs
 * from the recorded state (or whose local target disappeared).
 * @param options - root, fetch, file set, and clock test seams.
 * @returns one result per managed resource.
 */
export async function syncManagedResources(options: SyncOptions = {}): Promise<readonly SyncOutcome[]> {
  const root = resolve(options.root ?? ROOT)
  const fetchFn = options.fetchFn ?? fetch
  const resources = options.resources ?? MANAGED_RESOURCES
  const now = options.now ?? (() => new Date())
  const statePath = join(root, 'resources', STATE_FILE)
  const previous = await loadState(statePath)
  const next: Record<string, SyncedResourceState> = { ...previous.resources }
  const outcomes: SyncOutcome[] = []
  const treeCache = new Map<string, { commit: string; blobs: ReadonlyMap<string, string> }>()
  let stateChanged = false

  for (const resource of resources) {
    const repositoryKey = `${resource.owner}/${resource.repository}`
    let upstream = treeCache.get(repositoryKey)
    if (upstream === undefined) {
      const commitUrl = `${API_BASE}/repos/${resource.owner}/${resource.repository}/commits/HEAD`
      const commit = await fetchJson<CommitResponse>(fetchFn, commitUrl)
      const sha = requiredString(commit.sha, `${repositoryKey} commit SHA`)
      const treeSha = requiredString(commit.commit?.tree?.sha, `${repositoryKey} tree SHA`)
      const tree = await fetchJson<TreeResponse>(fetchFn,
        `${API_BASE}/repos/${resource.owner}/${resource.repository}/git/trees/${treeSha}?recursive=1`)
      const blobs = new Map<string, string>()
      for (const entry of tree.tree ?? []) {
        if (entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string') blobs.set(entry.path, entry.sha)
      }
      upstream = { commit: sha, blobs }
      treeCache.set(repositoryKey, upstream)
    }

    const blob = upstream.blobs.get(resource.remotePath)
    if (blob === undefined) throw new Error(`AutoReport resource sync: ${repositoryKey} does not contain ${resource.remotePath}`)
    const target = resourceTarget(root, resource.destination)
    const old = previous.resources[resource.id]
    const changed = old?.blob !== blob || old.remotePath !== resource.remotePath || old.destination !== resource.destination || !existsSync(target)
    if (changed) {
      const body = await fetchText(fetchFn,
        `${RAW_BASE}/${resource.owner}/${resource.repository}/${upstream.commit}/${resource.remotePath}`)
      validateSkill(body, resource)
      await atomicWrite(target, body)
    }
    const replacement: SyncedResourceState = {
      commit: upstream.commit,
      blob,
      remotePath: resource.remotePath,
      destination: resource.destination,
      syncedAt: now().toISOString(),
    }
    // A repeated check against the same commit/blob must not rewrite state.
    // A different commit is still recorded even when this managed blob did not
    // change, so the manifest accurately says which upstream revision was seen.
    if (old?.commit === replacement.commit
      && old.blob === replacement.blob
      && old.remotePath === replacement.remotePath
      && old.destination === replacement.destination) {
      next[resource.id] = old
    } else {
      next[resource.id] = replacement
      stateChanged = true
    }
    outcomes.push({ id: resource.id, destination: resource.destination, status: changed ? 'updated' : 'unchanged', commit: upstream.commit, blob })
  }

  if (stateChanged || !existsSync(statePath)) {
    await atomicWrite(statePath, `${JSON.stringify({ schemaVersion: 1, resources: next } satisfies SyncState, null, 2)}\n`)
  }
  return outcomes
}

async function main(): Promise<void> {
  const outcomes = await syncManagedResources()
  for (const outcome of outcomes) console.log(`${outcome.status}: ${outcome.destination} (${outcome.blob})`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
