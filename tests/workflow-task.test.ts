import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { AUTOREPORT_MAIN_PRESET } from '../src/membership.js'
import { resetWorkflowLogs } from '../src/workflow/store.js'
import {
  admitFirstTurn,
  assemble,
  type Assembled,
  dispatch,
  disposeAssembled,
  execute,
  reportWorkflow,
  specialistWrite,
  updateManifest,
} from './helpers/assembled-host.js'

const assembledHosts: Assembled[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const assembled of assembledHosts.splice(0)) await disposeAssembled(assembled)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetWorkflowLogs()
})

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

async function boot(workspaceRoot: string, home: string, mainSessionId: string): Promise<Assembled> {
  const assembled = await assemble({ workspaceRoot, home, mainSessionId })
  assembledHosts.push(assembled)
  return assembled
}

function restoredMainSession(workspaceRoot: string, id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: sessionId,
    createdAt: Date.now(),
    cwd: workspaceRoot,
    agentPreset: AUTOREPORT_MAIN_PRESET,
  })
}

describe('workflow_task and durable redispatch', () => {
  it('cancels, reopens, redispatches the same task, and rejects reopening completion', async () => {
    const assembled = await boot(tempDir('autoreport-task-workspace-'), tempDir('autoreport-task-home-'), 'task-transition-main')
    admitFirstTurn(assembled)

    const first = await dispatch(assembled, { role: 'THEORY', prompt: 'derive the model' })
    const taskId = String(first.value.task_id)
    expect(Number(first.value.delegation_revision)).toBe(1)
    expect(assembled.runtime.forSession(assembled.mainSession).state.getTask(taskId)?.status).toBe('running')

    const update = await execute(assembled.ctx, 'workflow_task', {
      action: 'update', task_id: taskId,
      steps: [{ description: 'derive the model', done: true }, { description: 'check dimensions' }],
    }, assembled.mainAgent, assembled.mainSession)
    expect(update.isError, update.text).toBe(false)
    expect(assembled.runtime.forSession(assembled.mainSession).state.getTask(taskId)).toMatchObject({
      status: 'running',
      revision: 3,
      steps: [{ description: 'derive the model', done: true }, { description: 'check dimensions', done: false }],
    })

    const cancel = await execute(assembled.ctx, 'workflow_task', {
      action: 'cancel', task_id: taskId,
    }, assembled.mainAgent, assembled.mainSession)
    expect(cancel.isError, cancel.text).toBe(false)
    expect(assembled.runtime.forSession(assembled.mainSession).state.currentDelegation(taskId)?.phase).toBe('cancelled')

    const reopen = await execute(assembled.ctx, 'workflow_task', {
      action: 'reopen', task_id: taskId,
    }, assembled.mainAgent, assembled.mainSession)
    expect(reopen.isError, reopen.text).toBe(false)
    expect(assembled.runtime.forSession(assembled.mainSession).state.getTask(taskId)?.status).toBe('pending')

    const retry = await dispatch(assembled, { role: 'THEORY', task_id: taskId, prompt: 'continue the derivation' })
    expect(retry.childId).toBe(first.childId)
    expect(Number(retry.value.delegation_revision)).toBe(2)
    expect(assembled.runtime.forSession(assembled.mainSession).state.currentDelegation(taskId)?.phase).toBe('waiting_for_child')

    const complete = await reportWorkflow(assembled, retry, {
      task_id: taskId,
      delegation_revision: 2,
      status: 'success',
      response: 'the derivation is complete',
    })
    expect(complete.isError, complete.text).toBe(false)

    const rejectedReopen = await execute(assembled.ctx, 'workflow_task', {
      action: 'reopen', task_id: taskId,
    }, assembled.mainAgent, assembled.mainSession)
    expect(rejectedReopen.isError).toBe(true)
    expect(assembled.runtime.forSession(assembled.mainSession).state.getTask(taskId)?.status).toBe('completed')
  })

  it('reloads blocked workflow records into a fresh runtime and redispatches the bound child', async () => {
    const workspaceRoot = tempDir('autoreport-restart-workspace-')
    const home = tempDir('autoreport-restart-home-')
    const mainSessionId = 'restart-main-session'
    const firstRuntime = await boot(workspaceRoot, home, mainSessionId)
    admitFirstTurn(firstRuntime)

    const child = await dispatch(firstRuntime, { role: 'THEORY', prompt: 'derive from the supplied procedure' })
    const taskId = String(child.value.task_id)
    await specialistWrite(firstRuntime, child, 'Theory/model.md', '# Pendulum model\n')
    const manifest = await updateManifest(firstRuntime, child, [
      { path: 'Theory/model.md', description: 'Small-angle pendulum model and assumptions.' },
    ])
    expect(manifest.isError, manifest.text).toBe(false)
    const blocked = await reportWorkflow(firstRuntime, child, {
      task_id: taskId,
      delegation_revision: 1,
      status: 'blocked',
      block_type: 'missing_data',
      response: 'waiting for the measured length series',
      produced_files: ['Theory/model.md'],
    })
    expect(blocked.isError, blocked.text).toBe(false)

    // Clear the process-local sequence cache, then construct a new host and a
    // new Session object as DSH does when it restores a saved conversation.
    resetWorkflowLogs()
    const restored = await assemble({
      workspaceRoot,
      home,
      mainSession: restoredMainSession(workspaceRoot, mainSessionId),
    })
    assembledHosts.push(restored)
    const recoveredState = restored.runtime.forSession(restored.mainSession).state
    expect(recoveredState.getTask(taskId)).toMatchObject({ status: 'blocked', latestDelegationRevision: 1 })
    expect(recoveredState.currentDelegation(taskId)?.phase).toBe('blocked')
    expect(recoveredState.bindingForRole('THEORY')?.childSessionId).toBe(child.childId)
    expect(recoveredState.projection().artifacts.map(item => item.path)).toContain('Theory/model.md')
    expect(recoveredState.projection().fileNotes.get('Theory/model.md')?.description)
      .toBe('Small-angle pendulum model and assumptions.')

    const reopened = await execute(restored.ctx, 'workflow_task', {
      action: 'reopen', task_id: taskId,
    }, restored.mainAgent, restored.mainSession)
    expect(reopened.isError, reopened.text).toBe(false)
    const retry = await dispatch(restored, { role: 'THEORY', task_id: taskId, prompt: 'continue after restart' })
    expect(retry.childId).toBe(child.childId)
    expect(Number(retry.value.delegation_revision)).toBe(2)

    const completed = await reportWorkflow(restored, retry, {
      task_id: taskId,
      delegation_revision: 2,
      status: 'success',
      response: 'the recovered derivation is complete',
    })
    expect(completed.isError, completed.text).toBe(false)
    expect(recoveredState.getTask(taskId)?.status).toBe('completed')
    expect(recoveredState.currentDelegation(taskId)?.phase).toBe('completed')
  })
})
