/**
 * Incrementally synchronize externally maintained AutoReport resources into
 * the global plugin data directory (`$DSH_HOME/autoreport/resources`), the
 * DSH analog of AutoReportCLI's `~/.autoreport`.
 *
 * This is runtime work, never a git commit: sessions use the last synced copy
 * when GitHub is unreachable. Pull decision is per file, not per repository.
 * cc-switch is not synced (DSH owns providers). The reorganized writer skill
 * stays as a frozen bundled projection.
 * @module workspace/resource-sync
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const STATE_FILE = '.sync-state.json'
const API_BASE = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'

/** How a fetched body is rewritten before it is written. */
export type ResourceTransform =
  | 'identity'
  | 'typst-main-import'
  | 'typst-skill-index'
  | 'typst-skill-ref'
  | 'autoreport-latex-compile'

/** One externally owned file written under the global overlay. */
export interface ManagedResource {
  readonly id: string
  readonly owner: string
  readonly repository: string
  readonly remotePath: string
  /** Overlay-relative destination; must stay below the overlay root. */
  readonly destination: string
  /** Skill documents get SKILL.md frontmatter checks; assets do not. */
  readonly kind: 'skill' | 'asset'
  /** Optional body rewrite applied after download. */
  readonly transform?: ResourceTransform
}

/**
 * Typst skill references kept for experiment reports: syntax, layout,
 * tables, and academic citations/math. Package-development, conversion,
 * CLI, query, and perf docs are omitted (`typst-compile` and `mplts.typ`
 * already cover compile and the report template).
 */
export const TYPST_SKILL_REFS = [
  'basics.md',
  'styling.md',
  'tables.md',
  'academic.md',
] as const

/**
 * AutoReportCLI's remaining live remotes, minus cc-switch (DSH providers)
 * and the reorganized writer skill (kept as a frozen bundled projection).
 */
export const MANAGED_RESOURCES: readonly ManagedResource[] = [
  {
    id: 'skills-latex-compile',
    owner: 'xjsongphy',
    repository: 'skills',
    remotePath: 'latex-compile/SKILL.md',
    destination: 'skills/latex-compile.md',
    kind: 'skill',
    transform: 'autoreport-latex-compile',
  },
  {
    id: 'pkumpl-license',
    owner: 'xjsongphy',
    repository: 'pkumpl-typst',
    remotePath: 'LICENSE',
    destination: 'typst/LICENSE',
    kind: 'asset',
  },
  {
    id: 'pkumpl-mplts',
    owner: 'xjsongphy',
    repository: 'pkumpl-typst',
    remotePath: 'mplts.typ',
    destination: 'typst/themes/mplts.typ',
    kind: 'asset',
  },
  {
    id: 'pkumpl-main',
    owner: 'xjsongphy',
    repository: 'pkumpl-typst',
    remotePath: 'template/main.typ',
    destination: 'typst/templates/main.typ',
    kind: 'asset',
    transform: 'typst-main-import',
  },
  {
    id: 'pkumpl-bibli',
    owner: 'xjsongphy',
    repository: 'pkumpl-typst',
    remotePath: 'template/bibli.bib',
    destination: 'typst/templates/bibli.bib',
    kind: 'asset',
  },
  {
    id: 'pkumpl-csl',
    owner: 'xjsongphy',
    repository: 'pkumpl-typst',
    remotePath: 'template/american-physics-society.csl',
    destination: 'typst/templates/american-physics-society.csl',
    kind: 'asset',
  },
  {
    id: 'typst-skill',
    owner: 'lucifer1004',
    repository: 'claude-skill-typst',
    remotePath: 'skills/typst/SKILL.md',
    destination: 'typst/skills/typst/SKILL.md',
    kind: 'skill',
    transform: 'typst-skill-index',
  },
  {
    id: 'typst-skill-license',
    owner: 'lucifer1004',
    repository: 'claude-skill-typst',
    remotePath: 'LICENSE',
    destination: 'typst/skills/typst/LICENSE',
    kind: 'asset',
  },
  ...TYPST_SKILL_REFS.map((file): ManagedResource => ({
    id: `typst-skill-${file.replace(/\.md$/u, '')}`,
    owner: 'lucifer1004',
    repository: 'claude-skill-typst',
    remotePath: `skills/typst/${file}`,
    destination: `typst/skills/typst/${file}`,
    kind: 'asset',
    transform: 'typst-skill-ref',
  })),
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
  readonly status: 'updated' | 'unchanged' | 'missing' | 'failed'
  readonly commit: string
  readonly blob: string
  readonly detail?: string
}

