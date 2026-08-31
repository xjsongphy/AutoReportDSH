/**
 * Agent-facing AutoReport manifest projection.
 *
 * Runtime facts remain durable session events: artifacts are produced by the
 * observer, file descriptions by the owning agent, and role notes by the
 * owning agent. This module combines those facts into the external shape
 * used by the original AutoReport manifest tool. Epoch milliseconds stay
 * internal; the projection exposes readable UTC timestamps.
 * @module
 */

import type { AutoReportRole } from '../roles.js'
import type { ArtifactSnapshot, FileNoteSnapshot, RoleNoteSnapshot } from './events.js'
import type { WorkflowProjection } from './service.js'

/** One file entry in the compatible AutoReport manifest format. */
export interface ManifestFile {
  readonly path: string
  readonly description: string
  readonly description_updated_at: string | null
  readonly file_updated_at: string | null
}

/** One role's compatible AutoReport manifest document. */
export interface AgentManifest {
  readonly agent_type: string
  readonly updated_at: string
  readonly files: readonly ManifestFile[]
  readonly notes: string
  readonly notes_updated_at: string | null
}

/** Render epoch milliseconds as second-precision UTC ISO 8601. */
export function manifestTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) throw new Error(`manifest timestamp must be finite: ${epochMs}`)
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/u, '+00:00')
}

function latestArtifacts(projection: WorkflowProjection, role: AutoReportRole): Map<string, ArtifactSnapshot> {
  const latest = new Map<string, ArtifactSnapshot>()
  for (const artifact of projection.artifacts) {
    if (artifact.producedBy !== role) continue
    const previous = latest.get(artifact.path)
    if (previous === undefined || artifact.recordedAt >= previous.recordedAt) latest.set(artifact.path, artifact)
  }
  return latest
}

function noteForPath(
  notes: ReadonlyMap<string, FileNoteSnapshot>,
  artifact: ArtifactSnapshot,
  role: AutoReportRole,
): FileNoteSnapshot | undefined {
  const note = notes.get(artifact.path)
  if (note === undefined) return undefined
  // `producedBy` was optional on early file-note snapshots. For those legacy
  // records the owning artifact is the only available role association.
  return note.producedBy === undefined || note.producedBy === role ? note : undefined
}

function latestTimestamp(values: readonly number[], fallback: number): number {
  return values.length === 0 ? fallback : Math.max(...values)
}

/**
 * Combine durable artifact, file-note, and role-note facts for one role.
 * @param projection - folded workflow state for the owning MAIN session.
 * @param role - manifest owner or read target.
 * @param now - injected clock used only for an empty manifest's updated_at.
 */
export function projectManifest(
  projection: WorkflowProjection,
  role: AutoReportRole,
  now: () => number = Date.now,
): AgentManifest {
  const artifacts = latestArtifacts(projection, role)
  const roleNote: RoleNoteSnapshot | undefined = projection.roleNotes.get(role)
  const files: ManifestFile[] = []
  const timestamps: number[] = []

  for (const [path, artifact] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    const note = noteForPath(projection.fileNotes, artifact, role)
    timestamps.push(artifact.recordedAt)
    if (note !== undefined) timestamps.push(note.descriptionUpdatedAt)
    files.push({
      path,
      description: note?.description ?? '',
      description_updated_at: note === undefined ? null : manifestTimestamp(note.descriptionUpdatedAt),
      file_updated_at: manifestTimestamp(artifact.recordedAt),
    })
  }

  if (roleNote !== undefined) timestamps.push(roleNote.updatedAt)
  const updatedAt = latestTimestamp(timestamps, now())
  return {
    agent_type: role.toLowerCase(),
    updated_at: manifestTimestamp(updatedAt),
    files,
    notes: roleNote?.notes ?? '',
    notes_updated_at: roleNote === undefined ? null : manifestTimestamp(roleNote.updatedAt),
  }
}
