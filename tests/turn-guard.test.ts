import { beforeEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import { AUTOREPORT_SCHEMA_VERSION, type DelegationSnapshot, type TaskSnapshot } from '../src/workflow/events.js'
import type { WorkflowProjection } from '../src/workflow/service.js'
import {
  acknowledgeCurrentBlockedKeys,
  newlyBlockedTaskKeys,
  resetAcknowledgedBlockedKeys,
  shouldSteerMain,
  shouldSteerSpecialist,
} from '../src/workflow/turn-guard.js'

function projection(tasks: TaskSnapshot[], delegations: DelegationSnapshot[]): WorkflowProjection {
  return {
    meta: undefined,
    tasks: new Map(tasks.map(task => [task.taskId, task])),
    delegations: new Map(delegations.map(item => [`${item.taskId}#${item.delegationRevision}`, item])),
    bindingsByChild: new Map(),
    bindingsByRole: new Map(),
    artifacts: [],
  }
}

function blockedTask(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    version: AUTOREPORT_SCHEMA_VERSION,
    taskId: 'task-9',
    subject: 'Need data',
    role: 'DATA_ANALYSIS',
    dependencies: [],
    status: 'blocked',
    revision: 2,
    steps: [],
    scopes: ['Data/Processed'],
    blockedReason: 'missing csv',
    ...overrides,
  }
}

describe('turn-stopping guards', () => {
  beforeEach(() => {
    resetAcknowledgedBlockedKeys()
  })
  it('steers a bound specialist with an unanswered delegation up to twice', () => {
    const registry = new RoleRegistry()
    const child = SessionId('child-theory')
    registry.registerReserved({
      version: AUTOREPORT_SCHEMA_VERSION,
      role: 'THEORY',
      childSessionId: child,
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    const tasks: TaskSnapshot[] = [{
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      subject: 'Derive',
      role: 'THEORY',
      dependencies: [],
      status: 'running',
      revision: 1,
      steps: [],
      scopes: ['Theory'],
      latestDelegationRevision: 1,
    }]
    const delegations: DelegationSnapshot[] = [{
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      delegationRevision: 1,
      role: 'THEORY',
      childSessionId: child,
      phase: 'waiting_for_child',
      dispatchedAt: 1,
    }]
    const fold = projection(tasks, delegations)
    expect(shouldSteerSpecialist(registry, child, fold, 0)).toBe(true)
    expect(shouldSteerSpecialist(registry, child, fold, 1)).toBe(true)
    expect(shouldSteerSpecialist(registry, child, fold, 2)).toBe(false)
    expect(shouldSteerSpecialist(registry, SessionId('foreign'), fold, 0)).toBe(false)
  })

  it('does not steer after an accepted report exists', () => {
    const registry = new RoleRegistry()
    const child = SessionId('child-theory')
    registry.registerReserved({
      version: AUTOREPORT_SCHEMA_VERSION,
      role: 'THEORY',
      childSessionId: child,
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'active',
    })
    const fold = projection([{
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      subject: 'Derive',
      role: 'THEORY',
      dependencies: [],
      status: 'completed',
      revision: 2,
      steps: [],
      scopes: ['Theory'],
      latestDelegationRevision: 1,
    }], [{
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      delegationRevision: 1,
      role: 'THEORY',
      childSessionId: child,
      phase: 'completed',
      dispatchedAt: 1,
      report: {
        task_id: 'task-1',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'done',
        produced_files: [],
      },
    }])
    expect(shouldSteerSpecialist(registry, child, fold, 0)).toBe(false)
  })

  it('steers MAIN once when a blocked task is newly received', () => {
    const fold = projection([blockedTask()], [])
    expect(newlyBlockedTaskKeys('main-a', fold)).toEqual(['task-9#2'])
    expect(shouldSteerMain(fold, 0, newlyBlockedTaskKeys('main-a', fold).length > 0)).toBe(true)
    expect(shouldSteerMain(fold, 1, newlyBlockedTaskKeys('main-a', fold).length > 0)).toBe(false)
    expect(shouldSteerMain(projection([], []), 0, false)).toBe(false)
  })

  it('does not steer MAIN for a historical blocked task already acknowledged', () => {
    const fold = projection([blockedTask()], [])
    acknowledgeCurrentBlockedKeys('main-a', fold)
    expect(newlyBlockedTaskKeys('main-a', fold)).toEqual([])
    expect(shouldSteerMain(fold, 0, newlyBlockedTaskKeys('main-a', fold).length > 0)).toBe(false)
  })

  it('does not re-steer MAIN after acknowledging the same blocked revision', () => {
    const fold = projection([blockedTask()], [])
    expect(shouldSteerMain(fold, 0, newlyBlockedTaskKeys('main-a', fold).length > 0)).toBe(true)
    acknowledgeCurrentBlockedKeys('main-a', fold)
    expect(shouldSteerMain(fold, 0, newlyBlockedTaskKeys('main-a', fold).length > 0)).toBe(false)
  })

  it('steers MAIN again when a blocked task is re-blocked at a new revision', () => {
    const fold = projection([blockedTask()], [])
    acknowledgeCurrentBlockedKeys('main-a', fold)
    const reblocked = projection([blockedTask({ revision: 3 })], [])
    expect(newlyBlockedTaskKeys('main-a', reblocked)).toEqual(['task-9#3'])
    expect(shouldSteerMain(reblocked, 0, newlyBlockedTaskKeys('main-a', reblocked).length > 0)).toBe(true)
  })

  it('caps MAIN steers per turn even when a blocked task is newly received', () => {
    const fold = projection([blockedTask()], [])
    expect(shouldSteerMain(fold, 0, true)).toBe(true)
    expect(shouldSteerMain(fold, 1, true)).toBe(false)
  })

  it('isolates blocked acknowledgment per Main session', () => {
    const fold = projection([blockedTask()], [])
    acknowledgeCurrentBlockedKeys('main-a', fold)
    expect(newlyBlockedTaskKeys('main-a', fold)).toEqual([])
    expect(newlyBlockedTaskKeys('main-b', fold)).toEqual(['task-9#2'])
    acknowledgeCurrentBlockedKeys('main-b', projection([], []))
    expect(newlyBlockedTaskKeys('main-a', fold)).toEqual([])
    expect(newlyBlockedTaskKeys('main-b', fold)).toEqual(['task-9#2'])
  })
})
