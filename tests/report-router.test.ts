import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  effectiveSandboxMode,
  effectiveSandboxWorkspaceRoot,
} from '@deepseek-ai/dsh-sandbox-policy/src/session-mode.ts'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { Config } from '../src/config.js'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import { installRoutedReportTool } from '../src/tools/report-router.js'
import { installManifestTool } from '../src/tools/manifest.js'
import { installWorkflowReportTool } from '../src/tools/report-workflow.js'
import { roleWritableRoot } from '../src/policy/sandbox-roots.js'
import { seedSyncedResourceStubs } from './helpers/synced-resource-stubs.js'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { WaiterRegistry } from '../src/workflow/waiters.js'

const overlayRoot = seedSyncedResourceStubs(mkdtempSync(join(tmpdir(), 'autoreport-router-overlay-')))
afterAll(() => rmSync(overlayRoot, { recursive: true, force: true }))

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: 600_000,
}

function childContext(id = 'child-1', cwd?: string) {
  const tools: { name: string }[] = []
  const skills: { name: string }[] = []
  const sections: { name: string; text: string }[] = []
  const providers: string[] = []
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: Date.now(),
    cwd: cwd ?? '/tmp/autoreport-workspace',
  })
  const skillsService = {
    register: (skill: { name: string }) => {
      skills.push(skill)
      return () => {}
    },
    registerProvider: (factory: () => { name: string }) => {
      providers.push(factory().name)
      return () => {}
    },
  }
  const ctx = {
    agent: { id: sessionId, session },
    get: (name: string) => name === 'skills' ? skillsService : undefined,
    tools: {
      register: (tool: { name: string }) => {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: { name: string; text: string }) => {
        sections.push(section)
        return () => {}
      },
    },
    skills: skillsService,
  }
  return { ctx: ctx as unknown as Context, tools, skills, sections, providers, session }
}

function hostContext() {
  const reportFrom = vi.fn(async () => 'report-msg')
  return {
    ctx: {
      subagents: { reportFrom },
    } as unknown as Context,
    reportFrom,
  }
}

