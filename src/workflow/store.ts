/**
 * AutoReport's durable workflow log: the single writer and reader seam for
 * every `autoreport/*` record.
 *
 * The plugin keeps its workflow state in a log it owns, under the harness home,
 * and writes **nothing** of its own into the DSH session log. That
 * is deliberate. A session log carrying third-party event types is refused by
 * DSH's persistence reader unless each record bears the envelope's `ignorable`
 * marker; that write option no longer exists on `Session.append` (it now
 * accepts options only for surface event types), and upstream states that
 * event-name registration "was rejected because it does not classify omission
 * safety and would make reads composition-dependent". Keeping our records out
 * of the host log is therefore the only arrangement in which every harness
 * build — plain, current, or future — loads our sessions unmodified.
 *
 * Layout, mirroring DSH's own session artifacts (`session-persistence-jsonl`):
 *
 * ```text
 * <home>/autoreport/<workspaceId>/workflow/<encoded main session id>/session.jsonl
 * ```
 *
 * State sits under the harness home, keyed by workspace, never inside the
 * experiment workspace. That is the arrangement AutoReportCLI used
 * (`~/.autoreport/workspaces/<id>/…`); it also stays clear of `.autoreport`, which the ported
 * policy reserves as a NON-writable workspace directory. `session.jsonl` is
 * DSH's generation-zero log name, so a future incompatible record format adds
 * `session.v1.jsonl` beside it under the same rule.
 *
 * @module autoreport/workflow-store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import { workspaceIdForRoot } from '../settings.js'
import type { AutoReportRecordMap, AutoReportRecordType } from './events.js'
import { AUTOREPORT_RECORD_TYPES } from './events.js'

/** DSH's generation-zero session log name, reused for our own record stream. */
export const WORKFLOW_LOG_FILENAME = 'session.jsonl'

/**
 * Format version of the record stream itself, independent of
 * {@link AUTOREPORT_SCHEMA_VERSION}. Bumping it means the record shape broke
 * incompatibly and the file must move to a `session.vN.jsonl` generation.
 */
export const WORKFLOW_LOG_VERSION = 1

/** Header line written once, before the first record. */
interface WorkflowLogHeader {
  readonly type: 'session'
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
}

/**
 * One durable AutoReport record, as stored and as replayed.
 *
 * A distributive mapped union rather than a generic interface, so narrowing on
 * a record's `type` also narrows its `data` — which is what lets the fold in
 * `workflow/service.ts` stay a plain `switch`.
 */
export type WorkflowRecord<T extends AutoReportRecordType = AutoReportRecordType> = {
  [K in AutoReportRecordType]: {
    readonly type: K
    /** Monotonic sequence within this log; assigned by {@link appendWorkflowEvent}. */
    readonly seq: number
    /** Epoch milliseconds, the point-in-time this record was committed. */
    readonly time: number
    readonly data: AutoReportRecordMap[K]
  }
}[T]

/**
 * Escape one string into a single filesystem-safe path segment, mirroring
 * DSH's `encodeSegment`.
 *
 * The rule is reimplemented rather than imported: `session-persistence-jsonl`
 * is not a dependency of this package and does not export its `format` module,
 * so importing it would mean reaching into another package's internals — the
 * class of coupling this project already retired once. A test pins the rule
 * against DSH's own values, so drift is caught rather than assumed.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)
      ? ch
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Where one session's workflow log lives. */
export interface WorkflowLogLocation {
  /** Harness home that owns plugin state; absent resolves the running DSH home. */
  readonly settingsHome?: string | undefined
  /** Experiment workspace keying the log; absent uses the session's own cwd. */
  readonly workspaceRoot?: string | undefined
}

/**
 * Absolute path of one AutoReport log.
 *
 * State lives under the harness home, keyed by workspace, never inside the
 * experiment workspace — the same arrangement AutoReportCLI used
 * (`~/.autoreport/workspaces/<id>/{manifests,taskboard.json,project.toml}`). Keeping
 * it out of the workspace also keeps it clear of `.autoreport`, which the ported
 * policy reserves as a NON-writable workspace directory.
 * @param settingsHome - harness home override; absent resolves `$DSH_HOME`.
 * @param workspaceRoot - absolute experiment workspace root.
 * @param mainSessionId - the owning MAIN session id.
 * @returns `<home>/autoreport/<workspaceId>/workflow/<id>/session.jsonl`.
 */
