/**
 * Test access to the plugin's own workflow log.
 *
 * AutoReport keeps its durable records in `<home>/autoreport/<workspaceId>/…`,
 * not in the DSH session log, so a test that wants to inspect or fold workflow
 * state reads that file. `session.header.cwd` is the workspace root in every
 * test fixture, which is also the writer's own default; suite setup pins
 * `$DSH_HOME` to a temp directory so neither side touches a real home.
 * @module tests/helpers/workflow-log
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, Session, SessionId, type Session as SessionType } from '@deepseek-ai/dsh-session'
import { readWorkflowLog, workflowLogPath, type WorkflowRecord } from '../../src/workflow/store.js'
import { WorkflowState } from '../../src/workflow/service.js'

/**
 * A fresh temp workspace for one test module.
 *
 * Workflow records land under the session's own cwd, so a fixture that appends
 * them needs a real directory — and one unique per module, or two files sharing
 * a session id would share a log.
 * @param prefix - short module label used in the directory name.
 * @returns the absolute workspace root.
 */
export function workspaceForTests(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `autoreport-${prefix}-`))
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort: a leaked temp directory must never fail a test run.
    }
  })
  return dir
}

/**
 * A session rooted in `workspace`, shaped like this suite's other fixtures.
 * @param workspace - absolute workspace root the session's log lives under.
 * @param id - session id.
 * @param parentSession - set for a specialist child fixture.
 * @returns the created session.
 */
export function sessionIn(workspace: string, id: string, parentSession?: SessionId): SessionType {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd: workspace,
    ...(parentSession === undefined ? {} : { parentSession }),
  })
}

/**
 * Every record in one session's workflow log, in file order.
 *
 * The log lives under the harness home, keyed by workspace. Suite setup pins
 * `$DSH_HOME` to a temp directory, so the default resolution here matches what
 * the writer used; an explicit home overrides it.
 * @param session - the MAIN session whose log to read.
 * @param settingsHome - harness home override; absent resolves like the writer.
 * @returns the committed records; empty when no log exists yet.
 */
export function workflowRecords(session: Session, settingsHome?: string): WorkflowRecord[] {
  const root = session.header.cwd
  if (root === undefined || root.length === 0) return []
  return readWorkflowLog(workflowLogPath(settingsHome, root, String(session.id)))
}

/**
 * Fold one session's workflow log, the way the runtime does on cold load.
 * @param session - the MAIN session whose log to fold.
 * @param settingsHome - harness home the log was written under.
 * @returns the folded workflow state.
 */
export function workflowState(session: Session, settingsHome?: string): WorkflowState {
  return WorkflowState.fromRecords(workflowRecords(session, settingsHome))
}
