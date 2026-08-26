/**
 * External manifest projection (PLAN.md §2.11). Session events are the
 * source of truth; this module renders `autoreport/artifact` snapshots into
 * per-directory JSON files under the DSH home — never inside the experiment
 * workspace, which stays limited to user/report content directories.
 * @module
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix } from 'node:path'
import type { ArtifactSnapshot } from '../workflow/events.js'
import { directoryOf } from './artifact-policy.js'

/** Filesystem operations the projection performs; injectable for tests. */
export interface ManifestWriter {
  /** Recursively create a directory. */
  mkdirSync(path: string, options: { recursive: true }): void
  /** Write file contents. */
  writeFileSync(path: string, data: string): void
  /** Atomically move one path over another. */
  renameSync(from: string, to: string): void
  /** Best-effort temp cleanup hook. */
  unlinkSync(path: string): void
}

const NODE_WRITER: ManifestWriter = {
  mkdirSync: (path, options) => mkdirSync(path, options),
  writeFileSync: (path, data) => writeFileSync(path, data),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: path => unlinkSync(path),
}

/**
 * Validate one workspace-relative directory key or workspace id before it may
 * join a filesystem path: non-empty, relative, and free of traversal segments.
 * @param key - candidate directory key (`.` allowed for the workspace root).
 * @param kind - field name used in error messages.
 * @returns the validated POSIX-normalized key.
 */
function validateKey(key: string, kind: string): string {
  if (key.length === 0) throw new Error(`manifest ${kind} must not be empty`)
  const normalized = key.split('\\').join('/')
  if (isAbsolute(normalized)) throw new Error(`manifest ${kind} must be relative: ${key}`)
  const segments = normalized.split('/').filter(segment => segment !== '.')
  if (segments.includes('..')) throw new Error(`manifest ${kind} must not traverse upward: ${key}`)
  return posix.normalize(normalized === '' ? '.' : normalized)
}

/** One rendered manifest document for a single directory. */
export interface RenderedManifest {
  /** Workspace-relative directory this document covers (`.` = root). */
  readonly directory: string
  /** RFC-style epoch ms of rendering. */
  readonly renderedAt: number
  /** Artifact entries under {@link directory}, ordered by path. */
  readonly files: readonly {
    readonly path: string
    readonly status: ArtifactSnapshot['status']
    readonly producedBy: ArtifactSnapshot['producedBy']
    readonly origin: ArtifactSnapshot['origin']
    readonly recordedAt: number
    readonly taskId?: string
    readonly delegationKey?: string
  }[]
}

/**
 * Group artifact snapshots into per-directory documents keyed by their
 * workspace-relative directory.
 * @param artifacts - snapshots to render; duplicates by path are last-write-wins.
 * @returns map of directory key to JSON text.
 */
export function renderManifest(
  artifacts: readonly ArtifactSnapshot[],
): ReadonlyMap<string, string> {
  const grouped = new Map<string, RenderedManifest>()
  for (const snapshot of artifacts) {
    const directory = validateKey(directoryOf(snapshot.path), 'directory')
    const existing = grouped.get(directory)
    const entry: RenderedManifest['files'][number] = {
      path: snapshot.path,
      status: snapshot.status,
      producedBy: snapshot.producedBy,
      origin: snapshot.origin,
      recordedAt: snapshot.recordedAt,
      ...(snapshot.taskId !== undefined ? { taskId: snapshot.taskId } : {}),
      ...(snapshot.delegationKey !== undefined ? { delegationKey: snapshot.delegationKey } : {}),
    }
    if (existing === undefined) {
      grouped.set(directory, { directory, renderedAt: snapshot.recordedAt, files: [entry] })
      continue
    }
    const replacement: RenderedManifest = {
      ...existing,
      renderedAt: Math.max(existing.renderedAt, snapshot.recordedAt),
      files: [...existing.files.filter(file => file.path !== snapshot.path), entry]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }
    grouped.set(directory, replacement)
  }
  const rendered = new Map<string, string>()
  for (const [directory, document] of grouped) {
    rendered.set(directory, `${JSON.stringify(document, null, 2)}\n`)
  }
  return rendered
}

/**
 * Write rendered manifests atomically under the DSH home. Each document lands
 * at `<homeDir>/autoreport/<workspaceId>/manifests/<directory>.json` through a
 * same-directory temp file plus rename, so a crash can never expose a partial
 * manifest. The experiment workspace is never touched: callers pass only the
 * home root and ids, and keys are traversal-validated above.
 * @param homeDir - DSH home root receiving the projection.
 * @param workspaceId - stable workflow/workspace identifier.
 * @param manifests - directory key to JSON text, as produced by {@link renderManifest}.
 * @param writer - filesystem operations; defaults to Node fs.
 */
export function writeManifests(
  homeDir: string,
  workspaceId: string,
  manifests: ReadonlyMap<string, string>,
  writer: ManifestWriter = NODE_WRITER,
): void {
  const cleanId = validateKey(workspaceId, 'workspace id')
  const base = join(homeDir, 'autoreport', cleanId, 'manifests')
  writer.mkdirSync(base, { recursive: true })
  for (const [rawDirectory, content] of manifests) {
    const directory = validateKey(rawDirectory, 'directory')
    // The file name flattens the directory key (Plots/Fig -> Plots_Fig.json)
    // while the target path keeps the real nesting below manifests/.
    const target = join(base, ...directory.split('/'), `${directory.split('/').join('_')}.json`)
    writer.mkdirSync(dirname(target), { recursive: true })
    const temp = join(dirname(target), `.${directory.replace(/\//gu, '_')}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
    try {
      writer.writeFileSync(temp, content)
      writer.renameSync(temp, target)
    } catch (error: unknown) {
      try {
        // The temp file must never survive a failed rename: it would look like
        // a partial manifest to the next reader. Nothing else can reach it.
        writer.unlinkSync(temp)
      } catch {
        // Unlinking already-failed state is best-effort only.
      }
      throw error
    }
  }
}
