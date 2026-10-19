/**
 * Resident delegation round trip through the REAL agent factory and loop.
 *
 * The assembled-host smokes (integration.host.test.ts) fake the transport
 * plane and never mount an agents factory, so `provisionResidentRole` returns
 * early there and the production creation path — `agents.create` with
 * `resolveChildAgentOptions`, `childSessionMeta`, the role setup, and the
 * `subagent/descriptor` append — is never exercised. That is exactly the seam
 * that has regressed before (children that "died on their first step with
 * `has no provider/model`"), and the 2026-09 web incident class: a child whose
 * first turn dies before producing any model event.
 *
 * This suite boots the real stack (LlmRuntime, SessionStore,
 * SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry,
 * AgentLoop) with scripted LLM adapters and runs `send_to_agent` end to end:
 * resident provisioning through the real factory seam, briefing delivery by
 * `followup`, the child's first turn on its routed provider, `report_workflow`
 * settlement, and the MAIN steer. If these tests pass, MAIN can dispatch a
 * specialist, the child completes its first turn without a turn-level error,
 * and the report settles the delegation durably.
 * @module tests/integration.resident
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { ROLE_PROCESS_TOOL } from '../src/roles.js'
import { apply as applyHost } from '../src/host.js'
import { apply as applyReportRouter } from '../src/tools/report-router.js'
import * as presetModule from '../src/preset.js'
import type { AutoReportWorkflowRuntime } from '../src/runtime.js'
import type { Config } from '../src/config.js'
import { ISOLATED_PYTHON_DETECT } from './helpers/managed-python-stub.js'
import { MemorySettings } from './helpers/memory-settings.js'
import { ScriptedAdapter, textResponse, toolCallResponse } from './helpers/scripted-llm.js'

const MAIN_PROVIDER = 'test-main'
const SPECIALIST_PROVIDER = 'test-specialist'
const SPECIALIST_MODEL = 'spec-model'

const TEST_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: { provider: SPECIALIST_PROVIDER, model: SPECIALIST_MODEL },
  delegationWaitTimeoutMs: 15_000,
  delegationIdleTimeoutMs: 5_000,
}

interface ScriptedCall {
  readonly name: string
  readonly args: Record<string, unknown>
}

interface Booted {
  readonly ctx: Context
  readonly mainAgent: Agent
  readonly mainSession: Session
  readonly runtime: AutoReportWorkflowRuntime
  /** The resident child session for whichever role the test dispatched. */
  readonly childSession: () => Session | undefined
  readonly mainAdapter: ScriptedAdapter
  readonly specialistAdapter: ScriptedAdapter
  readonly workspaceRoot: string
  readonly ownedDirs: readonly string[]
}

const live: Booted[] = []
const tempDirs: string[] = []
afterEach(async () => {
  for (const booted of live.splice(0)) {
    try {
      await booted.ctx.fiber?.dispose()
    } catch {
      // Dispose is best effort; the temp cleanup below still runs.
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Names of the tool schemas one recorded request carried. */
function requestedToolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

/** Poll until `predicate` holds; throws with the label after `timeoutMs`. */
async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met before timeout: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function sendUser(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** The reason of the newest turn/end event, for turn-level error assertions. */
function lastTurnEndReason(session: Session): { kind: string; error?: { message: string; code: string } } | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event.data.reason as { kind: string; error?: { message: string; code: string } }
  }
  return undefined
}

function descriptorOf(session: Session): Record<string, unknown> | undefined {
  const event = session.snapshotEvents().find(candidate => candidate.type === 'subagent/descriptor')
  return event === undefined ? undefined : event.data as Record<string, unknown>
}

/** Texts of MAIN-side messages delivered through the subagent-report relay. */
function relayTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => event.data as { content: Array<{ type: string; text?: string }>; source: Record<string, unknown> })
    .filter(message => message.source['kind'] === 'subagent-report')
    .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join(''))
}

/**
 * Boot the real agent stack plus the AutoReport host/router/preset with
 * transport-plane fakes (same posture as tests/helpers/assembled-host.ts,
 * except the agents factory, session store, llm runtime, system prompt, tool
 * runtime, and projections are all REAL).
 */
