/**
 * Shared assembled-host harness for integration smokes and workflow evals.
 * Boots the real host plugin, report router, preset contribution, and DSH
 * tool pipeline with transport-plane fakes.
 * @module tests/helpers/assembled-host
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../../src/config.js'
import { apply as applyHost } from '../../src/host.js'
import { AUTOREPORT_MAIN_PRESET } from '../../src/membership.js'
import AutoReportWorkflowRuntime from '../../src/runtime.js'
import { saveProjectSettings, workspaceIdForRoot } from '../../src/settings.js'
import { installWorkflowReportTool } from '../../src/tools/report-workflow.js'
import { TURN_GUARD_PLUGIN } from '../../src/workflow/display.js'
import * as presetModule from '../../src/preset.js'
import * as reportRouterModule from '../../src/tools/report-router.js'
import type { SpecialistRole } from '../../src/roles.js'
import { ISOLATED_PYTHON_DETECT } from './managed-python-stub.js'
import { loadBundledSkills } from '../../src/workspace/skill-loader.js'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { reportSkillRequirements } from '../../src/skills-preset.js'

export const ASSEMBLED_CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationIdleTimeoutMs: 60_000,
  delegationWaitTimeoutMs: 600_000,
}

export const TOOL_SIGNAL = new AbortController().signal

export interface RecordedSection {
  readonly name: string
  readonly text: string
}

export interface ChildRecorder {
  readonly agent: Agent
  readonly ctx: Parameters<typeof reportRouterModule.installRoutedReportTool>[0]
  readonly toolNames: string[]
  readonly skillNames: string[]
  readonly sections: RecordedSection[]
}

export function makeChildRecorder(
  id: string,
  workflow?: AutoReportWorkflowRuntime,
  cwd?: string,
): ChildRecorder {
  const toolNames: string[] = []
  const skillNames: string[] = []
  const sections: RecordedSection[] = []
  const skillsService = {
    register: (skill: { name: string }) => {
      skillNames.push(skill.name)
      return () => {}
    },
    registerProvider: () => () => {},
  }
  // A real child always carries a session; the router applies the role sandbox
  // to it and the skill gate resolves its identity from it.
  const sessionId = SessionId(`${id}`)
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: sessionId,
    createdAt: Date.now(),
    cwd: cwd ?? tmpdir(),
    parentSession: SessionId('main'),
  })
  const agent = { id: sessionId, session } as Agent
  const ctx = {
    get: (name: string) => name === 'skills' ? skillsService : undefined,
    tools: {
      register: (tool: { name: string }) => {
        toolNames.push(tool.name)
        return () => {}
      },
      restrict: () => () => {},
    },
    systemPrompt: {
      section: (section: { name: string; text: string }) => {
        sections.push(section)
        return () => {}
      },
    },
    skills: skillsService,
    inject: (names: readonly string[], handler: (scope: unknown) => void) => {
      void names
      handler(ctx)
      return { dispose: async () => {} }
    },
    autoreportWorkflow: workflow,
  }
  ;(agent as { ctx?: unknown }).ctx = ctx
  return { agent, ctx: ctx as ChildRecorder['ctx'], toolNames, skillNames, sections }
}

export interface Assembled {
  ctx: Context
  runtime: AutoReportWorkflowRuntime
  workspaceRoot: string
  home: string
  mainAgent: Agent
  mainSession: Session
  routeChild: (recorder: ChildRecorder) => void
  /** The routed recorder owning one child session, when a test routed it. */
  recorderFor: (sessionId: SessionId) => ChildRecorder | undefined
  startedSpecs: { childId: unknown; label: string; prompt: string }[]
  reportInitCommand: { handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> } | undefined
  presetSkillNames: string[]
  skillProviders: string[]
  pythonResolve: (execution: { agent?: { session: Session } }) => Record<string, string>
  setFollowup: (impl: () => Promise<string>) => void
  ownedDirs: string[]
}

export interface AssembleOptions {
  projectLanguage?: 'latex' | 'typst'
  pythonExecutable?: string
  workspaceRoot?: string
  home?: string
  mainSession?: Session
  mainSessionId?: string
  followup?: () => Promise<string>
}

let callCounter = 0

