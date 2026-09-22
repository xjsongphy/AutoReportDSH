import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence/src/storage-contract.ts'
import {
  WORKFLOW_LOG_FILENAME,
  appendWorkflowEvent,
  encodeSegment,
  readWorkflowLog,
  resetWorkflowLogs,
  seedWorkflowLog,
  workflowLogPath,
} from '../src/workflow/store.js'
import { AUTOREPORT_RECORD_TYPES } from '../src/workflow/events.js'
import { workspaceIdForRoot } from '../src/settings.js'
import { sessionIn, workspaceForTests } from './helpers/workflow-log.js'

const WORKSPACE = mkdtempSync(join(tmpdir(), 'autoreport-store-'))
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }))
afterEach(() => { resetWorkflowLogs() })

const TASK = {
  version: 1,
  taskId: 'task-1',
  subject: 'derive',
  role: 'THEORY' as const,
  dependencies: [],
  status: 'open' as const,
  revision: 1,
  steps: [],
  scopes: ['Theory'],
  latestDelegationRevision: 0,
}

describe('encodeSegment', () => {
  it('keeps DSH-safe code units literal', () => {
    expect(encodeSegment('session-934f61cd-21bc')).toBe('session-934f61cd-21bc')
    expect(encodeSegment('a.b_c-d')).toBe('a.b_c-d')
  })

  it('escapes every unsafe code unit as ~XXXX, matching DSH', () => {
    // Values mirrored from session-persistence-jsonl's own rule, so a change
    // upstream shows up here rather than silently forking our layout.
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('~')).toBe('~007E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
    expect(encodeSegment('a b')).toBe('a~0020b')
    expect(encodeSegment('x:y')).toBe('x~003Ay')
    expect(encodeSegment('../etc')).toBe('..~002Fetc')
    expect(encodeSegment('é')).toBe('~00E9')
  })

  it('refuses an empty segment', () => {
    expect(() => encodeSegment('')).toThrow(/empty path segment/)
  })
})

describe('workflowLogPath', () => {
  it('keys the log by workspace under the harness home, never inside the workspace', () => {
    const path = workflowLogPath(undefined, '/exp', 'session-abc')
    expect(path).toBe(join(
      resolveDshHome(),
      'autoreport',
      workspaceIdForRoot('/exp'),
      'workflow',
      'session-abc',
      WORKFLOW_LOG_FILENAME,
    ))
    expect(path.startsWith('/exp/')).toBe(false)
  })

  it('honours an explicit harness home', () => {
    expect(workflowLogPath('/home/x', '/exp', 'session-abc')).toBe(join(
      '/home/x', 'autoreport', workspaceIdForRoot('/exp'), 'workflow', 'session-abc', WORKFLOW_LOG_FILENAME,
    ))
  })

  it('cannot escape the session directory through a hostile session id', () => {
    const dir = join(resolveDshHome(), 'autoreport', workspaceIdForRoot('/exp'), 'workflow')
    // The id collapses to ONE segment: separators and dots are escaped, so no
    // traversal is expressible.
    expect(workflowLogPath(undefined, '/exp', '../../etc/passwd')).toBe(
      join(dir, '..~002F..~002Fetc~002Fpasswd', WORKFLOW_LOG_FILENAME),
    )
  })
})

