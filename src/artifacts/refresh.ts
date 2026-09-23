/**
 * Disk-truth refresh for tracked artifacts (goal: manifest reads always show
 * current file update times). The artifact observer only sees agent tool
 * events, so edits made OUTSIDE the harness (user in an editor, a re-run of a
 * script) never produce an artifact — a manifest would keep reporting the
 * last agent-write time even though the file on disk moved on, and stale
 * description detection would pass files that changed underneath the team.
 *
 * {@link refreshArtifactsFromDisk} closes that gap at read time: every tracked
 * file is stat-ed, and any file whose size/mtime no longer match the recorded
 * baseline gets a fresh `modified` artifact snapshot committed. The new
 * snapshot is newer than any existing description, so the file immediately
 * reads as stale in the manifest and the turn guard demands a description
 * refresh before the owning role may report success.
 *
 * Baselines live on the artifact snapshot itself (`sizeBytes`/`mtimeMs`,
 * schema 5): the observer stamps them when it commits, and this refresher
 * compares against the latest snapshot per path. Snapshots written by older
 * builds carry no baseline and are treated as changed when the disk mtime
 * exceeds `recordedAt` — the only fact an old snapshot carries.
 * @module
 */

import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { AutoReportRole } from '../roles.js'
import type { ArtifactSnapshot } from '../workflow/events.js'
import type { WorkflowProjection } from '../workflow/service.js'
import { shouldIgnore } from './artifact-policy.js'

/**
 * Artifact-snapshot schema carrying disk baselines (`sizeBytes`/`mtimeMs`).
 * Independent of the workflow-record schema version: baselines are additive,
 * older snapshots stay valid, and {@link artifactMatchesDisk} handles both.
 */
export const ARTIFACT_SCHEMA_VERSION = 5

/** One committed refresh — the caller's durable sink receives these. */
export type ArtifactCommit = (snapshot: ArtifactSnapshot) => void

/**
 * Latest artifact per path for one role (last write wins by `recordedAt`).
 * @param projection - folded workflow state.
 * @param role - role whose tracked files to refresh.
 * @returns path → latest artifact.
 */
export function latestArtifactsForRole(
  projection: WorkflowProjection,
  role: AutoReportRole,
): Map<string, ArtifactSnapshot> {
  const latest = new Map<string, ArtifactSnapshot>()
  for (const artifact of projection.artifacts) {
    if (artifact.producedBy !== role) continue
    const previous = latest.get(artifact.path)
    if (previous === undefined || artifact.recordedAt >= previous.recordedAt) latest.set(artifact.path, artifact)
  }
  return latest
}

/** Disk facts for one tracked file, or undefined when the file is gone/unreadable. */
function diskFacts(absolute: string): { sizeBytes: number; mtimeMs: number } | undefined {
  try {
    const stats = statSync(absolute)
    if (!stats.isFile()) return undefined
    return { sizeBytes: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Whether one tracked file changed on disk since its latest artifact.
 * Snapshots carrying a baseline compare size AND mtime; legacy snapshots
 * (no baseline) compare only mtime against `recordedAt`, so a file touched
 * after the artifact was recorded counts as changed even without a baseline.
 * @param artifact - the latest committed artifact for the path.
 * @param disk - current disk facts, or undefined when the file is missing.
 */
export function artifactMatchesDisk(
  artifact: Pick<ArtifactSnapshot, 'recordedAt' | 'sizeBytes' | 'mtimeMs'>,
  disk: { sizeBytes: number; mtimeMs: number } | undefined,
): boolean {
  if (disk === undefined) return true
  if (artifact.sizeBytes !== undefined && artifact.mtimeMs !== undefined) {
    return artifact.sizeBytes === disk.sizeBytes && artifact.mtimeMs === disk.mtimeMs
  }
  return disk.mtimeMs <= artifact.recordedAt
}

/**
 * Stat every file tracked for `role` and commit a refreshed `modified`
 * artifact for each one whose disk state no longer matches its baseline.
 * Files deleted from disk are left alone: the observer owns deletions, and a
 * vanished file should not silently refresh anything.
 * @param projection - folded workflow state for the owning session.
 * @param role - role whose tracked files to check.
 * @param workspaceRoot - absolute experiment root for resolving tracked paths.
 * @param now - epoch-ms clock for the refreshed snapshots.
 * @param commit - durable sink; call it only when a refresh is warranted.
 * @returns the snapshots committed (already handed to `commit`).
 */
export function refreshArtifactsFromDisk(
  projection: WorkflowProjection,
  role: AutoReportRole,
  workspaceRoot: string,
  now: number,
  commit: ArtifactCommit,
): ArtifactSnapshot[] {
  const committed: ArtifactSnapshot[] = []
  for (const [path, artifact] of [...latestArtifactsForRole(projection, role)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (shouldIgnore(path)) continue
    const absolute = isAbsolute(path) ? resolve(path) : join(workspaceRoot, path)
    const disk = diskFacts(absolute)
    if (artifactMatchesDisk(artifact, disk)) continue
    const snapshot: ArtifactSnapshot = {
      version: ARTIFACT_SCHEMA_VERSION,
      path,
      producedBy: role,
      origin: 'process',
      status: 'modified',
      recordedAt: now,
      sizeBytes: disk!.sizeBytes,
      mtimeMs: disk!.mtimeMs,
    }
    commit(snapshot)
    committed.push(snapshot)
  }
  return committed
}