export async function assemble(options: AssembleOptions = {}): Promise<Assembled> {
  const ctx = new Context()
  const ownedDirs: string[] = []
  const workspaceRoot = options.workspaceRoot ?? (() => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreport-it-ws-'))
    ownedDirs.push(dir)
    return dir
  })()
  const home = options.home ?? (() => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreport-it-home-'))
    ownedDirs.push(dir)
    return dir
  })()

  const startedSpecs: Assembled['startedSpecs'] = []
  const presetSkillNames: string[] = []
  const skillProviders: string[] = []
  let followupImpl: () => Promise<string> = options.followup ?? (async () => 'followup-msg-1')
  let pythonResolver: (execution: { agent?: { session: Session } }) => Record<string, string> = () => ({})

  const sessionId = SessionId(options.mainSessionId ?? options.mainSession?.id ?? 'it-main')
  const mainSession = options.mainSession ?? Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: sessionId,
    createdAt: Date.now(),
    cwd: workspaceRoot,
    agentPreset: AUTOREPORT_MAIN_PRESET,
  })
  const mainAgent = {
    id: mainSession.id,
    session: mainSession,
    steer: (message: UserMessage) => {
      publish(ctx, mainSession, 'user/message', message, { surfaceOp: 'append' })
    },
  } as Agent

  ctx.provide('subagents', {
    startContinuable: async (spec: {
      childId: unknown
      label: string
      request?: { prompt?: { type: string; text?: string }[] }
    }) => {
      expect(ctx.autoreportWorkflow.roleRegistry.lookup(spec.childId as never)).toBeDefined()
      startedSpecs.push({
        childId: spec.childId,
        label: spec.label,
        prompt: (spec.request?.prompt ?? []).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join(''),
      })
      return { childId: spec.childId, messageId: 'accepted-msg-1' }
    },
    followup: async () => followupImpl(),
    [deliverSubagentPrompt]: async () => followupImpl(),
    sendMessage: async (agent: Agent, targetId: SessionId, content: { type: string; text?: string }[]) => {
      // Adjacent-agent messaging replaced the stock report relay; the child's
      // structured report reaches MAIN as a relayed user message.
      const target = String(targetId) === String(mainSession.id) ? mainSession : undefined
      if (target !== undefined) {
        const message = createUserMessage({
          content,
          source: { kind: 'subagent-report', form: 'relay', senderSessionId: agent.id },
        })
        publish(ctx, target, 'user/message', message, { surfaceOp: 'append' })
      }
      return 'report-msg-1'
    },
  } as never)
  let reportInitCommand: Assembled['reportInitCommand']
  ctx.provide('commands', {
    register: (definition: Assembled['reportInitCommand']) => {
      reportInitCommand = definition
      return () => {}
    },
  } as never)
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
  } as never)
  ctx.provide('skills', {
    register: (registration: { name: string }) => {
      presetSkillNames.push(registration.name)
      return () => {}
    },
    registerProvider: (factory: () => { name?: string }) => {
      const provider = factory()
      if (typeof provider.name === 'string') skillProviders.push(provider.name)
      return () => {}
    },
  } as never)
  ctx.provide('shellEnv', {
    register: (contributor: {
      resolve: (execution: { agent?: { session: Session } }) => Record<string, string>
    }) => {
      pythonResolver = contributor.resolve
      return () => {}
    },
  } as never)
  ctx.provide('subprocess', {
    resolveExecutable: async (command: string) => command,
    spawn: () => {
      throw new Error('process spawning is unused in assembled host tests')
    },
  } as never)

  await ctx.plugin(ToolRuntime)

  const projectPatch: { reportLanguage?: 'latex' | 'typst'; pythonExecutable?: string } = {
    ...(options.projectLanguage === undefined ? {} : { reportLanguage: options.projectLanguage }),
    ...(options.pythonExecutable === undefined ? {} : { pythonExecutable: options.pythonExecutable }),
  }
  if (Object.keys(projectPatch).length > 0) {
    saveProjectSettings(home, workspaceIdForRoot(workspaceRoot), projectPatch)
  }

  await applyHost(ctx, { ...ASSEMBLED_CONFIG, workspaceRoot }, {
    settingsHome: home,
    pythonDetect: ISOLATED_PYTHON_DETECT,
  })
  reportRouterModule.apply(ctx)
  presetModule.apply(ctx)

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'fixture filesystem write',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: 'written' }],
    },
    async execute(args) {
      writeFileSync(String(args.file_path), String(args.content))
      return { path: args.file_path }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'fixture filesystem edit',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: 'edited' }],
    },
    async execute(args) {
      writeFileSync(String(args.file_path), String(args.content))
      return { path: args.file_path }
    },
  }))

  installWorkflowReportTool({
    agent: mainAgent,
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
  } as never, ctx, 'THEORY')

  const recorders = new Map<string, ChildRecorder>()

  return {
    ctx,
    runtime: ctx.autoreportWorkflow,
    workspaceRoot,
    home,
    mainAgent,
    mainSession,
    routeChild: (recorder: ChildRecorder) => {
      recorders.set(String(recorder.agent.id), recorder)
      ctx.emit('agent/created', { agent: recorder.agent, source: 'fresh' } as never)
    },
    recorderFor: (sessionId: SessionId) => recorders.get(String(sessionId)),
    startedSpecs,
    reportInitCommand,
    presetSkillNames,
    skillProviders,
    pythonResolve: execution => pythonResolver(execution),
    setFollowup: impl => { followupImpl = impl },
    ownedDirs,
  }
}