export function workflowLogPath(
  settingsHome: string | undefined,
  workspaceRoot: string,
  mainSessionId: string,
): string {
  return join(
    settingsHome === undefined ? resolveDshHome() : settingsHome,
    'autoreport',
    workspaceIdForRoot(workspaceRoot),
    'workflow',
    encodeSegment(mainSessionId),
    WORKFLOW_LOG_FILENAME,
  )
}

/** Whether one parsed line is a well-formed record of a type this build knows. */
function isRecord(value: unknown): value is WorkflowRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  return typeof candidate.type === 'string'
    && (AUTOREPORT_RECORD_TYPES as readonly string[]).includes(candidate.type)
    && typeof candidate.seq === 'number'
    && typeof candidate.time === 'number'
    && typeof candidate.data === 'object' && candidate.data !== null
}

/**
 * Read one workflow log.
 *
 * A missing file is an empty log, not an error: every workspace starts without
 * one. A malformed line is skipped rather than fatal — a torn final append must
 * not cost the whole workflow, and every record is an independently replayable
 * whole snapshot, so a skipped line loses only that mutation.
 * @param path - absolute log path from {@link workflowLogPath}.
 * @returns the committed records in file order.
 */
export function readWorkflowLog(path: string): WorkflowRecord[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const records: WorkflowRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeOfLine(parsed) === 'session') continue
    if (isRecord(parsed)) records.push(parsed)
  }
  return records
}

function typeOfLine(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

/** The next sequence number for a log whose records are `records`. */
function nextSeq(records: readonly WorkflowRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.seq), 0) + 1
}

/** Per-session sequence state, so an append never re-reads the whole log. */
const logSeq = new Map<string, number>()

/**
 * Append one AutoReport record to its log.
 *
 * The header line is written when the log is created, so a reader always knows
 * which session and workspace a file belongs to without guessing from the path.
 * Writes are synchronous and append-only, matching the host's own durability
 * model for this data.
 * @param session - the owning MAIN session.
 * @param type - one of the AutoReport record types.
 * @param data - complete payload snapshot; must be JSON-serializable.
 * @param location - harness home and workspace; each absent value falls back to
 *   the running home and the session's own cwd, which IS the workspace for a
 *   MAIN session unless composition configured an explicit `workspaceRoot`.
 * @returns the committed record, carrying its assigned `seq` and `time`.
 */
export function appendWorkflowEvent<T extends AutoReportRecordType>(
  session: Session,
  type: T,
  data: AutoReportRecordMap[T],
  location: WorkflowLogLocation = {},
): WorkflowRecord<T> {
  const workspaceRoot = location.workspaceRoot ?? session.header.cwd
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    throw new Error('AutoReport cannot locate its workflow log: the session has no workspace root')
  }
  const path = workflowLogPath(location.settingsHome, workspaceRoot, String(session.id))
  mkdirSync(dirname(path), { recursive: true })
  const seq = logSeq.get(path) ?? nextSeq(readWorkflowLog(path))
  const record = { type, seq, time: Date.now(), data } as WorkflowRecord<T>
  const header = seq === 1 ? workflowLogHeader(session) : undefined
  // A leading newline terminates a line torn by a previous crashed append:
  // without it the new record would concatenate onto the partial tail and the
  // reader would drop both. Needed only when bytes are already there, so a
  // brand-new log still starts clean. The reader skips empty lines.
  const separator = existsSync(path) ? '\n' : ''
  appendFileSync(path, `${separator}${header === undefined ? '' : `${JSON.stringify(header)}\n`}${JSON.stringify(record)}\n`)
  logSeq.set(path, seq + 1)
  return record
}

function workflowLogHeader(session: Session): WorkflowLogHeader {
  return {
    type: 'session',
    version: WORKFLOW_LOG_VERSION,
    id: String(session.id),
    createdAt: Date.now(),
    ...(typeof session.header.cwd === 'string' ? { cwd: session.header.cwd } : {}),
  }
}

/**
 * Seed the in-memory sequence for one log after an external replay, so the next
 * {@link appendWorkflowEvent} continues the file instead of restarting at 1.
 * @param path - absolute log path.
 * @param records - records the caller just replayed.
 */
export function seedWorkflowLog(path: string, records: readonly WorkflowRecord[]): void {
  logSeq.set(path, nextSeq(records))
}

/** Drop cached sequence state, e.g. when a workspace is torn down (tests). */
export function resetWorkflowLogs(): void {
  logSeq.clear()
}
