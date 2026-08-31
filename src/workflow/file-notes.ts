/**
 * Semantic file-note freshness and cold-rebind handoff (role memory).
 *
 * Observer artifacts remain mechanical. A description is stale when the latest
 * artifact for that path is newer than `descriptionUpdatedAt`, or when no
 * description exists. Handoff text is reconstructed from this projection —
 * never from conversation history.
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AutoReportRole, SpecialistRole } from '../roles.js'
import type { ArtifactSnapshot, DelegationSnapshot, FileNoteSnapshot } from './events.js'
import { delegationKey } from './protocol.js'
import type { WorkflowProjection } from './service.js'

/** Maximum description length accepted by `describe_files`. */
export const MAX_FILE_DESCRIPTION = 2_048

/** Maximum optional notes length accepted by `describe_files`. */
export const MAX_FILE_NOTES = 4_096

const MAX_HANDOFF_FILES = 24
const MAX_HANDOFF_TASKS = 8
const HANDOFF_FIELD = 400

/**
 * Open (unanswered) delegation currently assigned to one specialist child.
 * @param projection - parent workflow fold.
 * @param childSessionId - specialist session id.
 * @returns the latest waiting attempt, when one exists.
 */
export function openDelegationForChild(
  projection: WorkflowProjection,
  childSessionId: SessionId,
): DelegationSnapshot | undefined {
  let match: DelegationSnapshot | undefined
  for (const task of projection.tasks.values()) {
    const key = task.latestDelegationRevision
    if (key === undefined) continue
    const delegation = projection.delegations.get(`${task.taskId}#${key}`)
    if (delegation === undefined) continue
    if (delegation.childSessionId !== childSessionId) continue
    if (delegation.phase !== 'dispatched' && delegation.phase !== 'waiting_for_child') continue
    if (delegation.report !== undefined) continue
    if (match === undefined || (delegation.dispatchedAt ?? 0) > (match.dispatchedAt ?? 0)) match = delegation
  }
  return match
}

function belongsToAttempt(artifact: ArtifactSnapshot, delegation: DelegationSnapshot): boolean {
  const key = delegationKey(delegation.taskId, delegation.delegationRevision)
  if (artifact.delegationKey === key) return true
  if (artifact.delegationKey !== undefined) return false
  if (artifact.producedBy !== delegation.role) return false
  if (delegation.dispatchedAt !== undefined && artifact.recordedAt < delegation.dispatchedAt) return false
  return true
}

/**
 * Latest observer artifact per path for one delegation attempt.
 * @param projection - parent workflow fold.
 * @param delegation - the attempt whose dirty files are under review.
 * @returns last-write-wins artifacts for that attempt.
 */
export function dirtyArtifactsForDelegation(
  projection: WorkflowProjection,
  delegation: DelegationSnapshot,
): ArtifactSnapshot[] {
  const byPath = new Map<string, ArtifactSnapshot>()
  for (const artifact of projection.artifacts) {
    if (!belongsToAttempt(artifact, delegation)) continue
    byPath.set(artifact.path, artifact)
  }
  return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Paths whose semantic descriptions are missing or older than the file.
 * @param projection - parent workflow fold.
 * @param childSessionId - specialist session id.
 * @returns sorted stale workspace-relative paths.
 */
export function staleDescribedPaths(
  projection: WorkflowProjection,
  childSessionId: SessionId,
): string[] {
  const delegation = openDelegationForChild(projection, childSessionId)
  if (delegation === undefined) return []
  return staleDescribedPathsForDelegation(projection, delegation)
}

/**
 * Paths whose semantic descriptions are missing or older than the file for
 * one known delegation (including while `report_workflow` is executing).
 * @param projection - parent workflow fold.
 * @param delegation - the attempt that produced the files.
 * @returns sorted stale workspace-relative paths.
 */
export function staleDescribedPathsForDelegation(
  projection: WorkflowProjection,
  delegation: DelegationSnapshot,
): string[] {
  const stale: string[] = []
  for (const artifact of dirtyArtifactsForDelegation(projection, delegation)) {
    const note = projection.fileNotes.get(artifact.path)
    if (note === undefined || artifact.recordedAt > note.descriptionUpdatedAt) stale.push(artifact.path)
  }
  return stale
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

function filesForRole(projection: WorkflowProjection, role: AutoReportRole): FileNoteSnapshot[] {
  const latest = new Map<string, ArtifactSnapshot>()
  for (const artifact of projection.artifacts) {
    if (artifact.producedBy !== role) continue
    latest.set(artifact.path, artifact)
  }
  const notes: FileNoteSnapshot[] = []
  const seen = new Set<string>()
  for (const path of [...latest.keys()].sort((a, b) => (a < b ? -1 : 1))) {
    const note = projection.fileNotes.get(path)
    if (note === undefined) continue
    seen.add(path)
    notes.push(note)
    if (notes.length >= MAX_HANDOFF_FILES) return notes
  }
  if (notes.length >= MAX_HANDOFF_FILES) return notes
  for (const note of [...projection.fileNotes.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (seen.has(note.path)) continue
    if (note.producedBy !== role) continue
    notes.push(note)
    if (notes.length >= MAX_HANDOFF_FILES) break
  }
  return notes
}

/**
 * Durable role-memory briefing for a newly created or rebound specialist.
 * Empty when the role has no prior files, tasks, or notes.
 * @param projection - parent workflow fold.
 * @param role - specialist being (re)started.
 * @returns model-facing handoff text, or undefined when there is nothing to carry.
 */
export function roleHandoffText(projection: WorkflowProjection, role: SpecialistRole): string | undefined {
  const files = filesForRole(projection, role)
  const owned = [...projection.tasks.values()]
    .filter(task => task.role === role)
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
  const previous = owned.slice(-MAX_HANDOFF_TASKS)
  const open = owned.filter(
    task => task.status === 'pending' || task.status === 'running' || task.status === 'blocked',
  )

  if (files.length === 0 && previous.length === 0) return undefined

  const sections: string[] = [
    `Role memory for ${role} (survives child rebind; do not treat as a new conversation):`,
  ]

  if (files.length > 0) {
    const lines = files.map(note => {
      const notes = note.notes === undefined || note.notes.trim().length === 0
        ? ''
        : `\n  notes: ${clip(note.notes, HANDOFF_FIELD)}`
      return `- ${note.path}: ${clip(note.description, HANDOFF_FIELD)}${notes}`
    })
    sections.push(`Files:\n${lines.join('\n')}`)
  }

  if (previous.length > 0) {
    const lines = previous.map(task => {
      const attempt = task.latestDelegationRevision === undefined
        ? undefined
        : projection.delegations.get(delegationKey(task.taskId, task.latestDelegationRevision))
      const summary = attempt?.report?.response ?? task.blockedReason ?? task.failedReason ?? task.subject
      return `- ${task.taskId} (${task.status}): ${clip(summary, HANDOFF_FIELD)}`
    })
    sections.push(`Previous tasks:\n${lines.join('\n')}`)
  }

  const unfinished = open.filter(task => task.status === 'blocked' || (task.steps.some(step => !step.done)))
  if (unfinished.length > 0) {
    const lines = unfinished.map(task => {
      const reason = task.blockedReason ?? task.failedReason ?? task.subject
      return `- ${task.taskId} ${task.status}: ${clip(reason, HANDOFF_FIELD)}`
    })
    sections.push(`Unfinished issues:\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}
