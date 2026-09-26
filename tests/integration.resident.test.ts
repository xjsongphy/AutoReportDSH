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
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
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
  await ctx.plugin(MemorySettings, { doc: { autoreport: {} } })
  await ctx.plugin(AgentLoop, { agents: [] })

  // The resident path under test must never reach the legacy transport plane:
  // these fakes fail loud so a regression back to startContinuable is visible.
  ctx.provide('subagents', {
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
  ctx.provide('shellEnv', { register: () => () => {} } as never)
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
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'test shell stub so the THEORY denial is enforced',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'stub' }] },
    async execute() { return {} },
  }))

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
    expect(requestedToolNames(booted.mainAdapter.requests[0]!)).toContain('list_directory')

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
    // The frozen workflow route reached the child's durable identity…
    expect(descriptor?.['agentProvider']).toBe(SPECIALIST_PROVIDER)
    expect(descriptor?.['agentModel']).toBe(SPECIALIST_MODEL)
    // …and the role denial list rode the descriptor too.
    expect(descriptor?.['toolFilter']).toMatchObject({
      deny: ['send_to_agent', 'ask_user_question', 'bash'],
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
    const childTools = requestedToolNames(booted.specialistAdapter.requests[0]!)
    expect(childTools).toContain('report_workflow')
    expect(childTools).toContain('manifest')
    expect(childTools).toContain('list_directory')
    expect(childTools).not.toContain('bash')
    expect(childTools).not.toContain('send_to_agent')

    // The child's own turn ended completed — no UNKNOWN turn error.
    expect(lastTurnEndReason(child!)?.kind).toBe('completed')

    // MAIN received the structured report as a steered subagent-report message.
    const relays = relayTexts(booted.mainSession)
    expect(relays.length).toBeGreaterThanOrEqual(1)
    expect(relays.some(text => text.includes('THEORY') && text.includes('理论推导完成'))).toBe(true)
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
        && live.state.currentDelegation('task-1')?.phase !== 'waiting_for_child'
    }, 'delegation settled after child crash')

    const live = booted.runtime.forSession(booted.mainSession)
    expect(live.state.currentDelegation('task-1')?.phase).toBe('failed')
    expect(live.state.currentDelegation('task-1')?.reason).toContain('malformed prompt variable reference')
    expect(live.state.getTask('task-1')?.status).toBe('failed')
    expect(live.state.getTask('task-1')?.failedReason).toContain('malformed prompt variable reference')
  })
})