async function boot(options: {
  /** MAIN model responses: tool calls in order, then closing texts. */
  mainCalls: readonly ScriptedCall[]
  mainTexts?: readonly string[]
  /** Specialist (routed child) model responses. */
  specialistCalls?: readonly ScriptedCall[]
  specialistTexts?: readonly string[]
  /** Composition specialist route; defaults to the registered test provider. */
  specialistModel?: Config['specialistModel']
  /** Deployments without a global base bash row: the role shell must be
   *  backfilled agent-locally, which restrict() must never name. */
  omitGlobalBash?: boolean
  /** Exercise the real stock subagent stop RPC against plugin-owned children. */
  realSubagents?: boolean
}): Promise<Booted> {
  const ctx = new Context()
  const workspaceRoot = tempDir('autoreport-resident-ws-')
  const home = tempDir('autoreport-resident-home-')

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemorySettings, { doc: { 'autoreport-host': {} } })
  await ctx.plugin(AgentLoop, { agents: [] })

  // The resident path under test must never reach the legacy transport plane:
  // these fakes fail loud so a regression back to startContinuable is visible.
  if (options.realSubagents) await ctx.plugin(SubagentRuntime, {})
  else ctx.provide('subagents', {
    startContinuable: async () => {
      throw new Error('legacy startContinuable must not run for resident dispatch')
    },
    followup: async () => 'unused-followup',
    [deliverSubagentPrompt]: async () => 'unused-deliver',
    sendMessage: async () => {
      throw new Error('resident children report through parent.steer, not sendMessage')
    },
  } as never)
  ctx.provide('commands', { register: () => () => {} } as never)
  // Production deployments always mount the DSH shell capability; without it
  // the overlay shell installer never activates and the 2026-10 duplicate-bash
  // collision (host wrap vs router compute shell) cannot reproduce here.
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  ctx.provide('shellEnv', { register: () => () => {} } as never)
  ctx.provide('fs', {} as never)
  ctx.provide('subprocess', {
    resolveExecutable: async (command: string) => command,
    spawn: () => { throw new Error('subprocess spawning is unused in resident roster tests') },
  } as never)
  ctx.provide('skills', {
    register: () => () => {},
    registerProvider: () => () => {},
  } as never)
  // Preset composition seam (mounted upstream by dsh-agent-presets): the
  // resident setup needs the parent's composed preset id for the child header
  // and a truthy join so the tool-filter restriction is applied.
  ctx.provide('agentPresets', {
    composedPreset: () => 'autoreport',
    composeFrom: () => ({}),
  } as never)

  // Production deployments always carry ask_user_question (base bundle); the
  // resident deny-list names it, and tools.restrict validates names.
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description: 'test stub so the resident deny-list compiles',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'stub' }] },
    async execute() { return {} },
  }))
  if (options.omitGlobalBash !== true) {
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'test shell stub so the THEORY denial is enforced',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'stub' }] },
      async execute() { return {} },
    }))
  }
  ctx.tools.register(defineTool({
    name: 'pwsh',
    description: 'test PowerShell stub so the THEORY denial is enforced on Windows',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'stub' }] },
    async execute() { return {} },
  }))
  for (const name of ['read', 'read_image', 'write', 'edit', 'skill', 'grep', 'str_replace_editor']) {
    ctx.tools.register(defineTool({
      name,
      description: `test stub for base DSH tool ${name}`,
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'stub' }] },
      async execute() { return {} },
    }))
  }
  for (const name of ['workflow', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'todo_write', 'glob']) {
    ctx.tools.register(defineTool({
      name,
      description: `test stub for denied DSH capability ${name}`,
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'stub' }] },
      async execute() { return {} },
    }))
  }

  const mainAdapter = new ScriptedAdapter([
    ...options.mainCalls.map(call => toolCallResponse(`main-${call.name}`, call.name, call.args)),
    ...(options.mainTexts ?? []).map(textResponse),
  ])
  const specialistAdapter = new ScriptedAdapter([
    ...(options.specialistCalls ?? []).map(call => toolCallResponse(`spec-${call.name}`, call.name, call.args)),
    ...(options.specialistTexts ?? []).map(textResponse),
  ])
  ctx.llm.registerAdapter([MAIN_PROVIDER], mainAdapter)
  ctx.llm.registerAdapter([SPECIALIST_PROVIDER], specialistAdapter)

  await applyHost(ctx, { ...TEST_CONFIG, workspaceRoot, specialistModel: options.specialistModel ?? TEST_CONFIG.specialistModel }, {
    settingsHome: home,
    pythonDetect: ISOLATED_PYTHON_DETECT,
  })
  applyReportRouter(ctx)
  presetModule.apply(ctx)

  const runtime = ctx.autoreportWorkflow
  const handle = await ctx.agents.create({
    sessionId: SessionId('it-main'),
    meta: { cwd: workspaceRoot, agentPreset: 'autoreport' },
    agentOptions: { provider: MAIN_PROVIDER, model: 'main-model' },
  })
  const booted: Booted = {
    ctx,
    mainAgent: handle.agent,
    mainSession: handle.agent.session,
    runtime,
    childSession: () => {
      const state = runtime.forSession(handle.agent.session).state
      const binding = state.bindingForRole('THEORY') ?? state.bindingForRole('DATA_ANALYSIS')
      return binding === undefined ? undefined : ctx.sessions.get(binding.childSessionId)
    },
    mainAdapter,
    specialistAdapter,
    workspaceRoot,
    ownedDirs: [workspaceRoot, home],
  }
  live.push(booted)
  return booted
}

