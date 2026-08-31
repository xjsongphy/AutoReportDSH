/**
 * Delegation/report envelope vocabulary and validators (PLAN.md §2.4–2.5).
 * Validation returns typed results instead of throwing across the tool
 * boundary: malformed child reports become explicit quality failures, never
 * crashes and never success.
 * @module
 */

import type { WorkflowReportEnvelope } from './events.js'

/** Upper bound for report response text (chars, UTF-16 code units). */
export const MAX_RESPONSE_LENGTH = 16_384

/** Upper bound for `produced_files` entries per report. */
export const MAX_PRODUCED_FILES = 512

/** Model-facing dispatch request recorded by MAIN before transport. */
export interface DelegationRequest {
  /** Owning task id (`task-<n>`). */
  readonly taskId: string
  /** Attempt number within the task; monotonic per dispatch/re-dispatch. */
  readonly revision: number
  /** Task goal delivered as the child's user message. */
  readonly prompt: string
  /** Optional extra constraints quoted from the user. */
  readonly context?: string
}

/** Discriminated validation outcome; never throws across the boundary. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * Canonical delegation key used by projections and waiter registries.
 * @param taskId - owning task id.
 * @param revision - attempt number.
 * @returns stable composite key `taskId#revision`.
 */
export function delegationKey(taskId: string, revision: number): string {
  return `${taskId}#${revision}`
}

/**
 * Normalize one produced-file path to a comparable workspace-relative POSIX
 * form: backslashes become slashes, duplicate slashes collapse, trailing
 * slashes drop. Absolute paths and traversal segments are REJECTED, not
 * rewritten — normalization never widens what a report may claim.
 * @param raw - model-supplied path candidate.
 * @returns the normalized path, or null when the path is not admissible.
 */
export function normalizeProducedPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const slashed = raw.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null
  const segments: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null
  return segments.join('/')
}

/**
 * Parse a workflow envelope that may be preceded by a human-readable relay
 * prefix. Bare JSON still parses; mixed text takes a fenced or trailing JSON object.
 * @param raw - joined message text or an already-parsed object.
 * @returns the validated envelope or a rejection reason.
 */
export function parseWorkflowEnvelopeFromText(raw: unknown): ParseResult<WorkflowReportEnvelope> {
  if (typeof raw !== 'string') return parseWorkflowEnvelope(raw)
  const trimmed = raw.trim()
  const direct = parseWorkflowEnvelope(trimmed)
  if (direct.ok) return direct
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/u.exec(trimmed)
  if (fence?.[1] !== undefined) {
    const fenced = parseWorkflowEnvelope(fence[1])
    if (fenced.ok) return fenced
  }
  const start = trimmed.lastIndexOf('{')
  if (start < 0) return { ok: false, reason: 'report is not valid JSON' }
  return parseWorkflowEnvelope(trimmed.slice(start))
}

/**
 * Validate one raw child-report payload into the canonical envelope.
 * @param raw - parsed-or-unparsed report content (the tool passes JSON text).
 * @returns the validated envelope or a rejection reason.
 */
export function parseWorkflowEnvelope(raw: unknown): ParseResult<WorkflowReportEnvelope> {
  let value: unknown
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return { ok: false, reason: 'report is not valid JSON' }
    }
  } else {
    value = raw
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'report must be a JSON object' }
  }
  const record = value as Record<string, unknown>

  const task_id = record['task_id']
  if (typeof task_id !== 'string' || !/^task-[A-Za-z0-9._-]{1,127}$/.test(task_id)) {
    return { ok: false, reason: 'task_id must match task-<name> (1–128 safe chars)' }
  }

  const revision = record['delegation_revision']
  if (
    typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 1
  ) {
    return { ok: false, reason: 'delegation_revision must be a positive safe integer' }
  }

  const status = record['status']
  if (status !== 'success' && status !== 'blocked') {
    return { ok: false, reason: "status must be 'success' or 'blocked'" }
  }

  const block_type = record['block_type']
  if (status === 'blocked') {
    if (block_type !== 'missing_data' && block_type !== 'quality') {
      return { ok: false, reason: "blocked reports must set block_type 'missing_data'|'quality'" }
    }
  } else if (block_type !== null && block_type !== undefined) {
    return { ok: false, reason: 'successful reports must carry block_type null' }
  }

  const response = record['response']
  if (typeof response !== 'string' || response.length === 0 || response.length > MAX_RESPONSE_LENGTH) {
    return {
      ok: false,
      reason: `response must be a non-empty string of at most ${MAX_RESPONSE_LENGTH} chars`,
    }
  }

  const producedRaw = record['produced_files'] ?? []
  if (!Array.isArray(producedRaw)) {
    return { ok: false, reason: 'produced_files must be an array' }
  }
  if (producedRaw.length > MAX_PRODUCED_FILES) {
    return { ok: false, reason: `produced_files exceeds ${MAX_PRODUCED_FILES} entries` }
  }
  const seen = new Set<string>()
  const produced_files: string[] = []
  for (const entry of producedRaw) {
    const normalized = normalizeProducedPath(entry)
    if (normalized === null) {
      return { ok: false, reason: `produced_files entry is absolute or traversing: ${String(entry)}` }
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    produced_files.push(normalized)
  }

  const envelope: WorkflowReportEnvelope = {
    task_id,
    delegation_revision: revision,
    status,
    ...(status === 'blocked'
      ? { block_type: block_type as 'missing_data' | 'quality' }
      : { block_type: null }),
    response,
    produced_files,
  }
  return { ok: true, value: envelope }
}