describe('appendWorkflowEvent / readWorkflowLog', () => {
  it('round-trips a record with its type, sequence, timestamp, and payload', () => {
    const session = sessionIn(WORKSPACE, 'round-trip')
    const before = Date.now()
    const written = appendWorkflowEvent(session, 'autoreport/task', TASK)
    const records = readWorkflowLog(workflowLogPath(undefined, WORKSPACE, 'round-trip'))

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual(written)
    expect(records[0]?.type).toBe('autoreport/task')
    expect(records[0]?.seq).toBe(1)
    expect(records[0]?.data).toEqual(TASK)
    expect(records[0]?.time).toBeGreaterThanOrEqual(before)
  })

  it('writes the header exactly once, before the first record', () => {
    const session = sessionIn(WORKSPACE, 'header')
    appendWorkflowEvent(session, 'autoreport/task', TASK)
    appendWorkflowEvent(session, 'autoreport/task', { ...TASK, revision: 2 })
    const lines = readFileSync(workflowLogPath(undefined, WORKSPACE, 'header'), 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
    const headers = lines.filter(line => (JSON.parse(line) as { type: string }).type === 'session')
    expect(headers).toHaveLength(1)
    expect(JSON.parse(lines[0]!).id).toBe('header')
    // Reading skips the header and returns only records.
    expect(readWorkflowLog(workflowLogPath(undefined, WORKSPACE, 'header'))).toHaveLength(2)
  })

  it('numbers records monotonically and continues an existing log', () => {
    const session = sessionIn(WORKSPACE, 'sequence')
    appendWorkflowEvent(session, 'autoreport/task', TASK)
    appendWorkflowEvent(session, 'autoreport/task', { ...TASK, revision: 2 })
    // A cold start (fresh process) must continue the file, not restart at 1.
    resetWorkflowLogs()
    appendWorkflowEvent(session, 'autoreport/task', { ...TASK, revision: 3 })
    expect(readWorkflowLog(workflowLogPath(undefined, WORKSPACE, 'sequence')).map(record => record.seq)).toEqual([1, 2, 3])
  })

  it('treats a missing log as empty and skips a torn line instead of losing the file', () => {
    expect(readWorkflowLog(workflowLogPath(undefined, WORKSPACE, 'absent'))).toEqual([])

    const session = sessionIn(WORKSPACE, 'torn')
    appendWorkflowEvent(session, 'autoreport/task', TASK)
    const path = workflowLogPath(undefined, WORKSPACE, 'torn')
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"autoreport/task","seq":9,"time":1,`)
    // The good record survives; the truncated append is dropped and the next
    // write continues past it.
    expect(readWorkflowLog(path).map(record => record.seq)).toEqual([1])
    resetWorkflowLogs()
    seedWorkflowLog(path, readWorkflowLog(path))
    appendWorkflowEvent(session, 'autoreport/task', { ...TASK, revision: 4 })
    expect(readWorkflowLog(path).map(record => record.seq)).toEqual([1, 2])
  })

  it('ignores a line whose type this build does not know', () => {
    const session = sessionIn(WORKSPACE, 'unknown-type')
    appendWorkflowEvent(session, 'autoreport/task', TASK)
    const path = workflowLogPath(undefined, WORKSPACE, 'unknown-type')
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"type":"autoreport/future","seq":2,"time":1,"data":{}}\n`)
    expect(readWorkflowLog(path)).toHaveLength(1)
  })

  it('fails loud when the session has no workspace to write into', () => {
    const session = Session.create(SessionId('rootless'))
    expect(() => appendWorkflowEvent(session, 'autoreport/task', TASK))
      .toThrow(/cannot locate its workflow log/)
  })
})

describe('the session log stays within DSH vocabulary', () => {
  it('writes no autoreport record into the session log', () => {
    const session = sessionIn(WORKSPACE, 'vocabulary')
    session.append('turn/start', { turn: 1 })
    for (const type of AUTOREPORT_RECORD_TYPES) {
      const data = type === 'autoreport/task' ? TASK : {}
      appendWorkflowEvent(session, type, data as never)
    }
    const types = session.snapshotEvents().map(event => event.type)
    expect(types.some(type => type.startsWith('autoreport/'))).toBe(false)
  })

  it('produces a session log a stock dsh loads with its vocabulary untouched', () => {
    // The acceptance criterion for keeping AutoReport state out of the host
    // log: the first-party reader accepts the log with NO registration step and
    // no per-record marker, because every type in it is DSH's own.
    const session = sessionIn(WORKSPACE, 'stock-load')
    session.append('turn/start', { turn: 1 })
    appendWorkflowEvent(session, 'autoreport/task', TASK)
    const before = new Set(KNOWN_SESSION_EVENT_TYPES)
    expect(() => validateStoredEvents(session.header, [...session.snapshotEvents()])).not.toThrow()
    expect([...KNOWN_SESSION_EVENT_TYPES]).toEqual([...before])
  })
})
