/**
 * Pure view model for AutoReport's dedicated tool rows.
 *
 * Everything here is a function of the durable call slice alone — no I/O, no
 * session state, no clock — because a tool row renders on live streaming AND
 * on session-log replay. Anything unreadable degrades to a shorter label
 * rather than a thrown error or an invented value.
 *
 * @module autoreportdsh/tool-rows-model
 */

import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolRowLocaleKey } from './locales.js'

/** The frozen running-or-settled call node a toolview receives. */
export type ToolRowBlock = ToolCallViewProps['block']

/** Lifecycle the collapsed leading slot wears. */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

/** Translator bound to the tool rows' dictionary namespace. */
export type ToolRowText = (key: ToolRowLocaleKey) => string

/** What one call contributes to its collapsed row. */
export interface ToolRowFacts {
  /** Lifecycle of the call. */
  readonly state: ToolRowState
  /** Flattened result text, or null while the call is still running. */
  readonly output: string | null
  /** First output line when the call failed; null in every other state. */
  readonly errorSummary: string | null
}

/** First physical line, trimmed; undefined when it is blank. */
function firstLine(text: string): string | undefined {
  const newline = text.indexOf('\n')
  const line = (newline === -1 ? text : text.slice(0, newline)).trim()
  return line === '' ? undefined : line
}

/** Non-empty trimmed string, or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Parsed arguments as an object, or undefined for a truncated prefix. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Finite number, or undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A role argument, spelled the way the delegation row spells it. */
function roleLabel(value: unknown): string | undefined {
  const role = asString(value)
  return role === undefined ? undefined : role.toUpperCase()
}

/**
 * Read the call's arguments.
 *
 * A running call streams them; a settled one keeps a copy on `call`, and a
 * call whose arguments never arrived reads as an empty string.
 * @param block - the running or settled call node.
 * @returns the raw argument JSON, never null.
 */
export function callArgs(block: ToolRowBlock): string {
  return ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
}

/**
 * Parse streamed argument JSON.
 *
 * Streaming can expose a truncated prefix, which is not an error worth
 * showing: an unreadable prefix just yields a shorter row.
 * @param argsRaw - raw argument JSON.
 * @returns the argument object, or undefined when it cannot be read as one.
 */
export function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(argsRaw) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Flatten the durable result blocks under the generic Tool-row text contract.
 * Keep aligned with ui-tool's `models/tool-call-model.ts` `resultText`.
 * @param block - the running or settled call node.
 * @returns the result text, or null while the call is still running.
 */
export function flattenResult(block: ToolRowBlock): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/**
 * Derive the row's lifecycle and output without consulting anything but the call.
 * @param block - the running or settled call node.
 * @returns the state, flattened output, and any collapsed error summary.
 */
export function toolRowFacts(block: ToolRowBlock): ToolRowFacts {
  const settled = 'kind' in block
  const state: ToolRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = flattenResult(block)
  return {
    state,
    output,
    // A failure's first line is the actionable part; the rest is a stack or a
    // JSON body that belongs behind the disclosure.
    errorSummary: state === 'error' && output !== null ? firstLine(output) ?? null : null,
  }
}

/**
 * Collapsed summary for one `send_to_agent` call.
 * @param argsRaw - raw argument JSON.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the call is not readable yet.
 */
export function sendToAgentSummary(argsRaw: string, t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  const role = args === undefined ? undefined : asString(args.role)
  if (args === undefined || role === undefined) return undefined
  const taskId = asString(args.task_id)
  if (taskId !== undefined) return `${role} · ${t('resend')} ${taskId}`
  const prompt = asString(args.prompt)
  const label = asString(args.subject) ?? (prompt === undefined ? undefined : firstLine(prompt))
  return label === undefined ? role : `${role} · ${label}`
}

/** Task count in a settled whole-board read, or undefined when unreadable. */
function boardSize(output: string | null): number | undefined {
  const parsed = output === null ? undefined : asObject(parseResult(output))
  const tasks = parsed === undefined ? undefined : parsed.tasks
  return Array.isArray(tasks) ? tasks.length : undefined
}