describe('integration: resident subagent through the real agent loop', () => {
  it('wait=true: MAIN dispatches, the child runs its first turn on the routed provider, and the report settles the delegation', { timeout: 30_000 }, async () => {
    const booted = await boot({
      realSubagents: true,
      mainCalls: [{
        name: 'send_to_agent',
        args: {
          role: 'THEORY',
          subject: '理论部分：pn结势垒电容',
          prompt: '推导 pn 结势垒电容理论并写入 Theory/notes.md',
        },
      }],
      mainTexts: ['报告已收到'],
      specialistCalls: [{
        name: 'report_workflow',
        args: {
          task_id: 'task-1',
          delegation_revision: 1,
          status: 'success',
          response: '理论推导完成：势垒电容公式已写入笔记',
          produced_files: [],
        },
      }],
      specialistTexts: ['child done'],
    })

    sendUser(booted.mainAgent, '开始完成实验报告')
    await until(() => booted.mainAgent.status === 'idle', 'MAIN turn idle')

    // The MAIN turn itself completed without a turn-level error.
    expect(lastTurnEndReason(booted.mainSession)?.kind).toBe('completed')
    const mainRequest = booted.mainAdapter.requests[0]!
    const mainTools = requestedToolNames(mainRequest)
    expect(mainTools).toEqual(expect.arrayContaining([
      'read', 'read_image', 'list', 'grep', 'skill', 'manifest', 'workflow_task',
      'send_to_agent', 'install_python_package', 'extract_pdf',
    ]))
    for (const name of ['bash', 'pwsh', 'glob', 'workflow', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'todo_write']) {
      expect(mainTools).not.toContain(name)
    }
    expect(mainTools).not.toContain('str_replace_editor')
    expect(mainTools.slice().sort()).toEqual(booted.ctx.tools.schemas(booted.mainAgent).map(tool => tool.name).sort())
    for (const schema of mainRequest.tools ?? []) {
      const callable = booted.ctx.tools.get(schema.name, booted.mainAgent)
      expect(callable?.execute, schema.name).toBeTypeOf('function')
      expect(callable?.description, schema.name).toBe(schema.description)
    }

    // The send_to_agent tool resolved with the child's report (wait=true path).
    const workflow = booted.runtime.forSession(booted.mainSession)
    expect(workflow.state.delegationAt('task-1', 1)?.phase).toBe('completed')
    expect(workflow.state.getTask('task-1')?.status).toBe('completed')
    expect(workflow.state.bindingForRole('THEORY')?.provisioning).toBe('active')

    // The child was created through the real factory seam and classified.
    const child = booted.childSession()
    expect(child).toBeDefined()
    const descriptor = descriptorOf(child!)
    expect(descriptor?.['provider']).toBe('spawn')
    expect(descriptor?.['label']).toBe('AutoReport THEORY')
    expect(descriptor?.['mode']).toBe('continuable')
    // A descriptor alone is not navigable: the browser reads the parent's
    // native subagentCatalog projection, not AutoReport's role bindings.
    expect(booted.mainSession.snapshotEvents().filter(event => event.type === 'subagent/catalog').map(event => event.data)).toContainEqual({
      version: 0, childId: child!.id, childCreatedAt: child!.header.createdAt,
      mode: 'continuable', label: 'AutoReport THEORY',
    })
    expect(booted.ctx.sessionProjections.snapshot(booted.mainSession, ['subagentCatalog']).values.subagentCatalog).toContainEqual({
      id: child!.id, createdAt: child!.header.createdAt, mode: 'continuable', label: 'AutoReport THEORY',
    })
    const entries = booted.mainSession.snapshotEvents().filter(event => event.type === 'subagent/catalog').length
    await booted.runtime.restoreResidentRoles(booted.mainAgent)
    expect(booted.mainSession.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toHaveLength(entries)

    // The frozen workflow route reached the child's durable identity…
    expect(descriptor?.['agentProvider']).toBe(SPECIALIST_PROVIDER)
    expect(descriptor?.['agentModel']).toBe(SPECIALIST_MODEL)
    // …and the role denial list rode the descriptor too.
    expect(descriptor?.['toolFilter']).toMatchObject({
      deny: [
        'send_to_agent', 'ask_user_question', 'workflow', 'subagent', 'subagent_fork',
        'send_message', 'interrupt_agent', 'list_agents', 'todo_write', 'glob', 'pwsh', 'bash',
        'install_python_package', 'skill',
      ],
    })

    // Child session lineage: a real child of THIS main under the preset.
    expect(child!.header.parentSession?.toString()).toBe(booted.mainSession.id.toString())
    expect(child!.header.cwd).toBe(booted.workspaceRoot)
    expect(child!.header.agentPreset).toBe('autoreport')

    // The child's first turn ran on the routed provider/model (the incident
    // class: a misrouted or missing route kills children on their first step).
    expect(booted.specialistAdapter.requests.length).toBeGreaterThanOrEqual(1)
    for (const request of booted.specialistAdapter.requests) {
      expect(request.provider).toBe(SPECIALIST_PROVIDER)
      expect(request.model).toBe(SPECIALIST_MODEL)
    }
    // The routed tool surface: the structured report protocol, NOT delegation.
    // THEORY registers no bundled skills, so the skill loader is hidden too —
    // an empty catalog plus a loader only invites invented skill names.
    const childTools = requestedToolNames(booted.specialistAdapter.requests[0]!)
    expect(childTools).toContain('report_workflow')
    expect(childTools).toContain('manifest')
    expect(childTools).toContain('list')
    expect(childTools).toContain('grep')
    expect(childTools).not.toContain('skill')
    expect(childTools).not.toContain('bash')
    expect(childTools).not.toContain('pwsh')
    expect(childTools).not.toContain('send_to_agent')
    for (const name of ['workflow', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'todo_write', 'glob']) {
      expect(childTools).not.toContain(name)
    }
    // End-to-end same-source rule: without the `skill` tool the child's first
    // request also carries no skill catalog (the DSH tool-skill gate plus the
    // router's provider gating must both hold).
    for (const request of booted.specialistAdapter.requests) {
      expect(JSON.stringify(request.messages ?? [])).not.toContain('<available_skills>')
    }

    // The child's own turn ended completed — no UNKNOWN turn error.
    expect(lastTurnEndReason(child!)?.kind).toBe('completed')

    // MAIN received the structured report as a steered subagent-report message.
    const relays = relayTexts(booted.mainSession)
    expect(relays.length).toBeGreaterThanOrEqual(1)
    expect(relays.some(text => text.includes('THEORY') && text.includes('理论推导完成'))).toBe(true)
  })

  it('wait=true: a DATA_ANALYSIS dispatch settles with exactly one role shell', { timeout: 30_000 }, async () => {
    // Regression for the 2026-10 duplicate-bash blocker: with a shell service
    // mounted, the host role surface (wrap) and the report router (compute
    // shell) both used to register `bash` into the child's own scope layer,
    // and the second registration failed the whole dispatch. Ownership now
    // lives only in the host role surface.
    const booted = await boot({
      mainCalls: [{
        name: 'send_to_agent',
        args: {
          role: 'DATA_ANALYSIS',
          subject: '数据分析探针',
          prompt: '探针：确认派生链路可用',
        },
      }],
      mainTexts: ['报告已收到'],
      specialistTexts: ['child done'],
    })

    sendUser(booted.mainAgent, '开始完成实验报告')
    await until(() => booted.mainAgent.status === 'idle', 'MAIN turn idle')
    expect(lastTurnEndReason(booted.mainSession)?.kind).toBe('completed')
    const workflow = booted.runtime.forSession(booted.mainSession)
    expect(workflow.state.bindingForRole('DATA_ANALYSIS')?.provisioning).toBe('active')
    const child = booted.childSession()
    expect(child).toBeDefined()
    expect(descriptorOf(child!)?.['label']).toBe('AutoReport DATA_ANALYSIS')
  })

  it('wait=true: DATA_ANALYSIS settles when no stock bash is global (agent-local backfill)', { timeout: 30_000 }, async () => {
    // Real deployments compose the base shell rows per preset, not globally:
    // the role shell is backfilled as an agent-local compute shell, and
    // restrict() — which only names global tools — must not list it.
    const booted = await boot({
      omitGlobalBash: true,
      mainCalls: [{
        name: 'send_to_agent',
        args: {
          role: 'DATA_ANALYSIS',
          subject: '无全局 bash 的派生探针',
          prompt: '探针：确认无全局 bash 时派生链路可用',
        },
      }],
      mainTexts: ['报告已收到'],
      specialistTexts: ['child done'],
    })

    sendUser(booted.mainAgent, '开始完成实验报告')
    await until(() => booted.mainAgent.status === 'idle', 'MAIN turn idle')
    expect(lastTurnEndReason(booted.mainSession)?.kind).toBe('completed')
    const workflow = booted.runtime.forSession(booted.mainSession)
    expect(workflow.state.bindingForRole('DATA_ANALYSIS')?.provisioning).toBe('active')
    const child = booted.childSession()
    expect(child).toBeDefined()
    expect(descriptorOf(child!)?.['label']).toBe('AutoReport DATA_ANALYSIS')
  })

  it('wait=false: the incident path — MAIN moves on, the async report still settles and relays', { timeout: 30_000 }, async () => {
    const booted = await boot({
      mainCalls: [{
        name: 'send_to_agent',
        args: {
          role: 'DATA_ANALYSIS',
          subject: '全部分析 Data/ 原始数据',
          prompt: '分析 Data/ 下全部原始数据并产出处理后数据集',
          wait: false,
        },
      }],
      // The steer may arrive during turn 1 (next step) or open turn 2; keep
      // one spare closing response so either interleaving completes.
      mainTexts: ['继续推进', '报告已收到'],
      specialistCalls: [{
        name: 'report_workflow',
        args: {
          task_id: 'task-1',
          delegation_revision: 1,
          status: 'success',
          response: '数据分析完成：处理后数据集已生成',
          produced_files: [],
        },
      }],
      specialistTexts: ['child done'],
    })

    sendUser(booted.mainAgent, '开始完成实验报告')
    await until(
      () => booted.mainAgent.status === 'idle'
        && booted.runtime.forSession(booted.mainSession).state.delegationAt('task-1', 1)?.phase === 'completed',
      'delegation settled',
    )

    const workflow = booted.runtime.forSession(booted.mainSession)
    expect(workflow.state.getTask('task-1')?.status).toBe('completed')

    const child = booted.childSession()
    expect(child).toBeDefined()
    expect(lastTurnEndReason(child!)?.kind).toBe('completed')
    expect(booted.specialistAdapter.requests[0]?.provider).toBe(SPECIALIST_PROVIDER)
    expect(booted.specialistAdapter.requests[0]?.model).toBe(SPECIALIST_MODEL)

    // DATA_ANALYSIS keeps its platform process tool and — with no bundled
    // skills — loses the skill loader (the 2026-10 regression pair).
    const analystTools = requestedToolNames(booted.specialistAdapter.requests[0]!)
    expect(analystTools).toContain(ROLE_PROCESS_TOOL)
    expect(analystTools).not.toContain('skill')

    await until(
      () => relayTexts(booted.mainSession).some(text => text.includes('DATA_ANALYSIS') && text.includes('数据分析完成')),
      'report relayed to MAIN',
    )
    // Whatever interleaving ran, no MAIN turn may end in a turn-level error.
    for (const event of booted.mainSession.snapshotEvents().filter(candidate => candidate.type === 'turn/end')) {
      expect((event.data as { reason: { kind: string } }).reason.kind).toBe('completed')
    }
  })

  it('fails dispatch in the MAIN step when the frozen specialist provider has no adapter', { timeout: 30_000 }, async () => {
    const booted = await boot({
      mainCalls: [{
        name: 'send_to_agent',
        args: {
          role: 'THEORY',
          subject: 'misrouted dispatch',
          prompt: 'This dispatch must be refused before any child is created',
        },
      }],
      // The refusal ends the step; a closing text keeps the MAIN turn idle-able
      // even though the model would normally continue after a tool error.
      mainTexts: ['派发被拒绝，任务终止'],
      specialistModel: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
    })

    sendUser(booted.mainAgent, '开始完成实验报告')
    await until(() => booted.mainAgent.status === 'idle', 'MAIN turn idle')

    // The tool failed inside the MAIN step with the actionable message:
    // the tool result carries the refusal to the model, no delegation was
    // recorded, and no child session was ever created.
    const workflow = booted.runtime.forSession(booted.mainSession)
    expect(workflow.state.currentDelegation('task-1')).toBeUndefined()
    const toolResults = booted.mainSession.snapshotEvents()
      .filter(event => event.type === 'tool/result')
      .map(event => event.data as { message: { content: Array<{ text?: string }> }; error?: { reason?: string } })
    const refusal = toolResults.find(result =>
      JSON.stringify(result.message.content).includes('not registered')
      || result.error?.reason?.includes('not registered'),
    )
    expect(refusal).toBeDefined()
    // No child session was ever created for the refused dispatch.
    expect(booted.childSession()).toBeUndefined()
  })

  it('settle the delegation with the child error when the child first turn crashes', { timeout: 30_000 }, async () => {
    // The 2026-09 incident class: the child's prompt composition throws before
    // any model event, its first turn ends with reason.kind 'error', and the
    // continuable activation never settles. MAIN must still learn the failure
    // with the underlying error message instead of waiting out the idle
    // timeout for an empty timeout outcome.
    const booted = await boot({
      mainCalls: [{
        name: 'send_to_agent',
        args: {
          role: 'REPORT',
          subject: '撰写并编译实验报告',
          prompt: '撰写并编译本项目实验报告，输出到 Report/。',
        },
      }],
      // The wait=true tool result must arrive as a failure the model can act
      // on; a closing text ends the MAIN turn either way.
      mainTexts: ['子任务失败了，已了解原因'],
      specialistCalls: [],
      specialistTexts: [],
    })

    // The real incident: the specialist adapter rejects every request, so the
    // child's first turn dies with a turn-level error before producing any
    // model output.
    booted.specialistAdapter.script.length = 0
    booted.specialistAdapter.stream = async function* () {
      yield* []
      throw new Error('malformed prompt variable reference "{{../Plots/Fig/}}" in section "tool:report-language"')
    }

    sendUser(booted.mainAgent, '开始完成实验报告')
    await until(() => {
      const live = booted.runtime.forSession(booted.mainSession)
      return booted.mainAgent.status === 'idle'
        && live.state.currentDelegation('task-1')?.phase === 'failed'
    }, 'delegation settled after child crash')

    const live = booted.runtime.forSession(booted.mainSession)
    expect(live.state.currentDelegation('task-1')?.phase).toBe('failed')
    expect(live.state.currentDelegation('task-1')?.reason).toContain('malformed prompt variable reference')
    expect(live.state.getTask('task-1')?.status).toBe('failed')
    expect(live.state.getTask('task-1')?.failedReason).toContain('malformed prompt variable reference')
  })
})

/** Hold model generation until its real turn signal is cancelled. */
function holdSpecialists(booted: Booted): { signals: AbortSignal[]; restore: () => void } {
  const signals: AbortSignal[] = []
  const original = booted.specialistAdapter.stream
  booted.specialistAdapter.stream = async function* (options: GenerateOptions) {
    const signal = options.signal!
    signals.push(signal)
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    yield* []
  }
  return { signals, restore: () => { booted.specialistAdapter.stream = original } }
}

async function waitingChild(booted: Booted, signals: AbortSignal[]): Promise<Agent> {
  await until(() => signals.length > 0 && booted.runtime.forSession(booted.mainSession).waiters.pendingKeys() === 1,
    'specialist generating while MAIN waits', 3000)
  return booted.runtime.residentChild(booted.childSession()!.id)!
}

const THEORY_DISPATCH: ScriptedCall = { name: 'send_to_agent', args: { role: 'THEORY', prompt: 'derive theory' } }
const THEORY_REPORT: ScriptedCall = {
  name: 'report_workflow',
  args: { task_id: 'task-1', delegation_revision: 2, status: 'success', response: 'done', produced_files: [] },
}

describe('integration: stop controls for resident subagents', () => {
  it('MAIN stop cancels every active resident, drains wait=true, and keeps the child sessions', async () => {
    const b = await boot({
      realSubagents: true,
      mainCalls: [
        { ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, wait: false } },
        { name: 'send_to_agent', args: { role: 'DATA_ANALYSIS', prompt: 'analyze data' } },
      ],
    })
    const held = holdSpecialists(b)
    sendUser(b.mainAgent, 'start report')
    await until(() => held.signals.length === 2 && b.runtime.forSession(b.mainSession).waiters.pendingKeys() === 1,
      'two specialists and MAIN waiting', 3000)
    const workflow = b.runtime.forSession(b.mainSession)
    const bindings = [...workflow.state.projection().bindingsByRole.values()]
    b.mainAgent.cancel({ kind: 'user' }, { keepInbox: true })
    await until(() => b.mainAgent.status === 'idle' && bindings.every(binding => b.runtime.residentChild(binding.childSessionId)?.status === 'idle'),
      'all stopped', 3000)
    expect(held.signals.every(signal => signal.aborted)).toBe(true)
    expect(workflow.waiters.pendingKeys()).toBe(0)
    expect(lastTurnEndReason(b.mainSession)?.kind).toBe('aborted')
    for (const binding of bindings) {
      expect(workflow.state.bindingForRole(binding.role)?.childSessionId).toBe(binding.childSessionId)
      expect(b.runtime.residentChild(binding.childSessionId)).toBeDefined()
    }
    expect([...workflow.state.projection().tasks.values()].map(task => task.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('the stock child interrupt RPC stops the exact resident and settles MAIN without a timeout', async () => {
    const b = await boot({ realSubagents: true, mainCalls: [THEORY_DISPATCH], mainTexts: ['child interrupted'] })
    const held = holdSpecialists(b)
    sendUser(b.mainAgent, 'start report')
    const child = await waitingChild(b, held.signals)
    expect(() => b.ctx.subagents.interruptByParent(child.id, SessionId('another-parent'), 'continuable'))
      .toThrow('subagent does not belong to this parent')
    expect(held.signals[0]!.aborted).toBe(false)
    expect(b.ctx.subagents.interruptByParent(child.id, b.mainAgent.id, 'continuable')).toEqual({ accepted: true })
    await until(() => child.status === 'idle' && b.mainAgent.status === 'idle', 'child RPC stopped turn', 3000)
    expect(held.signals[0]!.aborted).toBe(true)
    expect(lastTurnEndReason(child.session)?.kind).toBe('aborted')
    expect(b.runtime.forSession(b.mainSession).waiters.pendingKeys()).toBe(0)
    expect(b.runtime.forSession(b.mainSession).state.currentDelegation('task-1')?.phase).toBe('cancelled')
    expect(b.runtime.residentChild(child.id)).toBe(child)
    await b.runtime.reportFromResident(child, [{ type: 'text', text: JSON.stringify({ ...THEORY_REPORT.args, delegation_revision: 1, response: 'κ ∈ {N, 1}' }) }],
      new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(b.mainAgent.status).toBe('idle')
    expect(b.mainAdapter.requests).toHaveLength(2)
  })

  it('MAIN stop also stops asynchronous delegation after MAIN is already idle', async () => {
    const b = await boot({
      realSubagents: true,
      mainCalls: [{ ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, wait: false } }],
      mainTexts: ['delegated'],
    })
    const held = holdSpecialists(b)
    sendUser(b.mainAgent, 'start report')
    await until(() => held.signals.length === 1 && b.mainAgent.status === 'idle', 'asynchronous child active', 3000)
    b.mainAgent.cancel({ kind: 'user' }, { keepInbox: true })
    await until(() => b.runtime.residentChild(b.childSession()!.id)?.status === 'idle', 'asynchronous child stopped', 3000)
    expect(held.signals[0]!.aborted).toBe(true)
    expect(b.runtime.forSession(b.mainSession).state.getTask('task-1')?.status).toBe('cancelled')
  })

  it('late child reports are parked after MAIN stop; explicit user input can reopen and reuse the same child', async () => {
    const b = await boot({
      realSubagents: true,
      mainCalls: [THEORY_DISPATCH,
        { name: 'workflow_task', args: { action: 'reopen', task_id: 'task-1' } },
        { ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, task_id: 'task-1' } },
      ],
      mainTexts: ['resumed work completed'],
      specialistCalls: [THEORY_REPORT], specialistTexts: ['child done'],
    })
    const held = holdSpecialists(b)
    sendUser(b.mainAgent, 'start report')
    const child = await waitingChild(b, held.signals)
    b.mainAgent.cancel({ kind: 'user' }, { keepInbox: true })
    await until(() => b.mainAgent.status === 'idle' && child.status === 'idle', 'stopped before late report', 3000)
    const late = { ...THEORY_REPORT.args, delegation_revision: 1 }
    await b.runtime.reportFromResident(child, [{ type: 'text', text: JSON.stringify(late) }], new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(b.mainAgent.status).toBe('idle')
    expect(b.mainAdapter.requests).toHaveLength(1)
    expect(b.mainAgent.inbox.nextStep.some(message => JSON.stringify(message).includes('delegation_revision'))).toBe(true)
    expect(b.runtime.forSession(b.mainSession).state.currentDelegation('task-1')?.phase).toBe('cancelled')
    held.restore()
    sendUser(b.mainAgent, 'continue the interrupted work')
    await until(() => b.mainAgent.status === 'idle' && b.runtime.forSession(b.mainSession).state.getTask('task-1')?.status === 'completed',
      'same specialist completes revision 2', 3000)
    expect(b.runtime.residentChild(child.id)).toBe(child)
    expect(b.runtime.forSession(b.mainSession).state.currentDelegation('task-1')?.delegationRevision).toBe(2)
    expect(b.mainSession.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)).toEqual(['aborted', 'completed'])
  })

  it('workflow_task cancel aborts the resident execution as well as the durable task', async () => {
    const b = await boot({ realSubagents: true, mainCalls: [THEORY_DISPATCH], mainTexts: ['task cancelled'] })
    const held = holdSpecialists(b)
    sendUser(b.mainAgent, 'start report')
    const child = await waitingChild(b, held.signals)
    const result = await b.ctx.tools.execute({
      callId: ToolCallId('user-cancel-task'), name: 'workflow_task', arguments: { action: 'cancel', task_id: 'task-1' },
      agent: b.mainAgent, signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    await until(() => child.status === 'idle' && b.mainAgent.status === 'idle', 'cancelled task execution', 3000)
    expect(held.signals[0]!.aborted).toBe(true)
    expect(b.runtime.forSession(b.mainSession).state.getTask('task-1')?.status).toBe('cancelled')
    expect(b.runtime.residentChild(child.id)).toBe(child)
  })

  it('direct Agent cancellation handles aborted child turns and rejects a forged ancestor', async () => {
    const b = await boot({ realSubagents: true, mainCalls: [THEORY_DISPATCH], mainTexts: ['child interrupted'] })
    const held = holdSpecialists(b)
    sendUser(b.mainAgent, 'start report')
    const child = await waitingChild(b, held.signals)
    expect(() => b.ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: { ...b.mainAgent } }))
      .toThrow('resident subagent does not belong to this caller')
    child.cancel({ kind: 'hook', reason: 'external interruption' }, { keepInbox: true })
    await until(() => child.status === 'idle' && b.mainAgent.status === 'idle', 'direct child interrupted', 3000)
    expect(b.runtime.forSession(b.mainSession).waiters.pendingKeys()).toBe(0)
    expect(b.runtime.forSession(b.mainSession).state.currentDelegation('task-1')?.phase).toBe('cancelled')
  })

  it('delegates unknown subagent interrupts to the upstream implementation', async () => {
    const b = await boot({ realSubagents: true, mainCalls: [] })
    const cancelled = vi.spyOn(b.mainAgent, 'cancel')
    expect(b.ctx.subagents.interruptByParent(SessionId('unknown-child'), b.mainAgent.id, 'continuable')).toEqual({ accepted: true })
    expect(cancelled).not.toHaveBeenCalled()
  })
})

it.each(['task-1', 'task-2'])('task cancellation leaves legacy queued work on the same specialist intact (%s)', async taskId => {
  const b = await boot({
    realSubagents: true,
    mainCalls: [
      { ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, wait: false } },
    ],
    mainTexts: ['first task running'],
  })
  const held = holdSpecialists(b)
  sendUser(b.mainAgent, 'start report')
  const workflow = b.runtime.forSession(b.mainSession)
  await until(() => held.signals.length === 1 && b.mainAgent.status === 'idle', 'first task running', 3000)
  const child = b.runtime.residentChild(b.childSession()!.id)!
  // Older plugin versions admitted multiple tasks to a resident FIFO. Keep
  // recovery/cancellation coverage for those logs without admitting new queues.
  const messageId = await b.runtime.deliverResidentChild(b.mainAgent, child.id, [{ type: 'text', text: 'legacy queued task-2' }],
    { kind: 'coordinator', form: 'relay', senderSessionId: b.mainAgent.id, taskId: 'task-2', delegationRevision: 2 }, new AbortController().signal)
  b.runtime.commit(b.mainSession, 'autoreport/task', { ...workflow.state.getTask('task-1')!, taskId: 'task-2', subject: 'legacy queued task' })
  b.runtime.commit(b.mainSession, 'autoreport/delegation', {
    ...workflow.state.currentDelegation('task-1')!, taskId: 'task-2', acceptedMessageId: messageId!,
  })
  const result = await b.ctx.tools.execute({
    callId: ToolCallId('cancel-one-task'), name: 'workflow_task', arguments: { action: 'cancel', task_id: taskId },
    agent: b.mainAgent, signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  if (taskId === 'task-1') {
    await until(() => child.status === 'idle', 'active task stops', 3000)
    expect(held.signals[0]!.aborted).toBe(true)
    expect(child.inbox.nextTurn).toHaveLength(1)
    expect(workflow.state.getTask('task-2')?.status).toBe('running')
  } else {
    expect(held.signals[0]!.aborted).toBe(false)
    expect(child.inbox.nextTurn).toHaveLength(0)
    expect(workflow.state.getTask('task-1')?.status).toBe('running')
  }
  expect(workflow.state.getTask(taskId)?.status).toBe('cancelled')
  b.mainAgent.cancel({ kind: 'user' }, { keepInbox: true })
  await child.whenIdle()
})

it('an expired MAIN wait rejects overlapping dispatches and accepts the eventual brace-containing report on revision 1', async () => {
  const b = await boot({
    realSubagents: true,
    mainCalls: [
      { ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, timeout_ms: 50 } },
      { ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, task_id: 'task-1', wait: false } },
      { ...THEORY_DISPATCH, args: { ...THEORY_DISPATCH.args, subject: 'overlapping new task', wait: false } },
    ],
    mainTexts: ['waiting for existing task', 'received the eventual result'],
    specialistCalls: [{ ...THEORY_REPORT, args: { ...THEORY_REPORT.args, delegation_revision: 1, response: 'κ ∈ {N, 1}; \\frac{a}{b}' } }],
    specialistTexts: ['done'],
  })
  const ready = Promise.withResolvers<void>()
  const originalStream = b.specialistAdapter.stream.bind(b.specialistAdapter)
  b.specialistAdapter.stream = async function* (options: GenerateOptions) {
    await Promise.race([ready.promise, new Promise<void>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })])
    yield* originalStream(options)
  }
  sendUser(b.mainAgent, 'start report')
  const workflow = b.runtime.forSession(b.mainSession)
  try {
    await until(() => b.mainAgent.status === 'idle', 'MAIN wait expired and overlap rejected', 3000)
    const child = b.runtime.residentChild(b.childSession()!.id)!
    expect(child.status).toBe('running')
    expect(child.inbox.nextTurn).toHaveLength(0)
    expect(workflow.state.projection().tasks.size).toBe(1)
    expect(workflow.state.projection().delegations.size).toBe(1)
    expect(workflow.state.currentDelegation('task-1')?.phase).toBe('waiting_for_child')
    expect(workflow.waiters.pendingKeys()).toBe(0)
    const results = b.mainSession.snapshotEvents().filter(e => e.type === 'tool/result').map(e => e.data.message)
    expect(JSON.stringify(results)).toContain('execution_pending')
    expect(results.filter(block => block.role === 'tool' && block.isError)).toHaveLength(2)
    ready.resolve()
    await until(() => workflow.state.getTask('task-1')?.status === 'completed' && b.mainAgent.status === 'idle' && child.status === 'idle',
      'late structured report settles same revision', 3000)
    expect(workflow.state.currentDelegation('task-1')?.delegationRevision).toBe(1)
    expect(workflow.state.currentDelegation('task-1')?.report?.response).toContain('{N, 1}')
    expect(child.session.snapshotEvents().filter(e => e.type === 'turn/start')).toHaveLength(1)
  } finally {
    ready.resolve()
  }
})

