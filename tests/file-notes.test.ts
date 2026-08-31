import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AUTOREPORT_SCHEMA_VERSION, type ArtifactSnapshot, type FileNoteSnapshot } from '../src/workflow/events.js'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import {
  roleHandoffText,
  staleDescribedPaths,
  staleDescribedPathsForDelegation,
} from '../src/workflow/file-notes.js'
import { formatWorkflowRelay } from '../src/workflow/display.js'
import { parseWorkflowEnvelopeFromText } from '../src/workflow/protocol.js'

function artifact(path: string, recordedAt: number, extras: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    version: AUTOREPORT_SCHEMA_VERSION,
    path,
    producedBy: 'THEORY',
    origin: 'fs-tool',
    status: 'modified',
    recordedAt,
    taskId: 'task-1',
    delegationKey: 'task-1#1',
    ...extras,
  }
}

describe('semantic file notes', () => {
  it('folds last-write-wins notes and treats newer artifacts as stale', () => {
    const session = Session.create(SessionId('notes-main'))
    appendWorkflowEvent(session, 'autoreport/delegation', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      delegationRevision: 1,
      role: 'THEORY',
      childSessionId: SessionId('child-theory'),
      phase: 'waiting_for_child',
      dispatchedAt: 10,
    })
    appendWorkflowEvent(session, 'autoreport/task', {
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
    })
    appendWorkflowEvent(session, 'autoreport/artifact', artifact('Theory/model.md', 20))
    appendWorkflowEvent(session, 'autoreport/file-note', {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      description: 'old',
      descriptionUpdatedAt: 15,
      producedBy: 'THEORY',
    })
    appendWorkflowEvent(session, 'autoreport/file-note', {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      description: 'linearized pendulum',
      descriptionUpdatedAt: 30,
      producedBy: 'THEORY',
      notes: 'small-angle',
    })
    const state = WorkflowState.fromEvents(session.events)
    expect(state.projection().fileNotes.get('Theory/model.md')?.description).toBe('linearized pendulum')
    expect(staleDescribedPaths(state.projection(), SessionId('child-theory'))).toEqual([])

    appendWorkflowEvent(session, 'autoreport/artifact', artifact('Theory/model.md', 40))
    const later = WorkflowState.fromEvents(session.events)
    expect(staleDescribedPaths(later.projection(), SessionId('child-theory'))).toEqual(['Theory/model.md'])
  })

  it('lists files with no description as stale', () => {
    const session = Session.create(SessionId('stale-main'))
    appendWorkflowEvent(session, 'autoreport/task', {
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
    })
    const delegation = {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      delegationRevision: 1,
      role: 'THEORY' as const,
      childSessionId: SessionId('child-theory'),
      phase: 'waiting_for_child' as const,
      dispatchedAt: 10,
    }
    appendWorkflowEvent(session, 'autoreport/delegation', delegation)
    appendWorkflowEvent(session, 'autoreport/artifact', artifact('Theory/equations.md', 20))
    const projection = WorkflowState.fromEvents(session.events).projection()
    expect(staleDescribedPathsForDelegation(projection, delegation)).toEqual(['Theory/equations.md'])
  })

  it('builds a bounded role handoff from notes and prior tasks', () => {
    const session = Session.create(SessionId('handoff-main'))
    appendWorkflowEvent(session, 'autoreport/artifact', artifact('Theory/model.md', 20))
    const note: FileNoteSnapshot = {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      description: 'linearized model',
      descriptionUpdatedAt: 25,
      producedBy: 'THEORY',
      notes: 'neglect friction',
    }
    appendWorkflowEvent(session, 'autoreport/file-note', note)
    appendWorkflowEvent(session, 'autoreport/task', {
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
    })
    appendWorkflowEvent(session, 'autoreport/delegation', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      delegationRevision: 1,
      role: 'THEORY',
      childSessionId: SessionId('child-old'),
      phase: 'completed',
      report: {
        task_id: 'task-1',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'Derived the linearized model.',
        produced_files: ['Theory/model.md'],
      },
    })
    const text = roleHandoffText(WorkflowState.fromEvents(session.events).projection(), 'THEORY')
    expect(text).toContain('Role memory for THEORY')
    expect(text).toContain('Theory/model.md: linearized model')
    expect(text).toContain('neglect friction')
    expect(text).toContain('task-1 (completed): Derived the linearized model.')
  })
})

describe('workflow relay display', () => {
  it('formats a completed report without exposing protocol keys in the prefix', () => {
    const text = formatWorkflowRelay('THEORY', {
      task_id: 'task-2',
      delegation_revision: 1,
      status: 'success',
      block_type: null,
      response: 'Derived the linearized model.',
      produced_files: ['Theory/model.md', 'Theory/equations.md'],
    })
    expect(text).toContain('THEORY → MAIN')
    expect(text).toContain('task-2 completed')
    expect(text).toContain('Theory/equations.md')
    expect(text).not.toContain('delegation_revision')
  })

  it('extracts a JSON envelope after a human prefix', () => {
    const envelope = {
      task_id: 'task-2',
      delegation_revision: 1,
      status: 'success',
      block_type: null,
      response: 'done',
      produced_files: ['Theory/model.md'],
    }
    const parsed = parseWorkflowEnvelopeFromText(`✓ THEORY → MAIN\n\nDetails\n${JSON.stringify(envelope)}`)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.task_id).toBe('task-2')
  })
})