/** Wire status of the single task a settled read returned. */
function taskStatus(output: string | null): string | undefined {
  const parsed = output === null ? undefined : asObject(parseResult(output))
  const task = parsed === undefined ? undefined : asObject(parsed.task)
  return task === undefined ? undefined : asString(task.status)
}

/** Result text as JSON; undefined when the tool answered with prose or nothing. */
function parseResult(output: string): unknown {
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

/** Checklist size of an `update` call, or undefined when it carried none. */
function checklistSize(steps: unknown): { done: number; total: number } | undefined {
  if (!Array.isArray(steps)) return undefined
  const done = steps.filter(step => asObject(step)?.done === true).length
  return { done, total: steps.length }
}

/**
 * Collapsed summary for one `workflow_task` call.
 *
 * `update` counts the replacement checklist the call itself carries, so it
 * needs no result. A whole-board `read` is the one label that does: the task
 * count exists only in the settled result, so it stays bare until then.
 * @param argsRaw - raw argument JSON.
 * @param output - flattened result text, or null while still running.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the call is not readable.
 */
export function workflowTaskSummary(
  argsRaw: string,
  output: string | null,
  t: ToolRowText,
): string | undefined {
  const args = parseArgs(argsRaw)
  if (args === undefined) return undefined
  const action = args.action
  const taskId = asString(args.task_id)
  if (action === 'read') {
    if (taskId === undefined) {
      const size = boardSize(output)
      return size === undefined ? undefined : `${size} ${t('tasks')}`
    }
    const status = taskStatus(output)
    const label = `${t('read')} ${taskId}`
    return status === undefined ? label : `${label} · ${status}`
  }
  const verb = action === 'update'
    ? t('update')
    : action === 'cancel'
      ? t('cancel')
      : action === 'reopen' ? t('reopen') : undefined
  if (verb === undefined) return undefined
  const label = taskId === undefined ? verb : `${verb} ${taskId}`
  if (action !== 'update') return label
  const size = checklistSize(args.steps)
  return size === undefined ? label : `${label} · ${size.done}/${size.total} ${t('checked')}`
}

/**
 * Collapsed summary for one `list` call: the directory, and how deep it goes.
 *
 * The path is optional on the wire (absent means the workspace root), so an
 * unreadable path reads as `.` rather than as no summary at all.
 * @param argsRaw - raw argument JSON.
 * @param _output - unused; a listing says nothing the row does not already have.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the arguments are not readable.
 */
export function listSummary(argsRaw: string, _output: string | null, t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  if (args === undefined) return undefined
  const path = asString(args.path) ?? '.'
  const depth = asNumber(args.depth)
  return depth === undefined || depth <= 1 ? path : `${path} · ${depth} ${t('levels')}`
}

/**
 * Row label for one `manifest` call: the action it takes on the manifest.
 *
 * The action is part of the label rather than of the summary so the row reads
 * as a verb phrase — `Read manifest · THEORY` — like every other tool row. An
 * action the wire enum does not carry cannot reach a row, so anything that is
 * not `update` reads as the default `read`.
 * @param argsRaw - raw argument JSON.
 * @param t - translator for the row's copy.
 * @returns the row label.
 */
export function manifestTitle(argsRaw: string, t: ToolRowText): string {
  const args = parseArgs(argsRaw)
  const action = args === undefined ? undefined : asString(args.action)
  return t(action === 'update' ? 'manifestUpdateTitle' : 'manifestReadTitle')
}

/**
 * Collapsed summary for one `manifest` call: which role's manifest, and how
 * many file descriptions an update carries.
 *
 * A call that targets the caller's own role names no role on the wire, and a
 * call that writes nothing names no count; each is left out rather than
 * invented.
 * @param argsRaw - raw argument JSON.
 * @param _output - unused; the manifest body belongs behind the disclosure.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the call names nothing to summarise.
 */
export function manifestSummary(argsRaw: string, _output: string | null, t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  if (args === undefined) return undefined
  const role = roleLabel(args.agent)
  const count = Array.isArray(args.files) && args.files.length > 0
    ? `${args.files.length} ${t('files')}`
    : undefined
  if (role === undefined) return count
  return count === undefined ? role : `${role} · ${count}`
}

/**
 * Collapsed summary for one `reference_extract` call: the PDF it reads.
 * @param argsRaw - raw argument JSON.
 * @param _output - unused; the extraction result belongs behind the disclosure.
 * @param _t - unused; a path needs no copy.
 * @returns the summary, or undefined when the path is absent or unreadable.
 */
export function referenceExtractSummary(argsRaw: string, _output: string | null, _t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  return args === undefined ? undefined : asString(args.path)
}

/**
 * Collapsed summary for one `report_workflow` call: the task and its outcome,
 * with the blockage type when a blocked report carries one.
 * @param argsRaw - raw argument JSON.
 * @param _output - unused; the tool answers with a message id only.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the call is not readable.
 */
export function reportWorkflowSummary(argsRaw: string, _output: string | null, t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  if (args === undefined) return undefined
  const taskId = asString(args.task_id)
  if (taskId === undefined) return undefined
  const status = asString(args.status)
  if (status === 'success') return `${taskId} · ${t('completed')}`
  if (status !== 'blocked') return undefined
  const blockType = asString(args.block_type)
  const blocked = t('blocked')
  return `${taskId} · ${blockType === undefined ? blocked : `${blocked} (${blockType})`}`
}

/**
 * Collapsed summary for one `install_python_package` call: the requirement.
 * @param argsRaw - raw argument JSON.
 * @param _output - unused; the install log belongs behind the disclosure.
 * @param _t - unused; a requirement spec needs no copy.
 * @returns the summary, or undefined when the package is absent or unreadable.
 */
export function installPackageSummary(argsRaw: string, _output: string | null, _t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  return args === undefined ? undefined : asString(args.package)
}

/** Copy key for one settled compile status, or undefined for an unknown one. */
function compileStatusKey(status: string): ToolRowLocaleKey | undefined {
  switch (status) {
    case 'success': return 'succeeded'
    case 'failed': return 'failed'
    case 'timeout': return 'timedOut'
    case 'infrastructure_error': return 'infraError'
    default: return undefined
  }
}

/**
 * Collapsed summary for one `compile_report` call: the entry file, and the
 * settled status once the compile answers.
 * @param argsRaw - raw argument JSON.
 * @param output - flattened result text, or null while still running.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the entry file is absent or unreadable.
 */
export function compileReportSummary(argsRaw: string, output: string | null, t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  const path = args === undefined ? undefined : asString(args.path)
  if (path === undefined) return undefined
  const settled = output === null ? undefined : asObject(parseResult(output))
  const status = settled === undefined ? undefined : asString(settled.status)
  const key = status === undefined ? undefined : compileStatusKey(status)
  return key === undefined ? path : `${path} · ${t(key)}`
}

/**
 * Collapsed summary for one `render_report_page` call: the PDF and the page.
 *
 * The page label's word order differs by locale, so the dictionary carries the
 * number as a `{n}` placeholder instead of the summary assembling it.
 * @param argsRaw - raw argument JSON.
 * @param _output - unused; the rendered page is an image block, not text.
 * @param t - translator for the row's copy.
 * @returns the summary, or undefined when the PDF path is absent or unreadable.
 */
export function renderPageSummary(argsRaw: string, _output: string | null, t: ToolRowText): string | undefined {
  const args = parseArgs(argsRaw)
  if (args === undefined) return undefined
  const path = asString(args.path)
  if (path === undefined) return undefined
  const page = asNumber(args.page)
  return page === undefined ? path : `${path} · ${t('page').replace('{n}', String(page))}`
}