export async function disposeAssembled(assembled: Assembled): Promise<void> {
  await assembled.ctx.fiber?.dispose()
  for (const dir of assembled.ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export async function execute(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent: Agent,
  session?: Session,
): Promise<{ isError: boolean; text: string; value: unknown }> {
  callCounter += 1
  const callId = ToolCallId(`it-${callCounter}`)
  const callSeq = session === undefined
    ? undefined
    : publish(ctx, session, 'tool/call', {
        turn: 1,
        step: callCounter,
        callId: String(callId),
        name,
        arguments: JSON.stringify(args),
      }).seq
  const result = await ctx.tools.execute({
    signal: TOOL_SIGNAL,
    callId,
    name,
    arguments: args,
    agent,
  })
  if (session !== undefined && callSeq !== undefined) {
    publish(ctx, session, 'tool/result', {
      turn: 1,
      step: callCounter,
      message: {
        role: 'user',
        id: `it-msg-${callCounter}`,
        content: [{
          type: 'tool-result',
          toolCallId: String(callId),
          content: result.content,
          isError: result.isError ?? false,
        }],
        source: { kind: 'tool', callId: String(callId) },
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }
  const text = result.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
  return { isError: result.isError ?? false, text, value: result.value }
}

export function publish(
  ctx: Context,
  session: Session,
  type: Parameters<Session['append']>[0],
  data: unknown,
  opts?: { surfaceOp?: 'append'; sourceEventSeqs?: number[] },
): SessionEvent {
  const event = session.append(type as never, data as never, opts as never) as SessionEvent
  ctx.emit('session/event', session, event)
  return event
}

export function userTurn(ctx: Context, session: Session, text: string): SessionEvent {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return publish(ctx, session, 'user/message', message, { surfaceOp: 'append' })
}

export function admitFirstTurn(assembled: Assembled): void {
  userTurn(assembled.ctx, assembled.mainSession, 'start the physics report')
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function dispatch(
  assembled: Assembled,
  args: { role: SpecialistRole; prompt: string; task_id?: string; subject?: string },
): Promise<{ childId: string; childSession: Session; childAgent: Agent; value: Record<string, unknown> }> {
  const result = await execute(assembled.ctx, 'send_to_agent', {
    ...args,
    wait: false,
  }, assembled.mainAgent, assembled.mainSession)
  expect(result.isError).toBe(false)
  const value = result.value as Record<string, unknown>
  const binding = assembled.runtime.forSession(assembled.mainSession).state.bindingForRole(args.role)
  if (binding === undefined) throw new Error(`no binding for ${args.role}`)
  const childId = String(binding.childSessionId)
  const childSession = Session.create(SessionId(childId), undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(childId),
    createdAt: Date.now(),
    cwd: assembled.workspaceRoot,
    parentSession: assembled.mainSession.id,
  })
  const childAgent = {
    id: childSession.id,
    session: childSession,
    steer: (message: UserMessage) => {
      publish(assembled.ctx, childSession, 'user/message', message, { surfaceOp: 'append' })
    },
  } as Agent
  return { childId, childSession, childAgent, value }
}

export async function reportWorkflow(
  assembled: Assembled,
  child: { childAgent: Agent; childSession: Session },
  envelope: {
    task_id: string
    delegation_revision: number
    status: 'success' | 'blocked'
    response: string
    produced_files?: string[]
    block_type?: 'missing_data' | 'quality'
  },
): Promise<{ isError: boolean; text: string; value: unknown }> {
  return execute(assembled.ctx, 'report_workflow', {
    task_id: envelope.task_id,
    delegation_revision: envelope.delegation_revision,
    status: envelope.status,
    response: envelope.response,
    produced_files: envelope.produced_files ?? [],
    ...(envelope.block_type === undefined ? {} : { block_type: envelope.block_type }),
  }, child.childAgent, child.childSession)
}

export async function updateManifest(
  assembled: Assembled,
  child: { childAgent: Agent; childSession: Session },
  files: ReadonlyArray<{ path: string; description: string }>,
): Promise<{ isError: boolean; text: string; value: unknown }> {
  return execute(assembled.ctx, 'manifest', {
    action: 'update',
    files: files.map(file => ({ path: file.path, description_new: file.description })),
  }, child.childAgent, child.childSession)
}

export function stopTurn(assembled: Assembled, agent: Agent, turn = 1): void {
  assembled.ctx.emit('agent/turn-stopping', { agent, turn, signal: TOOL_SIGNAL })
}

export function specialistSkills(assembled: Assembled, childId: string): ChildRecorder {
  const recorder = makeChildRecorder(childId, assembled.runtime, assembled.workspaceRoot)
  assembled.routeChild(recorder)
  return recorder
}

/** Marker in the skill gate's refusal, used to tell it apart from a real failure. */
export const SKILL_GATE_REFUSAL = 'AutoReport refused this'

/**
 * Record one `skill` tool call the way dsh's own tool produces it: a closed
 * step carrying a `tool/call` paired with a `tool/result` that returns the
 * rendered body. The skill gate reads exactly this, so this is the honest
 * stand-in for the model loading a skill itself.
 */
export function loadSkill(assembled: Assembled, child: { childSession: Session }, name: string): void {
  const skill = loadBundledSkills().find(entry => entry.name === name)
  if (skill === undefined) throw new Error(`no bundled skill named ${name}`)
  const session = child.childSession
  const callId = `skill-${name}`
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/end').length + 1
  const step = 1
  publish(assembled.ctx, session, 'turn/start', { turn })
  publish(assembled.ctx, session, 'step/start', { turn, step })
  publish(assembled.ctx, session, 'tool/call', {
    turn,
    step,
    callId,
    name: 'skill',
    arguments: JSON.stringify({ name }),
  })
  publish(assembled.ctx, session, 'tool/result', {
    turn,
    step,
    message: {
      role: 'user',
      id: `m-${callId}`,
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{
          type: 'text',
          text: renderSkillContent({ name: skill.name, provider: 'runtime', content: skill.content }),
        }],
        isError: false,
      }],
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })
  publish(assembled.ctx, session, 'step/end', { turn, step })
  publish(assembled.ctx, session, 'turn/end', { turn })
}

/**
 * Write one workspace file as a specialist does.
 *
 * A REPORT child's first write is refused by the skill gate. The gate injects
 * nothing, so the live loop answers by having the child load the governing
 * skills itself and retry. Reproducing that here keeps every eval trace on the
 * real gate instead of sidestepping it.
 */
export async function specialistWrite(
  assembled: Assembled,
  child: { childAgent: Agent; childSession: Session },
  relativePath: string,
  content: string,
): Promise<void> {
  const file_path = join(assembled.workspaceRoot, relativePath)
  mkdirSync(dirname(file_path), { recursive: true })
  const args = { file_path, content }
  const first = await execute(assembled.ctx, 'write', args, child.childAgent, child.childSession)
  if (!first.isError) return
  if (!first.text.includes(SKILL_GATE_REFUSAL)) throw new Error(first.text)
  const required = reportSkillRequirements(assembled.runtime.reportLanguageForChild(child.childSession.id))
  for (const name of [...required.writing, required.compile]) loadSkill(assembled, child, name)
  const retry = await execute(assembled.ctx, 'write', args, child.childAgent, child.childSession)
  expect(retry.isError).toBe(false)
}

export function eventTypes(session: Session): string[] {
  return session.snapshotEvents().map(event => event.type)
}

export function userMessages(session: Session): UserMessage[] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map(event => event.data)
}

/** Turn-stopping steers persisted on the session as plugin notices. */
export function turnGuardSteers(session: Session): UserMessage[] {
  return userMessages(session).filter(message => {
    const source = message.source
    return source.kind === 'plugin' && source.plugin === TURN_GUARD_PLUGIN
  })
}

export function messageSource(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { source?: Record<string, unknown> }).source
  return source
}

export function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: { type: string; text?: string }[] }).content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}