describe('report router', () => {
  it('installs stock report for ordinary DSH children', () => {
    const child = childContext()
    const host = hostContext()
    installRoutedReportTool(child.ctx, host.ctx, { roleRegistry: new RoleRegistry(), config: CONFIG, workflowForChild: () => undefined, overlayRoot })
    expect(child.tools.map(tool => tool.name)).toEqual(['report'])
    expect(child.sections.some(section => section.name === 'tool:report')).toBe(true)
    expect(child.providers).toEqual([])
  })

  it('installs report_workflow and role sandbox for a pre-bound specialist', () => {
    const workspaceRoot = '/tmp/autoreport-theory-workspace'
    const child = childContext('child-1', workspaceRoot)
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    const binding: RoleBindingSnapshot = {
      version: 1,
      role: 'THEORY',
      childSessionId: SessionId('child-1'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    }
    roleRegistry.registerReserved(binding)
    installRoutedReportTool(child.ctx, host.ctx, { roleRegistry, config: CONFIG, workflowForChild: () => undefined, overlayRoot })
    expect(child.tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow'])
    expect(child.skills).toEqual([])
    expect(child.sections.some(section => section.text.includes('THEORY'))).toBe(true)
    expect(child.tools.some(tool => tool.name === 'report')).toBe(false)
    expect(effectiveSandboxMode(child.session.events)).toBe('workspace-write')
    expect(effectiveSandboxWorkspaceRoot(child.session.events)).toBe(roleWritableRoot(workspaceRoot, 'THEORY'))
    expect(child.providers).toEqual(['autoreport-references'])
  })

  it('installs report_workflow only for REPORT with compile skills', () => {
    const workspaceRoot = '/tmp/autoreport-report-workspace'
    const child = childContext('child-report', workspaceRoot)
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'REPORT',
      childSessionId: SessionId('child-report'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    installRoutedReportTool(child.ctx, host.ctx, { roleRegistry, config: CONFIG, workflowForChild: () => undefined, overlayRoot })
    expect(child.tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow'])
    expect(child.skills.map(skill => skill.name)).toEqual([
      'experiment-report-writer',
      'latex-compile',
    ])
    expect(child.sections.map(section => section.name)).not.toEqual(expect.arrayContaining([
      'autoreport:skill:experiment-report-writer',
      'autoreport:skill:latex-compile',
    ]))
    expect(effectiveSandboxWorkspaceRoot(child.session.events)).toBe(roleWritableRoot(workspaceRoot, 'REPORT'))
    expect(child.providers).toEqual(['autoreport-references'])
  })

  it('skips sandbox apply when the child has no session', () => {
    const tools: { name: string }[] = []
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'PLOTTING',
      childSessionId: SessionId('child-stock'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    const ctx = {
      agent: { id: SessionId('child-stock') },
      tools: {
        register: (tool: { name: string }) => {
          tools.push(tool)
          return () => {}
        },
      },
      systemPrompt: { section: () => () => {} },
      skills: { register: () => () => {} },
      get: () => undefined,
    } as unknown as Context
    installRoutedReportTool(ctx, hostContext().ctx, { roleRegistry, config: CONFIG, workflowForChild: () => undefined, overlayRoot })
    expect(tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow'])
  })
})

describe('report_workflow', () => {
  function toolNamed(tools: { name: string }[], name: string) {
    const tool = tools.find(entry => entry.name === name) as {
      name: string
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
    } | undefined
    if (tool === undefined) throw new Error(`missing tool ${name}`)
    return tool
  }

  it('serializes a validated envelope through reportFrom', async () => {
    const child = childContext()
    const host = hostContext()
    installWorkflowReportTool(child.ctx, host.ctx, 'REPORT')
    const result = await toolNamed(child.tools, 'report_workflow').execute({
      task_id: 'task-3',
      delegation_revision: 2,
      status: 'success',
      response: 'compiled',
      produced_files: ['Report/main.pdf'],
    }, { agent: { id: SessionId('child-1') }, signal: new AbortController().signal })
    expect(result).toEqual({ messageId: 'report-msg' })
    expect(host.reportFrom).toHaveBeenCalledOnce()
    const content = host.reportFrom.mock.calls[0]?.[1] as { type: string; text: string }[]
    expect(content[0]?.text).toContain('REPORT → MAIN')
    expect(content[0]?.text).toContain('Details')
    expect(JSON.parse(content[1]?.text ?? '{}')).toMatchObject({
      task_id: 'task-3',
      delegation_revision: 2,
      status: 'success',
      block_type: null,
      produced_files: ['Report/main.pdf'],
    })
  })

  it('rejects a blocked report missing block_type', async () => {
    const child = childContext()
    const host = hostContext()
    installWorkflowReportTool(child.ctx, host.ctx, 'PLOTTING')
    await expect(toolNamed(child.tools, 'report_workflow').execute({
      task_id: 'task-3',
      delegation_revision: 1,
      status: 'blocked',
      response: 'need data',
    }, { agent: { id: SessionId('child-1') }, signal: new AbortController().signal })).rejects.toThrow(/invalid workflow report/)
    expect(host.reportFrom).not.toHaveBeenCalled()
  })

  function hostWithDirtyTheory() {
    const session = Session.create(SessionId('main'))
    const state = WorkflowState.fromSession(session)
    const waiters = new WaiterRegistry()
    const commit = <T extends keyof import('@deepseek-ai/dsh-session').SessionEventMap & string>(
      type: T,
      data: import('@deepseek-ai/dsh-session').SessionEventMap[T],
    ): void => {
      state.apply(appendWorkflowEvent(session, type, data))
    }
    commit('autoreport/task', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-3',
      subject: 'Derive',
      role: 'THEORY',
      dependencies: [],
      status: 'running',
      revision: 1,
      steps: [],
      scopes: ['Theory'],
      latestDelegationRevision: 1,
    })
    commit('autoreport/delegation', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-3',
      delegationRevision: 1,
      role: 'THEORY',
      childSessionId: SessionId('child-1'),
      phase: 'waiting_for_child',
      dispatchedAt: 1,
    })
    commit('autoreport/artifact', {
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Theory/model.md',
      producedBy: 'THEORY',
      origin: 'fs-tool',
      status: 'created',
      recordedAt: 10,
      taskId: 'task-3',
      delegationKey: 'task-3#1',
    })
    const runtime = {
      workflowForChild: () => ({ session, runtime: { state, waiters } }),
      commit: (
        target: typeof session,
        type: Parameters<typeof appendWorkflowEvent>[1],
        data: Parameters<typeof appendWorkflowEvent>[2],
      ) => {
        const event = appendWorkflowEvent(target, type, data)
        state.apply(event)
        return event
      },
    }
    const reportFrom = vi.fn(async () => 'report-msg')
    return {
      ctx: {
        subagents: { reportFrom },
        get: (name: string) => name === 'autoreportWorkflow' ? runtime : undefined,
      } as unknown as Context,
      reportFrom,
      runtime,
      state,
      session,
    }
  }

  it('rejects success while manifest descriptions are stale, then accepts after manifest update', async () => {
    const child = childContext()
    const host = hostWithDirtyTheory()
    installManifestTool(child.ctx, host.ctx, 'THEORY')
    installWorkflowReportTool(child.ctx, host.ctx, 'THEORY')
    const exec = { agent: { id: SessionId('child-1') }, signal: new AbortController().signal }
    const report = {
      task_id: 'task-3',
      delegation_revision: 1,
      status: 'success',
      response: 'derived',
      produced_files: ['Theory/model.md'],
    }
    await expect(toolNamed(child.tools, 'report_workflow').execute(report, exec))
      .rejects.toThrow(/manifest descriptions are stale/)
    expect(host.reportFrom).not.toHaveBeenCalled()

    const described = await toolNamed(child.tools, 'manifest').execute({
      action: 'update',
      files: [{ path: 'Theory/model.md', description_new: 'linearized pendulum' }],
    }, exec)
    expect(described).toMatchObject({
      status: 'ok',
      description_changes: [{ path: 'Theory/model.md', old: '', new: 'linearized pendulum' }],
      not_found: [],
      description_mismatches: [],
      notes_diff: null,
    })
    expect(host.state.projection().fileNotes.get('Theory/model.md')?.description).toBe('linearized pendulum')

    await expect(toolNamed(child.tools, 'report_workflow').execute(report, exec))
      .resolves.toEqual({ messageId: 'report-msg' })
    expect(host.reportFrom).toHaveBeenCalledOnce()
  })

  it('reads another role manifest but only updates its bound role', async () => {
    const child = childContext()
    const host = hostWithDirtyTheory()
    installManifestTool(child.ctx, host.ctx, 'THEORY')
    const exec = { agent: { id: SessionId('child-1') }, signal: new AbortController().signal }
    const readOther = await toolNamed(child.tools, 'manifest').execute({
      action: 'read',
      agent: 'report',
    }, exec)
    expect(readOther).toMatchObject({
      agent_type: 'report',
      files: [],
      notes: '',
    })

    await expect(toolNamed(child.tools, 'manifest').execute({
      action: 'update',
      agent: 'report',
      files: [],
    }, exec)).rejects.toThrow(/only update theory/)

    const updated = await toolNamed(child.tools, 'manifest').execute({
      action: 'update',
      notes_patch: '+Keep the small-angle assumption visible.\n',
    }, exec)
    expect(updated).toMatchObject({
      status: 'ok',
      notes_diff: '- \n+ Keep the small-angle assumption visible.',
      manifest: {
        agent_type: 'theory',
        notes: 'Keep the small-angle assumption visible.',
      },
    })
  })

  it('returns the accepted reportMessageId without calling reportFrom again', async () => {
    const child = childContext()
    const host = hostWithDirtyTheory()
    host.runtime.commit(host.session, 'autoreport/delegation', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-3',
      delegationRevision: 1,
      role: 'THEORY',
      childSessionId: SessionId('child-1'),
      phase: 'completed',
      dispatchedAt: 1,
      report: {
        task_id: 'task-3',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'already accepted',
        produced_files: ['Theory/model.md'],
      },
      reportMessageId: 'already-accepted',
      settledAt: 99,
    })
    installWorkflowReportTool(child.ctx, host.ctx, 'THEORY')
    await expect(toolNamed(child.tools, 'report_workflow').execute({
      task_id: 'task-3',
      delegation_revision: 1,
      status: 'success',
      response: 'retry after crash',
      produced_files: ['Theory/model.md'],
    }, { agent: { id: SessionId('child-1') }, signal: new AbortController().signal }))
      .resolves.toEqual({ messageId: 'already-accepted' })
    expect(host.reportFrom).not.toHaveBeenCalled()
  })

  it('allows blocked reports even when descriptions are stale', async () => {
    const child = childContext()
    const host = hostWithDirtyTheory()
    installWorkflowReportTool(child.ctx, host.ctx, 'THEORY')
    await expect(toolNamed(child.tools, 'report_workflow').execute({
      task_id: 'task-3',
      delegation_revision: 1,
      status: 'blocked',
      block_type: 'missing_data',
      response: 'need raw csv',
    }, { agent: { id: SessionId('child-1') }, signal: new AbortController().signal }))
      .resolves.toEqual({ messageId: 'report-msg' })
    expect(host.reportFrom).toHaveBeenCalledOnce()
  })
})