/** A model stub that reports the current briefing once, then closes its turn. */
function reportEachBriefing(booted: Booted): void {
  booted.specialistAdapter.stream = async function* (options: GenerateOptions) {
    booted.specialistAdapter.requests.push(options)
    const briefing = options.messages.findLast(message => message.source?.kind === 'coordinator')
    const text = briefing?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    const match = /AutoReport task (task-[A-Za-z0-9._-]+), delegation revision (\d+)/u.exec(text)
    if (match === null) throw new Error('scheduled specialist has no coordinator task briefing')
    const taskId = match[1]!
    const revision = Number(match[2])
    const callId = `auto-${taskId}-${revision}`
    const reported = options.messages.some(message => message.role === 'tool' && String(message.toolCallId) === callId)
    const chunks = reported ? textResponse('specialist done') : toolCallResponse(callId, 'report_workflow', {
      task_id: taskId, delegation_revision: revision, status: 'success', response: `Completed ${taskId}: {N, 1}`, produced_files: [],
    })
    for (const chunk of chunks) { options.signal!.throwIfAborted(); yield chunk }
  }
}

it('runs a planned dependency graph through the real factory/loop and waits without repeated dispatch', async () => {
  const tasks = [
    { task_id: 'task-report', role: 'REPORT', subject: 'Report', prompt: 'Report the workflow result', dependencies: ['task-data', 'task-plot'] },
    { task_id: 'task-plot', role: 'PLOTTING', subject: 'Plot', prompt: 'Check the plotting stage', dependencies: ['task-data'] },
    { task_id: 'task-data', role: 'DATA_ANALYSIS', subject: 'Analysis', prompt: 'Check the analysis stage', dependencies: ['task-theory'] },
    { task_id: 'task-theory', role: 'THEORY', subject: 'Theory', prompt: 'Check the theory stage' },
    { task_id: 'task-aux', role: 'THEORY', subject: 'Independent theory', prompt: 'Check a separate theory stage' },
  ]
  const b = await boot({ realSubagents: true, mainCalls: [
    { name: 'workflow_task', args: { action: 'plan', tasks } },
    { name: 'workflow_task', args: { action: 'run' } },
    { name: 'workflow_task', args: { action: 'wait', task_ids: tasks.map(task => task.task_id), mode: 'all', timeout_ms: 3000 } },
  ], mainTexts: ['all graph tasks completed'] })
  reportEachBriefing(b)
  sendUser(b.mainAgent, 'execute the planned workflow')
  const state = b.runtime.forSession(b.mainSession).state
  await until(() => b.mainAgent.status === 'idle' && state.projection().tasks.size === 5 && [...state.projection().tasks.values()].every(task => task.status === 'completed'),
    'graph finishes all real-loop tasks', 5000)
  expect(state.currentDelegation('task-data')?.dependencyVersions).toEqual({ 'task-theory': 1 })
  expect(state.currentDelegation('task-report')?.dependencyVersions).toEqual({ 'task-data': 1, 'task-plot': 1 })
  expect(state.projection().delegations.size).toBe(5)
  expect(state.projection().meta?.scheduler?.enabled).toBe(false)
  const theory = b.runtime.residentChild(state.bindingForRole('THEORY')!.childSessionId)!
  await theory.whenIdle()
  expect(theory.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
  expect(b.runtime.coordinator.inspect(b.mainSession).waits.graph).toHaveLength(0)
  expect(lastTurnEndReason(b.mainSession)?.kind).toBe('completed')
})

it('MAIN stop pauses automatic scheduling and cancels only admitted graph executions', async () => {
  const tasks = [
    { task_id: 'task-a', role: 'THEORY', subject: 'Theory', prompt: 'Long theory work' },
    { task_id: 'task-b', role: 'DATA_ANALYSIS', subject: 'Data', prompt: 'Long analysis work' },
    { task_id: 'task-c', role: 'PLOTTING', subject: 'Plot', prompt: 'Downstream plotting', dependencies: ['task-a', 'task-b'] },
  ]
  const b = await boot({ realSubagents: true, mainCalls: [
    { name: 'workflow_task', args: { action: 'plan', tasks } },
    { name: 'workflow_task', args: { action: 'run' } },
    { name: 'workflow_task', args: { action: 'wait', task_ids: ['task-c'], timeout_ms: 3000 } },
  ] })
  const held = holdSpecialists(b)
  sendUser(b.mainAgent, 'start the planned graph')
  const state = b.runtime.forSession(b.mainSession).state
  await until(() => held.signals.length === 2 && b.runtime.coordinator.inspect(b.mainSession).waits.graph.length === 1,
    'MAIN waits while two roles execute', 3000)
  b.mainAgent.cancel({ kind: 'user' }, { keepInbox: true })
  await until(() => b.mainAgent.status === 'idle' && held.signals.every(signal => signal.aborted), 'graph stopped', 3000)
  expect(state.projection().meta?.scheduler?.enabled).toBe(false)
  expect(state.getTask('task-a')?.status).toBe('cancelled')
  expect(state.getTask('task-b')?.status).toBe('cancelled')
  expect(state.getTask('task-c')?.status).toBe('pending')
  expect(state.currentDelegation('task-c')).toBeUndefined()
  expect(b.runtime.coordinator.inspect(b.mainSession).waits.graph).toHaveLength(0)
  expect(lastTurnEndReason(b.mainSession)?.kind).toBe('aborted')
})

it('graph readiness accounts for a child whose previous turn is still draining', async () => {
  const b = await boot({ realSubagents: true, mainCalls: [THEORY_DISPATCH], mainTexts: ['existing task interrupted'] })
  const held = holdSpecialists(b)
  sendUser(b.mainAgent, 'start report')
  const child = await waitingChild(b, held.signals)
  // Record a valid result while its driver remains active, as can happen at
  // the report/turn-closing boundary before whenIdle resolves.
  await b.runtime.reportFromResident(child, [{ type: 'text', text: JSON.stringify({ ...THEORY_REPORT.args, delegation_revision: 1 }) }], new AbortController().signal)
  const plan = await b.ctx.tools.execute({ callId: ToolCallId('plan-following-task'), name: 'workflow_task',
    arguments: { action: 'plan', tasks: [{ task_id: 'task-next', role: 'THEORY', subject: 'Next task', prompt: 'Next theory work' }] },
    agent: b.mainAgent, signal: new AbortController().signal })
  expect(plan.isError).toBe(false)
  const view = b.runtime.coordinator.inspect(b.mainSession)
  expect(view.tasks.find(task => task.task_id === 'task-next')).toMatchObject({ readiness: 'role_busy', role_activity: 'running' })
  expect(view.ready_task_ids).not.toContain('task-next')
  expect(view.tasks.find(task => task.task_id === 'task-next')?.waiting_reason).toContain(String(child.id))
  child.cancel({ kind: 'user' }, { keepInbox: true })
  await child.whenIdle()
})