export interface SyncOptions {
  /** Global overlay directory (`$dshHome/autoreport/resources`). */
  readonly overlayRoot: string
  /** Fetch implementation; injectable to test remote deltas without a network. */
  readonly fetchFn?: typeof fetch
  /** Managed files; injectable for tests. */
  readonly resources?: readonly ManagedResource[]
  /** Clock; injectable for deterministic state tests. */
  readonly now?: () => Date
}

/** `$dshHome/autoreport/resources` — DSH analog of CLI `~/.autoreport` resources. */
export function syncedResourcesRoot(dshHome: string): string {
  return join(dshHome, 'autoreport', 'resources')
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
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, body)
    await rename(temporary, path)
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function resourceTarget(overlayRoot: string, destination: string): string {
  const root = resolve(overlayRoot)
  const target = resolve(overlayRoot, destination)
  const path = relative(root, target)
  if (path === '' || path === '..' || path.startsWith('../')) {
    throw new Error(`AutoReport resource destination must be a file below the overlay: ${destination}`)
  }
  return target
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AutoReportDSH-resource-sync',
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token !== undefined && token.length > 0) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchJson<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  const response = await fetchFn(url, { headers: githubHeaders(), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function fetchText(fetchFn: typeof fetch, url: string): Promise<string> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(20_000) })
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
}

function applyTransform(body: string, transform: ResourceTransform | undefined): string {
  switch (transform ?? 'identity') {
    case 'identity':
      return body
    case 'typst-main-import':
      return body.replace('#import "@preview/unofficial-pku-mpl:0.1.0": *', '#import "mplts.typ": *')
    case 'typst-skill-index':
      return rewriteTypstSkillIndex(body)
    case 'typst-skill-ref':
      return rewriteTypstSkillRef(body)
    case 'autoreport-latex-compile':
      return adaptLatexCompile(body)
  }
}

function rewriteTypstSkillIndex(body: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(body)
  if (frontmatter === null) {
    throw new Error('AutoReport typst skill transform expected SKILL.md frontmatter')
  }
  const index = [
    '',
    '# Typst',
    '',
    'Typst 0.15+ authoring for AutoReport experiment reports. Compile through the',
    'bundled `typst-compile` skill:',
    '',
    '```bash',
    'typst compile Report/main.typ Report/main.pdf --root "$(pwd)"',
    '```',
    '',
    'The workspace already ships `mplts.typ`. This overlay keeps only the',
    'reference docs used when writing a physics or engineering report.',
    '',
    '| When you need to... | Read |',
    '| --- | --- |',
    '| Syntax, imports, functions, control flow | [basics.md](basics.md) |',
    '| Pages, headings, figures, layout | [styling.md](styling.md) |',
    '| Tables and measured data | [tables.md](tables.md) |',
    '| Citations, theorems, equations | [academic.md](academic.md) |',
    '',
  ].join('\n')
  return `${frontmatter[0]}${index}`
}

function rewriteTypstSkillRef(body: string): string {
  return body
    .replace(
      '**Complete example**: See [examples/package-example/](examples/package-example/) for a minimal publishable package with submodules.',
      '**Complete example**: This bundled report skill omits package-development fixtures; use the package patterns in this document.',
    )
    .replace(
      'See [package search](scripts/search-packages.py) for alternatives.',
      'consult the Typst package documentation when selecting alternatives.',
    )
}

function adaptLatexCompile(body: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(body)
  if (frontmatter === null) {
    throw new Error('AutoReport latex-compile transform expected SKILL.md frontmatter')
  }
  const note = [
    '',
    '## AutoReport workspace',
    '',
    'Compile `Report/main.tex` from bash. Prefer `latexmk`, then `tectonic`, then `xelatex`. Do not use `compile_report`.',
    '',
    '```bash',
    'cd Report && latexmk -xelatex -interaction=nonstopmode -file-line-error main.tex',
    '```',
    '',
  ].join('\n')
  return `${frontmatter[0]}${note}${body.slice(frontmatter[0].length)}`
}

type TreeCacheEntry =
  | { readonly commit: string; readonly blobs: ReadonlyMap<string, string> }
  | { readonly error: string }

