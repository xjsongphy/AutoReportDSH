/**
 * Assembled keyless smokes over a REAL cordis context (PLAN.md §3): the host
 * plugin, the global report router, the real DSH tool pipeline (guard
 * included), and the durable workflow runtime booted together, with only the
 * transport-plane services faked (`subagents`, `commands`, `systemPrompt`,
 * `subprocess`) exactly like harness fixtures fake services under the Loader.
 *
 * Proven end to end: single role-routed continuable setup, reservation before
 * `startContinuable`, first-call authorization through the assembled guard,
 * cross-role write denial, the full delegation round trip with artifact
 * facts, `/report-init` language coexistence against external project
 * settings, and external manifest projection.
 * @module tests/integration.host
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import { apply as applyHost } from '../src/host.js'
import AutoReportWorkflowRuntime from '../src/runtime.js'
import { AUTOREPORT_MAIN_PRESET } from '../src/membership.js'
import { REQUIRED_DIRS } from '../src/workspace/init.js'
import { resolveWorkflowSettings, saveProjectSettings, workspaceIdForRoot } from '../src/settings.js'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import * as presetModule from '../src/preset.js'
import * as reportRouterModule from '../src/tools/report-router.js'

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  defaultLatexEngine: 'latexmk',
  workspaceRoot: undefined,
  specialistModel: undefined,
  executionTimeoutMs: 600_000,
}

const SIGNAL = new AbortController().signal

interface RecordedSection {
  readonly name: string
  readonly text: string
}

/** Recorder standing in for one unpublished continuable child scope. */
interface ChildRecorder {
  readonly ctx: Parameters<typeof reportRouterModule.installRoutedReportTool>[0]
  readonly toolNames: string[]
  readonly skillNames: string[]
  readonly sections: RecordedSection[]
}

