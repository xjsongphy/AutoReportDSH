import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { Config } from '../src/config.js'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import { installRoutedReportTool, type RoutedWorkflow } from '../src/tools/report-router.js'
import { ROLE_PROCESS_TOOL } from '../src/roles.js'
import type { AutoReportRecordType } from '../src/workflow/events.js'
import { sessionIn, workspaceForTests, workflowState } from './helpers/workflow-log.js'
import { installManifestTool } from '../src/tools/manifest.js'
import { installWorkflowReportTool } from '../src/tools/report-workflow.js'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { WorkflowState } from '../src/workflow/service.js'
import { WaiterRegistry } from '../src/workflow/waiters.js'
import { workflowState } from './helpers/workflow-log.js'

const WORKSPACE = workspaceForTests('report-router')

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationIdleTimeoutMs: 60_000,
  delegationWaitTimeoutMs: 600_000,
}

/** Read the model-facing description of one registered tool in a test scope. */
function descriptionOf(tools: { name: string }[], name: string): string {
  const tool = tools.find(entry => entry.name === name) as unknown as { description: string } | undefined
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return tool.description
}

/** Read one parameter description from a registered tool in a test scope. */
function parameterDescriptionOf(tools: { name: string }[], name: string, parameter: string): string {
  // `defineTool` stores the compiled JSON Schema, so descriptions live under
  // `properties` rather than on the declared spec.
  const tool = tools.find(entry => entry.name === name) as unknown as
    | { parameters: { properties?: Record<string, { description?: string }> } }
    | undefined
  const description = tool?.parameters?.properties?.[parameter]?.description
  if (description === undefined) throw new Error(`tool ${name} parameter ${parameter} has no description`)
  return description
}

function childContext(id = 'child-1', cwd?: string, options: {
  /** Names already registered in the agent's own scope layer (e.g. a preset-mounted shell). */
  presetTools?: readonly string[]
  /** Extra services `ctx.get` resolves (e.g. shell/shellEnv for compute installs). */
  services?: Record<string, unknown>
} = {}) {
  const tools: { name: string }[] = options.presetTools?.map(name => ({ name })) ?? []
  const skills: { name: string }[] = []
  const sections: { name: string; text: string }[] = []
  const contexts: { name: string; text: string }[] = []
  const providers: string[] = []
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: sessionId,
    createdAt: Date.now(),
    cwd: cwd ?? '/tmp/autoreport-workspace',
    parentSession: SessionId('main'),
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
  const listeners = new Map<string, unknown>()
  const ctx = {
    agent: { id: sessionId, session },
    get: (name: string) => name === 'skills' ? skillsService : options.services?.[name],
    on: (event: string, listener: unknown) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    tools: {
      register: (tool: { name: string }) => {
        // Mirror the scoped registry: one name per scope layer.
        if (tools.some(entry => entry.name === tool.name)) {
          throw new Error(`tool "${tool.name}" is already registered in this scope`)
        }
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: { name: string; text: string }) => {
        sections.push(section)
        return () => {}
      },
      context: (context: { name: string; text: string }) => {
        contexts.push(context)
        return () => {}
      },
      // The numbers only have to be finite and distinct for these assertions.
      getSectionOrder: () => 2900,
      getContextOrder: () => 120,
    },
    skills: skillsService,
  }
  // Installers like the stock pwsh tool read injected services as direct
  // properties (`ctx.shell`), not through `get()`; expose both surfaces.
  Object.assign(ctx, options.services)
  return {
    ctx: ctx as unknown as Context,
    agent: { id: sessionId, session },
    tools,
    skills,
    sections,
    contexts,
    providers,
    session,
    listeners,
  }
}

/**
 * Router inputs mirroring the live runtime's language resolution, so a test
 * never has to restate the contract {@link installRoutedReportTool} depends on.
 */
function routedWorkflow(overrides: Partial<RoutedWorkflow> = {}): RoutedWorkflow {
  return {
    roleRegistry: new RoleRegistry(),
    config: CONFIG,
    workflowForChild: () => undefined,
    reportLanguageForChild: () => CONFIG.defaultReportLanguage,
    ...overrides,
  }
}

function hostContext() {
  const sendMessage = vi.fn(async () => 'report-msg')
  return {
    ctx: {
      subagents: { sendMessage },
    } as unknown as Context,
    sendMessage,
  }
}