/**
 * Query the upstream commit/tree and download only files whose blob differs
 * from the recorded overlay state (or whose local target disappeared). A remote
 * path that no longer exists is reported as `missing` and the local file is
 * kept. A network failure keeps the last overlay copy.
 * @param options - overlay root, fetch, file set, and clock test seams.
 * @returns one result per managed resource.
 */
export async function syncManagedResources(options: SyncOptions): Promise<readonly SyncOutcome[]> {
  const overlayRoot = resolve(options.overlayRoot)
  const fetchFn = options.fetchFn ?? fetch
  const resources = options.resources ?? MANAGED_RESOURCES
  const now = options.now ?? (() => new Date())
  const statePath = join(overlayRoot, STATE_FILE)
  const previous = await loadState(statePath)
  const next: Record<string, SyncedResourceState> = { ...previous.resources }
  const outcomes: SyncOutcome[] = []
  const treeCache = new Map<string, TreeCacheEntry>()
  let stateChanged = false

  await mkdir(overlayRoot, { recursive: true })

  for (const resource of resources) {
    const repositoryKey = `${resource.owner}/${resource.repository}`
    let upstream = treeCache.get(repositoryKey)
    if (upstream === undefined) {
      try {
        const commitUrl = `${API_BASE}/repos/${resource.owner}/${resource.repository}/commits/HEAD`
        const commit = await fetchJson<CommitResponse>(fetchFn, commitUrl)
        const sha = requiredString(commit.sha, `${repositoryKey} commit SHA`)
        const treeSha = requiredString(commit.commit?.tree?.sha, `${repositoryKey} tree SHA`)
        const tree = await fetchJson<TreeResponse>(fetchFn,
          `${API_BASE}/repos/${resource.owner}/${resource.repository}/git/trees/${treeSha}?recursive=1`)
        const blobs = new Map<string, string>()
        for (const entry of tree.tree ?? []) {
          if (entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string') {
            blobs.set(entry.path, entry.sha)
          }
        }
        upstream = { commit: sha, blobs }
      } catch (error: unknown) {
        upstream = { error: error instanceof Error ? error.message : String(error) }
      }
      treeCache.set(repositoryKey, upstream)
    }
    if ('error' in upstream) {
      outcomes.push({
        id: resource.id,
        destination: resource.destination,
        status: 'failed',
        commit: previous.resources[resource.id]?.commit ?? '',
        blob: previous.resources[resource.id]?.blob ?? '',
        detail: `${repositoryKey} tree fetch failed: ${upstream.error}; kept overlay copy`,
      })
      continue
    }

    const blob = upstream.blobs.get(resource.remotePath)
    const target = resourceTarget(overlayRoot, resource.destination)
    if (blob === undefined) {
      outcomes.push({
        id: resource.id,
        destination: resource.destination,
        status: 'missing',
        commit: upstream.commit,
        blob: '',
        detail: `${repositoryKey} no longer contains ${resource.remotePath}; kept overlay copy`,
      })
      continue
    }
    const old = previous.resources[resource.id]
    const changed = old?.blob !== blob
      || old.remotePath !== resource.remotePath
      || old.destination !== resource.destination
      || !existsSync(target)
    if (changed) {
      try {
        const raw = await fetchText(fetchFn,
          `${RAW_BASE}/${resource.owner}/${resource.repository}/${upstream.commit}/${resource.remotePath}`)
        const body = applyTransform(raw, resource.transform)
        if (resource.kind === 'skill') validateSkill(body, resource)
        await atomicWrite(target, body)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        outcomes.push({
          id: resource.id,
          destination: resource.destination,
          status: 'failed',
          commit: upstream.commit,
          blob,
          detail: message,
        })
        continue
      }
    }
    const replacement: SyncedResourceState = {
      commit: upstream.commit,
      blob,
      remotePath: resource.remotePath,
      destination: resource.destination,
      syncedAt: now().toISOString(),
    }
    if (old?.commit === replacement.commit
      && old.blob === replacement.blob
      && old.remotePath === replacement.remotePath
      && old.destination === replacement.destination) {
      next[resource.id] = old
    } else {
      next[resource.id] = replacement
      stateChanged = true
    }
    outcomes.push({
      id: resource.id,
      destination: resource.destination,
      status: changed ? 'updated' : 'unchanged',
      commit: upstream.commit,
      blob,
    })
  }

  if (stateChanged || !existsSync(statePath)) {
    await atomicWrite(statePath, `${JSON.stringify({ schemaVersion: 1, resources: next } satisfies SyncState, null, 2)}\n`)
  }
  return outcomes
}