function makeChildRecorder(id: string): ChildRecorder {
  const toolNames: string[] = []
  const skillNames: string[] = []
  const sections: RecordedSection[] = []
  const ctx = {
    agent: { id: SessionId(`${id}`) } as Agent,
    tools: {
      register: (tool: { name: string }) => {
        toolNames.push(tool.name)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: { name: string; text: string }) => {
        sections.push(section)
        return () => {}
      },
    },
    skills: {
      register: (skill: { name: string }) => {
        skillNames.push(skill.name)
        return () => {}
      },
    },
  }
  return { ctx: ctx as ChildRecorder['ctx'], toolNames, skillNames, sections }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** One assembled context plus every handle a scenario needs. */
interface Assembled {
  ctx: Context
  runtime: AutoReportWorkflowRuntime
  workspaceRoot: string
  home: string
  mainAgent: Agent
  mainSession: Session
  continuableSetups: ((childCtx: Parameters<typeof reportRouterModule.installRoutedReportTool>[0]) => () => void)[]
  startedSpecs: { childId: unknown; label: string }[]
  reportInitCommand: { handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> } | undefined
  presetSkillNames: string[]
}

/**
 * Boot the assembled stack on a real Context: fake transport services first,
 * then the REAL tool pipeline, then the host plugin (runtime + guard +
 * `/report-init`) and the global report router — the same rows the generated
 * overlay installs, plus the single preset-plane product contribution mounted
 * through its production `apply()` function.
 */
async function assemble(options: { projectLanguage?: 'latex' | 'typst' } = {}): Promise<Assembled> {
  const ctx = new Context()
  const workspaceRoot = makeTemp('autoreport-it-ws-')
  const home = makeTemp('autoreport-it-home-')

  // Transport-plane fakes (the Loader would supply these services; the
  // harness's own specs substitute plain objects the same way).
  const continuableSetups: Assembled['continuableSetups'] = []
  const startedSpecs: Assembled['startedSpecs'] = []
  const presetSkillNames: string[] = []
  ctx.provide('subagents', {
    registerContinuableSetup: (contribution: Assembled['continuableSetups'][number]) => {
      continuableSetups.push(contribution)
      return () => {}
    },
    startContinuable: async (spec: { childId: unknown; label: string }) => {
      // Reservation MUST precede materialization: the synchronous registry
      // authorizes the child's first tool call before this promise resolves.
      expect(ctx.autoreportWorkflow.roleRegistry.lookup(spec.childId as never)).toBeDefined()
      startedSpecs.push({ childId: spec.childId, label: spec.label })
      return { childId: spec.childId, messageId: 'accepted-msg-1' }
    },
    followup: async () => 'followup-msg-1',
    reportFrom: async () => 'report-msg-1',
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
  } as never)
  ctx.provide('subprocess', {
    resolveExecutable: async (command: string) => command,
    spawn: () => {
      throw new Error('process spawning is unused in integration smokes')
    },
  } as never)

  // The REAL model-facing tool pipeline, guards included.
  await ctx.plugin(ToolRuntime)

  if (options.projectLanguage !== undefined) {
    saveProjectSettings(home, workspaceIdForRoot(workspaceRoot), { reportLanguage: options.projectLanguage })
  }

  // Overlay row 1: the host plane (runtime service, guard, /report-init,
  // artifact observation, manifest projection).
  applyHost(ctx, { ...CONFIG, workspaceRoot }, { settingsHome: home, manifestHome: home })
  // Overlay row 2: the single global continuable-child report router.
  reportRouterModule.apply(ctx)
  // The one preset-plane product contribution: its real apply() registers
  // scoped bundled skills plus send_to_agent and report_task together.
  presetModule.apply(ctx)

  // A stand-in for the deployment's filesystem write tool: same tool NAME the
  // role guard parses, backed by a real file mutation so success results feed
  // the artifact observer.
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

  const mainSession = Session.create(SessionId('it-main'), undefined, {
    version: 0,
    id: SessionId('it-main'),
    createdAt: Date.now(),
    cwd: workspaceRoot,
    // Membership contract: the overlay owns ONLY sessions composed from this
    // preset; everything else stays stock DSH.
    agentPreset: AUTOREPORT_MAIN_PRESET,
  })
  const mainAgent = { id: SessionId('it-main'), session: mainSession } as Agent

  return {
    ctx,
    runtime: ctx.autoreportWorkflow,
    workspaceRoot,
    home,
    mainAgent,
    mainSession,
    continuableSetups,
    startedSpecs,
    reportInitCommand,
    presetSkillNames,
  }
}

let callCounter = 0

/**
 * Execute one tool call through the REAL pipeline the way the agent loop
 * does: append the durable `tool/call`, dispatch through the guard pipeline,
 * then append the correlated `tool/result`. The session-log pair is exactly
 * what the artifact observer folds in production.
 */
async function execute(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent: Agent,
  session?: Session,
): Promise<{ isError: boolean; text: string; value: unknown }> {
  callCounter += 1
  const callId = CallId(`it-${callCounter}`)
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
    signal: SIGNAL,
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

/** Append one event to a session and publish it on the context stream. */
function publish(
  ctx: Context,
  session: Session,
  type: Parameters<Session['append']>[0],
  data: unknown,
  opts?: { surfaceOp?: 'append' },
): SessionEvent {
  const event = session.append(type as never, data as never, opts as never) as SessionEvent
  ctx.emit('session/event', session, event)
  return event
}

/** Deliver one plain human text message to any root session on the context. */
function userTurn(ctx: Context, session: Session, text: string): SessionEvent {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return publish(ctx, session, 'user/message', message, { surfaceOp: 'append' })
}

/** Deliver the first user turn so the workflow initializes. */
function admitFirstTurn(assembled: Assembled): void {
  userTurn(assembled.ctx, assembled.mainSession, 'start the physics report')
}

describe('integration: assembled host (real context)', () => {
  it('registers exactly ONE continuable setup and routes it by RoleRegistry', async () => {
    const assembled = await assemble()
    expect(assembled.continuableSetups).toHaveLength(1)
    const setup = assembled.continuableSetups[0]
    if (setup === undefined) throw new Error('router registered no continuable setup')

    // Ordinary DSH child keeps the stock report implementation.
    const ordinary = makeChildRecorder('it-ordinary')
    expect(setup(ordinary.ctx)).toBeTypeOf('function')
    expect(ordinary.toolNames).toEqual(['report'])
    expect(ordinary.sections.map(section => section.name)).toContain('tool:report')

    // A RESERVED specialist routes to the structured protocol + executor.
    const binding: RoleBindingSnapshot = {
      version: AUTOREPORT_SCHEMA_VERSION,
      role: 'THEORY',
      childSessionId: SessionId('it-theory'),
      parentSessionId: assembled.mainSession.id,
      workflowId: 'wf-it',
      provisioning: 'reserved',
    }
    assembled.runtime.roleRegistry.registerReserved(binding)
    const theory = makeChildRecorder('it-theory')
    setup(theory.ctx)
    expect(theory.toolNames).toEqual(['report_workflow', 'report_exec'])
    expect(theory.skillNames).toEqual([])
    expect(theory.toolNames).not.toContain('report')
    expect(theory.sections.some(section => section.name === 'autoreport:skill:mineru')).toBe(true)
    expect(theory.sections.some(section => section.text.includes('THEORY'))).toBe(true)

    // REPORT additionally receives compile_report; nobody else does.
    const reportBinding: RoleBindingSnapshot = { ...binding, role: 'REPORT', childSessionId: SessionId('it-report') }
    assembled.runtime.roleRegistry.registerReserved(reportBinding)
    const reporter = makeChildRecorder('it-report')
    setup(reporter.ctx)
    expect(reporter.toolNames).toEqual(['report_workflow', 'report_exec', 'compile_report'])
    expect(reporter.skillNames).toEqual([])
    expect(reporter.sections.map(section => section.name)).toEqual(expect.arrayContaining([
      'autoreport:skill:experiment-report-writer',
      'autoreport:skill:latex-compile',
      'autoreport:skill:mineru',
    ]))
    const plotter = makeChildRecorder('it-plotting-bound')
    assembled.runtime.roleRegistry.registerReserved({
      ...binding, role: 'PLOTTING', childSessionId: SessionId('it-plotting-bound'),
    })
    setup(plotter.ctx)
    expect(plotter.toolNames).toEqual(['report_workflow', 'report_exec'])
    expect(plotter.skillNames).toEqual([])
  })

  it('initializes the workspace once with the frozen settings snapshot on the workflow event', async () => {
    const assembled = await assemble({ projectLanguage: 'typst' })
    expect(assembled.presetSkillNames).toEqual([])
    admitFirstTurn(assembled)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(assembled.workspaceRoot, dir))).toBe(true)
    const meta = assembled.runtime.forSession(assembled.mainSession).state.projection().meta
    expect(meta?.initialized).toBe(true)
    expect(meta?.settings?.reportLanguage).toBe('typst')
    expect(meta?.settings).toEqual(resolveWorkflowSettings({
      project: { reportLanguage: 'typst' },
      composition: { ...CONFIG, workspaceRoot: assembled.workspaceRoot },
    }))
  })

  it('runs the whole delegation round trip: reserve -> authorized first call -> denial -> report -> artifacts -> manifests', async () => {
    const assembled = await assemble()
    admitFirstTurn(assembled)

    // Task creation through the real pipeline (preset-plane availability path).
    const created = await execute(assembled.ctx, 'report_task', {
      operation: 'create',
      subject: 'Analyze the raw dataset',
      role: 'DATA_ANALYSIS',
      steps: [{ description: 'fit raw.csv' }],
    }, assembled.mainAgent, assembled.mainSession)
    expect(created.isError).toBe(false)

    // Dispatch with wait:true: resolves ONLY when the child reports.
    const dispatchPromise = execute(assembled.ctx, 'send_to_agent', {
      role: 'DATA_ANALYSIS',
      task_id: 'task-1',
      prompt: 'fit the raw data',
      wait: true,
      timeout_ms: 15_000,
    }, assembled.mainAgent, assembled.mainSession)
    await vi_waitUntil(() => assembled.startedSpecs.length > 0)
    const childId = assembled.startedSpecs[0]?.childId
    expect(typeof childId).toBe('string')
    // markActive ran after acceptance; the binding is live and active.
    const entry = assembled.runtime.roleRegistry.lookup(childId!)
    expect(entry?.binding.provisioning).toBe('active')

    const childSession = Session.create(SessionId(childId!), undefined, {
      version: 0,
      id: SessionId(childId!),
      createdAt: Date.now(),
      cwd: assembled.workspaceRoot,
      parentSession: assembled.mainSession.id,
    })
    const childAgent = { id: childSession.id, session: childSession } as Agent

    // Cross-role denial THROUGH the assembled guard: Data Analysis may not
    // touch raw inputs, only processed outputs.
    const denied = await execute(assembled.ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Data', 'raw.csv'),
      content: 'forbidden',
    }, childAgent, childSession)
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/may write only/)
    expect(existsSync(join(assembled.workspaceRoot, 'Data', 'raw.csv'))).toBe(false)

    // The AUTHORIZED first child tool call lands while still waiting_for_child.
    const allowed = await execute(assembled.ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Data', 'Processed', 'out.csv'),
      content: 'fit results',
    }, childAgent, childSession)
    expect(allowed.isError).toBe(false)
    expect(existsSync(join(assembled.workspaceRoot, 'Data', 'Processed', 'out.csv'))).toBe(true)

    // Synthetic child->parent workflow report (durable subagent-report fact).
    const envelope = {
      task_id: 'task-1',
      delegation_revision: 1,
      status: 'success',
      block_type: null,
      response: 'fit complete',
      produced_files: ['Data/Processed/out.csv'],
    }
    const reportMessage = createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: childSession.id },
    })
    publish(assembled.ctx, assembled.mainSession, 'user/message', reportMessage, { surfaceOp: 'append' })

    const dispatchResult = await dispatchPromise
    expect(dispatchResult.isError).toBe(false)
    expect(dispatchResult.value).toMatchObject({
      status: 'success',
      task_id: 'task-1',
      delegation_revision: 1,
      response: 'fit complete',
    })

    // Durable delegation state completed; artifact facts recorded with the
    // open attempt stamped on them.
    const live = assembled.runtime.forSession(assembled.mainSession)
    expect(live.state.delegationAt('task-1', 1)?.phase).toBe('completed')
    const artifacts = live.state.projection().artifacts
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Data/Processed/out.csv',
      producedBy: 'DATA_ANALYSIS',
      origin: 'fs-tool',
      status: 'created',
      taskId: 'task-1',
      delegationKey: 'task-1#1',
    })

    // External manifest projection landed under the temp HOME, keyed by the
    // workspace id — never inside the experiment workspace.
    const manifestsDir = join(assembled.home, 'autoreport', workspaceIdForRoot(assembled.workspaceRoot), 'manifests')
    const manifest = readFileSync(join(manifestsDir, 'Data', 'Processed', 'Data_Processed.json'), 'utf8')
    expect(manifest).toContain('"Data/Processed/out.csv"')
    expect(manifest).toContain('"origin": "fs-tool"')
    for (const entryName of readdirSync(assembled.workspaceRoot, { recursive: true })) {
      expect(String(entryName)).not.toMatch(/manifest/i)
    }

    await assembled.ctx.fiber?.dispose()
  })

  it('/report-init is membership-gated, then switches languages without deleting either backend', async () => {
    const assembled = await assemble()
    const command = assembled.reportInitCommand
    if (command === undefined) throw new Error('/report-init was not registered by the host plugin')

    // The command service is host-global, so a stock caller must be rejected
    // BEFORE settings persistence or workspace materialization.
    const stockCwd = makeTemp('autoreport-it-report-init-stock-')
    const stockSession = Session.create(SessionId('it-report-init-stock'), undefined, {
      version: 0,
      id: SessionId('it-report-init-stock'),
      createdAt: Date.now(),
      cwd: stockCwd,
    })
    const rejected = await command.handler({
      rawInput: '--language typst',
      agent: { session: stockSession },
    }) as { kind: string; text?: string }
    expect(rejected.kind).toBe('error')
    expect(rejected.text).toContain("only in an 'autoreport-main' session")
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(stockCwd, dir))).toBe(false)
    expect(existsSync(join(assembled.home, 'autoreport', workspaceIdForRoot(stockCwd), 'project.json'))).toBe(false)

    admitFirstTurn(assembled)
    const invoke = (rawInput: string) => command.handler({
      rawInput,
      agent: { session: assembled.mainSession },
    }) as Promise<{ kind: string; text?: string }>

    // Snapshot before: the in-flight workflow keeps its creation-time settings.
    const before = assembled.runtime.forSession(assembled.mainSession).state.projection().meta?.settings

    const typst = await invoke('--language typst')
    expect(typst.kind).toBe('success')
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'main.typ'))).toBe(true)
    expect(readFileSync(join(assembled.home, 'autoreport', workspaceIdForRoot(assembled.workspaceRoot), 'project.json'), 'utf8'))
      .toContain('"typst"')

    const latex = await invoke('--language latex')
    expect(latex.kind).toBe('success')
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'main.tex'))).toBe(true)
    // No deletions: Typst resources coexist with the LaTeX set.
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'main.typ'))).toBe(true)
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'mplts.typ'))).toBe(true)
    expect(readFileSync(join(assembled.home, 'autoreport', workspaceIdForRoot(assembled.workspaceRoot), 'project.json'), 'utf8'))
      .toContain('"latex"')

    // The durable snapshot NEVER adopts the later project change (PLAN §2.14).
    const after = assembled.runtime.forSession(assembled.mainSession).state.projection().meta?.settings
    expect(after).toEqual(before)
  })

  it('releases Main guard restrictions when an admitted root switches away from autoreport-main', async () => {
    const assembled = await assemble()
    admitFirstTurn(assembled)
    const initiallyDenied = await execute(assembled.ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Report', 'main.tex'),
      content: 'denied while MAIN',
    }, assembled.mainAgent, assembled.mainSession)
    expect(initiallyDenied.isError).toBe(true)

    // Effective membership follows the newest selection, rather than historical
    // workflow admission. The global guard must now pass this root through.
    publish(assembled.ctx, assembled.mainSession, 'agent-preset/selected', { agentPreset: 'minimal' })
    expect(assembled.runtime.isMainSession(assembled.mainSession.id)).toBe(false)
    expect(assembled.runtime.ownsSession(assembled.mainSession)).toBe(false)
    const released = await execute(assembled.ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Report', 'main.tex'),
      content: 'stock policy restored after preset switch',
    }, assembled.mainAgent, assembled.mainSession)
    expect(released.isError).toBe(false)
    expect(readFileSync(join(assembled.workspaceRoot, 'Report', 'main.tex'), 'utf8')).toContain('stock policy restored')

    await assembled.ctx.fiber?.dispose()
  })

  it('stock-session-is-untouched: a standard session in a loaded deployment keeps stock behavior', async () => {
    const assembled = await assemble()
    const ctx = assembled.ctx

    // A fixture unrestricted shell tool, as stock presets mount and AutoReport
    // presets omit: its fate is the sharpest coexistence signal.
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'fixture unrestricted executor',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute() { return { ran: true } },
    }))

    // An ordinary top-level DSH session — no agentPreset — in the SAME loaded
    // deployment, with its own cwd OUTSIDE the experiment workspace.
    const stockCwd = makeTemp('autoreport-it-stock-')
    const stockSession = Session.create(SessionId('it-stock'), undefined, {
      version: 0,
      id: SessionId('it-stock'),
      createdAt: Date.now(),
      cwd: stockCwd,
    })
    const stockAgent = { id: stockSession.id, session: stockSession } as Agent

    // Ordinary first user turn.
    userTurn(ctx, stockSession, 'just answer my question')

    expect(assembled.runtime.isMainSession(stockSession.id)).toBe(false)
    expect(assembled.runtime.ownsSession(stockSession)).toBe(false)
    expect(stockSession.events.some(event => event.type.startsWith('autoreport/'))).toBe(false)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(stockCwd, dir))).toBe(false)
    // Not even the configured experiment workspace was touched by the stock turn.
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(assembled.workspaceRoot, dir))).toBe(false)

    // Stock write policy: arbitrary locations stay writable through the REAL
    // guarded pipeline — the global role guard must pass foreign callers through.
    const freeWrite = await execute(ctx, 'write', {
      file_path: join(stockCwd, 'notes.txt'),
      content: 'stock DSH writes wherever it likes',
    }, stockAgent, stockSession)
    expect(freeWrite.isError).toBe(false)
    expect(existsSync(join(stockCwd, 'notes.txt'))).toBe(true)

    // Stock shell policy: the unrestricted executor stays available.
    const shell = await execute(ctx, 'bash', { command: 'true' }, stockAgent, stockSession)
    expect(shell.isError).toBe(false)

    // Coexistence both ways: the autoreport-main session still initializes on
    // ITS first turn, and the guard still restricts it to Outline writes.
    admitFirstTurn(assembled)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(assembled.workspaceRoot, dir))).toBe(true)
    const mainWrite = await execute(ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Report', 'main.tex'),
      content: 'forbidden for MAIN',
    }, assembled.mainAgent, assembled.mainSession)
    expect(mainWrite.isError).toBe(true)
    expect(mainWrite.text).toContain('Outline')
    const outlineWrite = await execute(ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Outline', 'plan.md'),
      content: 'allowed for MAIN',
    }, assembled.mainAgent, assembled.mainSession)
    expect(outlineWrite.isError).toBe(false)

    await ctx.fiber?.dispose()
  })
})

/** Tiny polling helper; avoids importing vitest's waitFor into every test. */
async function vi_waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
