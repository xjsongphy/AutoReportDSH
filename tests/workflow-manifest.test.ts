import { describe, expect, it, beforeEach } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AUTOREPORT_SCHEMA_VERSION } from '../src/workflow/events.js'
import { projectManifest } from '../src/workflow/manifest.js'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { workflowState } from './helpers/workflow-log.js'
import { sessionIn, workspaceForTests, workflowState } from './helpers/workflow-log.js'

// A fresh workspace per test: fixtures reuse session ids, so a shared root
// would let one test's workflow log leak into the next.
let WORKSPACE = workspaceForTests('workflow-manifest')
beforeEach(() => { WORKSPACE = workspaceForTests('workflow-manifest') })

describe('AutoReport manifest projection', () => {
  it('keeps the original shape while converting internal epoch times to ISO UTC', () => {
    const session = sessionIn(WORKSPACE, 'manifest-main')
    appendWorkflowEvent(session, 'autoreport/artifact', {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      producedBy: 'THEORY',
      origin: 'fs-tool',
      status: 'created',
      recordedAt: 1_756_634_400_000,
    })
    appendWorkflowEvent(session, 'autoreport/artifact', {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      producedBy: 'THEORY',
      origin: 'fs-tool',
      status: 'modified',
      recordedAt: 1_756_634_451_000,
    })
    appendWorkflowEvent(session, 'autoreport/file-note', {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      description: 'Small-angle theoretical model and derivation.',
      descriptionUpdatedAt: 1_756_634_452_000,
      producedBy: 'THEORY',
    })
    appendWorkflowEvent(session, 'autoreport/role-note', {
      version: AUTOREPORT_SCHEMA_VERSION,
      role: 'THEORY',
      notes: 'Use the fitted parameters from DATA_ANALYSIS.',
      updatedAt: 1_756_634_453_000,
    })

    const manifest = projectManifest(workflowState(session).projection(), 'THEORY', () => 0)
    expect(manifest).toEqual({
      agent_type: 'theory',
      updated_at: '2025-08-31T10:00:53+00:00',
      files: [{
        path: 'Theory/model.md',
        description: 'Small-angle theoretical model and derivation.',
        description_updated_at: '2025-08-31T10:00:52+00:00',
        file_updated_at: '2025-08-31T10:00:51+00:00',
      }],
      notes: 'Use the fitted parameters from DATA_ANALYSIS.',
      notes_updated_at: '2025-08-31T10:00:53+00:00',
    })
  })

  it('returns an empty but valid manifest for a role without artifacts', () => {
    const session = sessionIn(WORKSPACE, 'manifest-empty')
    const manifest = projectManifest(workflowState(session).projection(), 'REPORT', () => 0)
    expect(manifest).toEqual({
      agent_type: 'report',
      updated_at: '1970-01-01T00:00:00+00:00',
      files: [],
      notes: '',
      notes_updated_at: null,
    })
  })
})
