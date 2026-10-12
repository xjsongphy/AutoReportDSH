/** Detailed, machine-routable workflow failures and model argument validation. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { isSpecialistRole, type SpecialistRole } from '../roles.js'
import type { TaskStep } from './events.js'

/** Error details are also included in model-visible text, not just UI metadata. */
export class WorkflowError extends HarnessError {
  constructor(code: string, message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(`${message}\nDetails: ${JSON.stringify({ code, ...details })}`, code)
  }
}

/** Describe an invalid field without dumping a potentially long prompt. */
export function actualValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 160) return { type: 'string', length: value.length, preview: value.slice(0, 160) }
  return value === undefined ? '(missing)' : value
}

/** Validate one nonempty, bounded string and identify the offending field. */
export function workflowText(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field} must be a non-empty string of at most ${limit} characters; received ${typeof value === 'string' ? `${value.length} characters` : typeof value}. Supply a valid ${field}.`,
      { field, actual: actualValue(value), expected: `non-empty string, maximum ${limit} characters` })
  }
  return value.trim()
}

/** Validate a persistent task id shared by task and report tools. */
export function workflowTaskId(value: unknown, field = 'task_id'): string {
  const id = workflowText(value, field, 128)
  if (!/^task-[A-Za-z0-9._-]{1,123}$/u.test(id)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field}=${JSON.stringify(id)} is not a valid task ID. Use task- followed by letters, digits, dot, underscore or hyphen; for example task-theory.`,
    { field, actual: id, expected: 'task-<name>, maximum 128 characters' })
  const numeric = /^task-(\d+)$/u.exec(id)
  if (numeric !== null && (!Number.isSafeInteger(Number(numeric[1])) || Number(numeric[1]) < 1)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field}=${id} has a numeric suffix outside 1–${Number.MAX_SAFE_INTEGER}. Use a positive safe integer or a named ID such as task-theory.`, { field, actual: id, expected: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER } })
  return id
}

/** Validate a specialist role with actionable allowed values. */
export function workflowRole(value: unknown, field = 'role'): SpecialistRole {
  if (!isSpecialistRole(value)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field}=${JSON.stringify(actualValue(value))} is not an AutoReport specialist role. Choose THEORY, DATA_ANALYSIS, PLOTTING or REPORT.`,
    { field, actual: actualValue(value), expected: ['THEORY', 'DATA_ANALYSIS', 'PLOTTING', 'REPORT'] })
  return value
}

/** Validate a task-id array, retaining field indices and rejecting duplicates. */
export function workflowTaskIds(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > 128 || (required && value.length === 0)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field} must be an array of ${required ? '1–128' : '0–128'} task IDs.`,
    { field, actual: actualValue(value), expected: required ? 'nonempty array of task IDs' : 'array of task IDs' })
  const ids = value.map((item, index) => workflowTaskId(item, `${field}[${index}]`))
  const seen = new Map<string, number>()
  for (const [index, id] of ids.entries()) {
    const previous = seen.get(id)
    if (previous !== undefined) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field}[${index}]=${id} duplicates ${field}[${previous}]. Remove the duplicate task ID.`,
      { field: `${field}[${index}]`, task_id: id, duplicate_of: `${field}[${previous}]` })
    seen.set(id, index)
  }
  return ids
}

/** Validate checklist entries and return the exact field that needs correction. */
export function workflowSteps(value: unknown, field = 'steps'): TaskStep[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field} must be an array containing at most 64 checklist entries.`, { field, actual: actualValue(value) })
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field}[${index}] must be an object with description and optional done.`, { field: `${field}[${index}]`, actual: actualValue(item) })
    const entry = item as Record<string, unknown>
    if (entry.done !== undefined && typeof entry.done !== 'boolean') throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field}[${index}].done must be a boolean.`, { field: `${field}[${index}].done`, actual: actualValue(entry.done) })
    return { description: workflowText(entry.description, `${field}[${index}].description`, 512), done: entry.done === true }
  })
}

/** Validate finite integer budgets and provide their unit and permitted range. */
export function workflowInteger(value: unknown, field: string, fallback: number, maximum = 900_000): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `${field} must be an integer between 1 and ${maximum}${field.endsWith('_ms') ? ' milliseconds' : ''}.`, { field, actual: actualValue(value), expected: { minimum: 1, maximum } })
  return value
}