describe('report router', () => {
  it('installs nothing for ordinary DSH children', () => {
    // The stock report tool was removed upstream (2026-08-27 unified-steer
    // change); ordinary children keep the base bundle's adjacent-agent
    // messaging, so the router contributes nothing for them.
    const child = childContext()
    const host = hostContext()
    installRoutedReportTool(child.ctx, child.agent as never, host.ctx, routedWorkflow())
    expect(child.tools.map(tool => tool.name)).toEqual([])
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
    installRoutedReportTool(child.ctx, child.agent as never, host.ctx, routedWorkflow({ roleRegistry }))
    expect(child.tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow'])
    // The enum meaning and the notes-patch format are owned by the tool schemas:
    // personas must never restate them (see tests/personas.test.ts).
    expect(descriptionOf(child.tools, 'report_workflow')).toContain('missing_data')
    expect(descriptionOf(child.tools, 'report_workflow')).toContain('quality')
    // Small models must see the concrete call shape and the prose-summary trap.
    expect(descriptionOf(child.tools, 'report_workflow')).toContain('Example call: report_workflow({task_id: "task-1"')
    expect(descriptionOf(child.tools, 'report_workflow')).toContain('plain-text summary without this call')
    // The patch format is owned by the parameter the model fills, not by the
    // tool description (codex/harness convention: constraints live on params).
    expect(parameterDescriptionOf(child.tools, 'manifest', 'files')).toContain('description_new')
    expect(parameterDescriptionOf(child.tools, 'manifest', 'notes_patch')).toContain('Line-based patch')
    expect(parameterDescriptionOf(child.tools, 'manifest', 'notes_patch')).toContain('End of File')
    expect(parameterDescriptionOf(child.tools, 'manifest', 'notes_patch')).toContain('rejected')
    expect(child.skills).toEqual([])
    expect(child.sections.some(section => section.name === 'tool:report-workflow')).toBe(false)
    expect(child.sections.some(section => section.name === 'tool:report-environment')).toBe(false)
    // Every routed specialist reads the tool-owned report protocol; MAIN's own
    // delegation policy stays in the preset scope and must not leak here.
    const protocol = child.contexts.find(context => context.name === 'autoreport:report-protocol')
    expect(protocol?.text).toContain('must finish through `report_workflow`')
    expect(protocol?.text).toContain('invalid workflow report')
    expect(child.sections.some(section => section.name === 'tool:send_to_agent')).toBe(false)
    expect(child.tools.some(tool => tool.name === 'report')).toBe(false)
    expect(
      child.session.snapshotEvents().filter(event => event.type === 'sandbox/mode').map(event => event.data),
    ).toEqual([{ mode: 'workspace-write' }])
    expect(child.providers).toEqual(['autoreport-references'])
  })

  it('installs the compute shell for DATA_ANALYSIS when the child scope has none', () => {
    const child = childContext('child-da', '/tmp/autoreport-da-workspace', {
      services: {
        shell: { sandboxMode: 'workspace-write' },
        shellEnv: { collect: () => ({}) },
        // The stock pwsh installer requires a sandbox policy service whenever
        // the shell executor confines.
        sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
      },
    })
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    installRoutedReportTool(child.ctx, child.agent as never, host.ctx, routedWorkflow({ roleRegistry }))
    expect(child.tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow', ROLE_PROCESS_TOOL])
  })

  it('defers to the preset shell when the child joins a preset', () => {
    // Preset rows mount lazily on first use, so a joined preset's stock shell
    // is not in the scope yet at routing time; registering our own bash would
    // collide with that later mount and fail the child. The role guard keeps
    // the stock shell inside the role model (foreground-only, no escalation).
    const child = childContext('child-da', '/tmp/autoreport-da-workspace', {
      services: {
        shell: { sandboxMode: 'workspace-write' },
        shellEnv: { collect: () => ({}) },
        agentPresets: { composedPreset: () => 'base' },
      },
    })
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    installRoutedReportTool(child.ctx, child.agent as never, host.ctx, routedWorkflow({ roleRegistry }))
    expect(child.tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow'])
  })

  it('keeps a preset-mounted shell when the child scope already registered bash', () => {
    // Children join the parent's preset, so base rows like tool-bash can
    // already occupy the child's own scope layer; the router must not crash
    // the child on that duplicate, and the role guard stays the enforcement.
    const child = childContext('child-da', '/tmp/autoreport-da-workspace', {
      presetTools: [ROLE_PROCESS_TOOL],
      services: {
        shell: { sandboxMode: 'workspace-write' },
        shellEnv: { collect: () => ({}) },
        sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
      },
    })
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    expect(() => installRoutedReportTool(child.ctx, child.agent as never, host.ctx, routedWorkflow({ roleRegistry })))
      .not.toThrow()
    expect(child.tools.map(tool => tool.name)).toEqual([ROLE_PROCESS_TOOL, 'manifest', 'report_workflow'])
  })

  it('installs report workflow, compilation, and page rendering only for REPORT', () => {
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
    installRoutedReportTool(child.ctx, child.agent as never, host.ctx, routedWorkflow({ roleRegistry }))
    expect(child.tools.map(tool => tool.name)).toEqual(['manifest', 'report_workflow', 'compile_report', 'render_report_page'])
    expect(child.skills.map(skill => skill.name)).toEqual([
      'experiment-report-writer',
    ])
    const environment = child.sections.find(section => section.name === 'tool:report-environment')
    expect(environment?.text).toContain('language: latex')
    expect(environment?.text).toContain('entry: Report/main.tex')
    expect(environment?.text).not.toContain('compile skill')
    // The active language's layout rules ride the prompt: they are unconditional
    // guidance, so no child has to load a skill to obtain them.
    const guidance = child.sections.find(section => section.name === 'tool:report-language')
    expect(guidance?.text).toContain('# Active report language: LaTeX')
    expect(guidance?.text).toContain('Use `[H]` for every figure and table')
    expect(child.sections.map(section => section.name)).not.toEqual(expect.arrayContaining([
      'autoreport:skill:experiment-report-writer',
    ]))
    expect(
      child.session.snapshotEvents().filter(event => event.type === 'sandbox/mode').map(event => event.data),
    ).toEqual([{ mode: 'workspace-write' }])
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
      systemPrompt: {
        section: () => () => {},
        context: () => () => {},
        getSectionOrder: () => 2900,
        getContextOrder: () => 120,
      },
      skills: { register: () => () => {} },
      get: () => undefined,
    } as unknown as Context
    installRoutedReportTool(ctx, { id: SessionId('child-stock'), session: undefined } as never, hostContext().ctx, routedWorkflow({ roleRegistry }))
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

  it('serializes a validated envelope through adjacent messaging', async () => {
    const child = childContext()
    const sendMessage = vi.fn(async () => 'report-msg')
    const attempt = {
      taskId: 'task-3', delegationRevision: 2, role: 'THEORY',
      childSessionId: child.agent.id, phase: 'waiting_for_child',
    }
    const projection = {
      fileNotes: new Map([['Theory/model.md', {
        path: 'Theory/model.md', description: 'current model', descriptionUpdatedAt: 20, producedBy: 'THEORY',
      }]]),
      roleNotes: new Map(),
      artifacts: [{
        path: 'Theory/model.md', producedBy: 'THEORY', delegationKey: 'task-3#2', status: 'created', recordedAt: 10,
      }],
    }
    const runtime = {
      workflowForChild: () => ({ runtime: { state: {
        delegationAt: () => attempt,
        projection: () => projection,
      } } }),
    }
    const host = {
      ctx: {
        subagents: { sendMessage },
        get: (name: string) => name === 'autoreportWorkflow' ? runtime : undefined,
      } as unknown as Context,
      sendMessage,
    }
    installWorkflowReportTool(child.ctx, host.ctx, 'THEORY')
    const result = await toolNamed(child.tools, 'report_workflow').execute({
      task_id: 'task-3',
      delegation_revision: 2,
      status: 'success',
      response: 'compiled',
      produced_files: ['Theory/fake.md'],
    }, { agent: child.agent, signal: new AbortController().signal })
    expect(result).toEqual({ messageId: 'report-msg' })
    expect(host.sendMessage).toHaveBeenCalledOnce()
    const content = host.sendMessage.mock.calls[0]?.[2] as { type: string; text: string }[]
    expect(content[0]?.text).toContain('THEORY → MAIN')
    expect(content[0]?.text).toContain('Details')
    expect(JSON.parse(content[1]?.text ?? '{}')).toMatchObject({
      task_id: 'task-3',
      delegation_revision: 2,
      status: 'success',
      block_type: null,
      produced_files: ['Theory/model.md'],
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
    }, { agent: child.agent, signal: new AbortController().signal })).rejects.toThrow(/invalid workflow report/)
    expect(host.sendMessage).not.toHaveBeenCalled()
  })

  function hostWithDirtyTheory() {
    const session = sessionIn(WORKSPACE, 'main')
    const state = workflowState(session)
    const waiters = new WaiterRegistry()
    const commit = <T extends AutoReportRecordType>(
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
    const sendMessage = vi.fn(async () => 'report-msg')
    return {
      ctx: {
        subagents: { sendMessage },
        get: (name: string) => name === 'autoreportWorkflow' ? runtime : undefined,
      } as unknown as Context,
      sendMessage,
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
    const exec = { agent: child.agent, signal: new AbortController().signal }
    const report = {
      task_id: 'task-3',
      delegation_revision: 1,
      status: 'success',
      response: 'derived',
      produced_files: ['Theory/model.md'],
    }
    await expect(toolNamed(child.tools, 'report_workflow').execute(report, exec))
      .rejects.toThrow(/manifest descriptions are stale/)
    expect(host.sendMessage).not.toHaveBeenCalled()

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
    expect(host.sendMessage).toHaveBeenCalledOnce()
  })

  it('reads another role manifest but only updates its bound role', async () => {
    const child = childContext()
    const host = hostWithDirtyTheory()
    installManifestTool(child.ctx, host.ctx, 'THEORY')
    const exec = { agent: child.agent, signal: new AbortController().signal }
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

  it('returns the accepted reportMessageId without calling sendMessage again', async () => {
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
    }, { agent: child.agent, signal: new AbortController().signal }))
      .resolves.toEqual({ messageId: 'already-accepted' })
    expect(host.sendMessage).not.toHaveBeenCalled()
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
    }, { agent: child.agent, signal: new AbortController().signal }))
      .resolves.toEqual({ messageId: 'report-msg' })
    expect(host.sendMessage).toHaveBeenCalledOnce()
  })
})
