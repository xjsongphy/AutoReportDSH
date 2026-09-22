import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemorySettings } from './helpers/memory-settings.js'
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import AutoReportWorkflowRuntime from '../src/runtime.js'
import { AUTOREPORT_MAIN_PRESET, isAutoReportMainSession } from '../src/membership.js'
import { REQUIRED_DIRS } from '../src/workspace/init.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AUTOREPORT_SETTINGS_NAMESPACE, resolveWorkflowSettings, saveProjectSettings, workspaceIdForRoot } from '../src/settings.js'
import { ISOLATED_PYTHON_DETECT } from './helpers/managed-python-stub.js'
import { AUTOREPORT_SCHEMA_VERSION } from '../src/workflow/events.js'
import { appendWorkflowEvent } from '../src/workflow/store.js'
import { workflowRecords } from './helpers/workflow-log.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationIdleTimeoutMs: 60_000,
  delegationWaitTimeoutMs: 600_000,
}

/** A detached root session whose header names its composing agent preset. */
function rootSession(id: string, preset: string | undefined, cwd?: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(id),
    createdAt: Date.now(),
    ...(preset === undefined ? {} : { agentPreset: preset }),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

function createRuntime(
  ctx: Context,
  config: Config,
  extra: ConstructorParameters<typeof AutoReportWorkflowRuntime>[2] = {},
): AutoReportWorkflowRuntime {
  return new AutoReportWorkflowRuntime(ctx, config, { pythonDetect: ISOLATED_PYTHON_DETECT, ...extra })
}

describe('host workflow runtime', () => {
  it('initializes the experiment workspace once and records workflow metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = rootSession('main', AUTOREPORT_MAIN_PRESET)
    runtime.maybeInitialize(session)
    for (const dir of REQUIRED_DIRS) {
      expect(existsSync(join(root, dir))).toBe(true)
    }
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)
    const meta = runtime.forSession(session).state.projection().meta
    expect(meta?.initialized).toBe(true)
    expect(meta?.workspaceRoot).toBe(root)
    // The resolved settings snapshot is committed with the workflow event.
    expect(meta?.settings).toEqual(resolveWorkflowSettings({ composition: { ...CONFIG, workspaceRoot: root } }))
    // Workflow metadata is orchestration state, not the filesystem readiness
    // marker: an explicit initialization pass still repairs a missing folder.
    rmSync(join(root, 'Outline'), { recursive: true, force: true })
    runtime.maybeInitialize(session)
    expect(existsSync(join(root, 'Outline'))).toBe(true)
    expect(runtime.forSession(session).state.projection().meta?.initialized).toBe(true)
  })

  it('snapshots the registered DSH autoreport user settings for a new workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    tempDirs.push(root, home)
    const ctx = new Context()
    await ctx.plugin(MemorySettings, {
      doc: {
        autoreport: {
          defaultReportLanguage: 'typst',
          specialistModel: { provider: 'specialist', model: 'reasoning-model', reasoningEffort: 'high' },
          delegationWaitTimeoutMs: 12_345,
        },
      },
    })
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
    await vi.waitFor(() => {
      const section = ctx.settings.describe().find(entry => entry.ns === 'autoreport')
      expect(section?.value).toMatchObject({ defaultReportLanguage: 'typst', delegationWaitTimeoutMs: 12_345 })
    })
    const session = rootSession('main-user-settings', AUTOREPORT_MAIN_PRESET)
    runtime.maybeInitialize(session)
    expect(runtime.forSession(session).state.projection().meta?.settings).toEqual({
      reportLanguage: 'typst',
      specialistModel: { inheritMain: false, provider: 'specialist', model: 'reasoning-model', reasoningEffort: 'high' },
      delegationIdleTimeoutMs: 60_000,
      delegationWaitTimeoutMs: 12_345,
    })
  })

  it('resolves the language from external project settings, never the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    tempDirs.push(root, home)
    saveProjectSettings(home, workspaceIdForRoot(root), { reportLanguage: 'typst' })
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
    const session = rootSession('main', AUTOREPORT_MAIN_PRESET)
    runtime.maybeInitialize(session)
    const meta = runtime.forSession(session).state.projection().meta
    expect(meta?.language).toBe('typst')
    expect(meta?.settings?.reportLanguage).toBe('typst')
    // Typst resources materialize; no LaTeX template ever lands in the workspace.
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
  })

  it('does not treat continuable children as Main parents', () => {
    const ctx = new Context()
    const runtime = createRuntime(ctx, CONFIG)
    const child = Session.create(SessionId('child'), undefined, {
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
      id: SessionId('child'),
      createdAt: Date.now(),
      parentSession: SessionId('main'),
    })
    ctx.emit('session/event', child, child.append('turn/start', { turn: 1 }))
    expect(runtime.isMainSession(SessionId('child'))).toBe(false)
    expect(() => runtime.forSession(child)).toThrow(/owned by Main/)
  })

  it('pauses a bound child delegation idle timer from Harness agent status', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const runtime = createRuntime(ctx, CONFIG)
      const session = rootSession('main-liveness', AUTOREPORT_MAIN_PRESET)
      const live = runtime.forSession(session)
      const childId = SessionId('child-liveness')
      runtime.roleRegistry.registerReserved({
        version: AUTOREPORT_SCHEMA_VERSION,
        role: 'THEORY',
        childSessionId: childId,
        parentSessionId: session.id,
        workflowId: 'wf-liveness',
        provisioning: 'reserved',
      })
      const pending = live.waiters.wait('task-1#1', {
        childSessionId: String(childId),
        idleTimeoutMs: 100,
        hardTimeoutMs: 1_000,
      })
      ctx.emit('agent/status', { agent: { id: childId } as never, status: 'running' })
      await vi.advanceTimersByTimeAsync(150)
      expect(live.waiters.pendingKeys()).toBe(1)
      ctx.emit('agent/status', { agent: { id: childId } as never, status: 'idle' })
      await vi.advanceTimersByTimeAsync(100)
      await expect(pending).resolves.toEqual({ status: 'timed_out' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves stock sessions untouched: no membership, no initialization, no workflow events', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })

    // An ordinary top-level DSH session without the AutoReport preset…
    const stock = rootSession('stock-main', undefined)
    expect(isAutoReportMainSession(stock)).toBe(false)

    // …producing a normal first user turn must not join the runtime…
    const message = createUserMessage({
      content: [{ type: 'text', text: 'just answer my question' }],
      source: { kind: 'user' },
    })
    ctx.emit('session/event', stock, stock.append('user/message', message, { surfaceOp: 'append' }))

    // …and must show none of the AutoReport side effects.
    expect(runtime.isMainSession(SessionId('stock-main'))).toBe(false)
    expect(runtime.ownsSession(stock)).toBe(false)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(root, dir))).toBe(false)
    expect(stock.snapshotEvents().some(event => event.type.startsWith('autoreport/'))).toBe(false)
    expect(stock.snapshotEvents().some(event => event.type === 'sandbox/mode')).toBe(false)
    expect(stock.snapshotEvents().some(event => event.type === 'sandbox/workspace-root')).toBe(false)
    expect(() => runtime.forSession(stock)).toThrow(/requires the 'autoreport' preset/)
  })

  it('admits autoreport roots and releases Main membership after a later preset switch', () => {
    const ctx = new Context()
    const runtime = createRuntime(ctx, CONFIG)
    const session = rootSession('switchable', AUTOREPORT_MAIN_PRESET)
    ctx.emit('session/event', session, session.append('turn/start', { turn: 1 }))
    expect(runtime.isMainSession(SessionId('switchable'))).toBe(true)
    expect(runtime.ownsSession(session)).toBe(true)

    // A blank session may change presets; the newest logged selection wins and
    // ends AutoReport ownership (DSH's own resolveSessionPreset semantics).
    session.append('agent-preset/selected', { agentPreset: 'other-preset' })
    expect(isAutoReportMainSession(session)).toBe(false)
    expect(runtime.isMainSession(SessionId('switchable'))).toBe(false)
    expect(runtime.ownsSession(session)).toBe(false)
  })

  it('does not pin MAIN sandbox when autoreport is selected then switched before any turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = rootSession('blank-switch', undefined, root)

    session.append('agent-preset/selected', { agentPreset: AUTOREPORT_MAIN_PRESET })
    ctx.emit('session/event', session, session.snapshotEvents().at(-1)!)
    session.append('agent-preset/selected', { agentPreset: 'standard' })
    ctx.emit('session/event', session, session.snapshotEvents().at(-1)!)

    expect(session.snapshotEvents().some(event => event.type === 'sandbox/mode')).toBe(false)
    expect(runtime.ownsSession(session)).toBe(false)
  })

  it('pins MAIN sandbox mode to workspace-write after the first user message on autoreport', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = rootSession('main-sandbox', AUTOREPORT_MAIN_PRESET, root)

    const message = createUserMessage({
      content: [{ type: 'text', text: 'start the report' }],
      source: { kind: 'user' },
    })
    ctx.emit('session/event', session, session.append('user/message', message, { surfaceOp: 'append' }))

    expect(runtime.ownsSession(session)).toBe(true)
    const modeEvents = session.snapshotEvents().filter(event => event.type === 'sandbox/mode')
    expect(modeEvents.map(event => event.data)).toEqual([{ mode: 'workspace-write' }])
    expect(runtime.roleFor('main-sandbox')).toBe('MAIN')
  })

  it('maps bound children and Main through roleFor and leaves stock sessions undefined', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = rootSession('role-lookup', AUTOREPORT_MAIN_PRESET, root)
    ctx.emit('session/event', session, session.append('turn/start', { turn: 1 }))

    expect(runtime.roleFor('role-lookup')).toBe('MAIN')
    expect(runtime.roleFor('no-such-session')).toBeUndefined()
  })



  it('wraps a mounted sandbox policy so an owned MAIN session resolves its role root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const fake = {
      resolve: (request: { session?: { id: unknown } } = {}) => {
        void request
        return { mode: 'workspace-write', workspaceRoot: root }
      },
    }
    ctx.provide('sandboxPolicy', fake as never)
    ctx.provide('tools', { guard: () => () => {} } as never)
    const { apply: applyHost } = await import('../src/host.js')
    await applyHost(ctx, { ...CONFIG, workspaceRoot: root }, {
      pythonDetect: ISOLATED_PYTHON_DETECT,
    })

    const session = rootSession('wrap-main', AUTOREPORT_MAIN_PRESET, root)
    ctx.emit('session/event', session, session.append('turn/start', { turn: 1 }))

    expect(fake.resolve({ session }).workspaceRoot).toBe(resolve(root, 'Outline'))
    // A foreign session keeps the stock root.
    const stock = rootSession('stock-wrap', undefined, root)
    expect(fake.resolve({ session: stock }).workspaceRoot).toBe(root)
  })

  it('resident setup joins the parent preset before restricting coordinator tools', async () => {
    // Regression: the retargeted direct-creation path dropped the composeFrom
    // join its applyChildComposition predecessor performed. On a real host the
    // child scope then inherits no preset layer, so preset-plane names are not
    // restrictable and tools.restrict() rejected the deny-list, failing every
    // send_to_agent dispatch (session log 2bdd1396). The fake agents double
    // here RUNS the production setup against a mock child context so the
    // optional-chaining short circuit cannot mask the seam again.
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const session = rootSession('preset-join-main', AUTOREPORT_MAIN_PRESET, root)
    const mainAgent = { id: session.id, session, options: {}, ctx: { get: () => undefined } } as unknown as Agent
    // The join result flips mid-test: a parent that joined no preset must not
    // name preset-plane tools, so the deny-list is skipped, not rejected.
    let joinResult: string | undefined = AUTOREPORT_MAIN_PRESET
    const composeFrom = vi.fn(() => joinResult)
    const section = vi.fn(() => {})
    const restrict = vi.fn(() => () => {})
    const createChild = async (options: {
      sessionId: SessionId
      setup?: (childCtx: Context, agent: Agent) => unknown
    }): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
      const childCtx = {
        get: (key: string) => key === 'agentPresets' ? { composeFrom } : undefined,
        systemPrompt: { section, getSectionOrder: () => 0 },
        tools: { restrict },
        inject: async () => {},
      } as unknown as Context
      await options.setup?.(childCtx, { id: options.sessionId } as Agent)
      const child = Session.create(options.sessionId, undefined, {
        version: SESSION_FORMAT_VERSION,
        isSeeded: false,
        id: options.sessionId,
        createdAt: Date.now(),
        parentSession: session.id,
      })
      return { agent: { id: child.id, session: child } as Agent, dispose: async () => {} }
    }
    ctx.provide('agents', {
      list: () => [mainAgent],
      get: (id: SessionId) => id === mainAgent.id ? mainAgent : undefined,
      create: createChild,
      resume: createChild,
    } as never)
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    await runtime.ensureResidentRole(mainAgent, 'THEORY')

    expect(composeFrom).toHaveBeenCalledTimes(1)
    expect(composeFrom.mock.calls[0]?.[0]).toBeTypeOf('object')
    // The persona section shadows the deployment persona and the deny-list
    // lands on the coordinator tools — but only after the join succeeded.
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'deployment:persona-prefix' }))
    expect(restrict).toHaveBeenCalledWith({ deny: ['send_to_agent', 'ask_user_question'] })

    // Unjoined parent: nothing preset-plane is restrictable, so the deny-list
    // is skipped rather than rejected.
    joinResult = undefined
    restrict.mockClear()
    await runtime.ensureResidentRole(mainAgent, 'DATA_ANALYSIS')
    expect(composeFrom).toHaveBeenCalledTimes(2)
    expect(restrict).not.toHaveBeenCalled()
  })

  it('starts a resident child on the parent request route and gives it a durable identity', async () => {
    // Regression: residents created directly by this runtime read their route
    // off `parent.options` alone. DSH resolves a delegation's route from the
    // latest request header first (`parentAgentOptionsForDelegation` in
    // @deepseek-ai/dsh-subagent/child-agent), so a Main whose creation options
    // carry no route produced children that died on their first step with
    // `has no provider/model` (session 70e9fb99 → children 877b9437, 6e57e8d7).
    // Those same children lacked the `subagent/descriptor` every provider
    // appends, so DSH's catalog could never classify them and the session
    // header showed disabled placeholder rows instead of the two subagents.
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const session = rootSession('resident-route-main', AUTOREPORT_MAIN_PRESET, root)
    const mainAgent = { id: session.id, session, options: {}, ctx: { get: () => undefined } } as unknown as Agent
    // The route lives on the session's own request header, not on the agent.
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' } },
      reason: 'initial',
    })
    const created: Array<{ agentOptions?: Record<string, unknown> }> = []
    let child: Session | undefined
    const createChild = async (options: { sessionId: SessionId, agentOptions?: Record<string, unknown> }): Promise<{ agent: Agent, dispose: () => Promise<void> }> => {
      created.push(options)
      child = Session.create(options.sessionId, undefined, {
        version: SESSION_FORMAT_VERSION,
        isSeeded: false,
        id: options.sessionId,
        createdAt: Date.now(),
        parentSession: session.id,
      })
      return { agent: { id: child.id, session: child } as Agent, dispose: async () => {} }
    }
    ctx.provide('agents', {
      list: () => [mainAgent],
      get: (id: SessionId) => id === mainAgent.id ? mainAgent : undefined,
      create: createChild,
      resume: createChild,
    } as never)
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    await runtime.ensureResidentRole(mainAgent, 'THEORY')

    expect(created[0]?.agentOptions).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    })
    expect(child?.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({
      mode: 'continuable',
      provider: 'spawn',
      label: 'AutoReport THEORY',
      agentProvider: 'deepseek-official',
      agentModel: 'deepseek-flash',
      toolFilter: { deny: ['send_to_agent', 'ask_user_question'] },
    })
  })

  it('gates a REPORT write until the running dsh observes the skill load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const guards: ((exec: unknown) => string | undefined)[] = []
    ctx.provide('tools', {
      guard: (guard: (exec: unknown) => string | undefined) => {
        guards.push(guard)
        return () => {}
      },
    } as never)
    const { apply: applyHost } = await import('../src/host.js')
    await applyHost(ctx, { ...CONFIG, workspaceRoot: root }, {
      pythonDetect: ISOLATED_PYTHON_DETECT,
    })

    const runtime = (ctx as unknown as { autoreportWorkflow: AutoReportWorkflowRuntime }).autoreportWorkflow
    runtime.roleRegistry.registerReserved({
      version: AUTOREPORT_SCHEMA_VERSION,
      role: 'REPORT',
      childSessionId: SessionId('gate-report'),
      parentSessionId: SessionId('gate-main'),
      workflowId: 'wf-gate',
      provisioning: 'reserved',
    })
    const child = rootSession('gate-report', undefined, root)

    const decision = (name: string, args: unknown): string | undefined =>
      guards.map(guard => guard({ name, arguments: args, agent: { session: child } })).find(reason => reason !== undefined)

    const write = { file_path: join(root, 'Report', 'main.tex'), content: 'x' }
    expect(decision('write', write)).toMatch(/experiment-report-writer/)
    // A shell command that only mentions a compiler is not a compilation.
    expect(decision('bash', { command: 'rg latexmk Report/build.log' })).toBeUndefined()
    expect(decision('bash', { command: 'latexmk -xelatex main.tex' })).toMatch(/latex-compile/)

    // The model loads one writing skill through dsh's own `skill` tool. The
    // gate reads the durable stream, so the load must be observed there.
    ctx.emit('session/event', child, {
      type: 'tool/call', seq: 1, time: 1,
      data: { turn: 1, step: 1, callId: 'c1', name: 'skill', arguments: JSON.stringify({ name: 'experiment-report-writer' }) },
    } as never)
    const marker = '<skill_content name="experiment-report-writer">\n<skill_instructions>\nbody\n</skill_instructions>\n</skill_content>'
    ctx.emit('session/event', child, {
      type: 'tool/result', seq: 2, time: 2,
      data: {
        turn: 1, step: 1,
        message: {
          role: 'user',
          id: 'm1',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: marker }] }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
    } as never)

    // The writing gate is satisfied; the language rules arrived with the prompt,
    // so there is no second skill for the model to load.
    expect(decision('write', write)).toBeUndefined()
  })

  it('does not create resident children just because MAIN received its first message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const session = rootSession('lazy-residents', AUTOREPORT_MAIN_PRESET, root)
    const mainAgent = { id: session.id, session } as Agent
    const created: unknown[] = []
    const createChild = async (options: { sessionId: SessionId }): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
      created.push(options)
      const child = Session.create(options.sessionId, undefined, {
        version: SESSION_FORMAT_VERSION,
        isSeeded: false,
        id: options.sessionId,
        createdAt: Date.now(),
        parentSession: session.id,
      })
      return { agent: { id: child.id, session: child } as Agent, dispose: async () => {} }
    }
    ctx.provide('agents', {
      list: () => [mainAgent],
      get: (id: SessionId) => id === mainAgent.id ? mainAgent : undefined,
      create: createChild,
      resume: createChild,
    } as never)
    createRuntime(ctx, { ...CONFIG, workspaceRoot: root })

    const message = createUserMessage({
      content: [{ type: 'text', text: 'start the report' }],
      source: { kind: 'user' },
    })
    ctx.emit('session/event', session, session.append('user/message', message, { surfaceOp: 'append' }))
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })

    expect(created).toHaveLength(0)
    expect(session.snapshotEvents().some(event => event.type === 'autoreport/role-binding')).toBe(false)
  })

  it('initializes on the first turn boundary after a preset selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = rootSession('selected-main', undefined, root)

    const selected = session.append('agent-preset/selected', { agentPreset: AUTOREPORT_MAIN_PRESET })
    ctx.emit('session/event', session, selected)
    const firstTurn = session.append('turn/start', { turn: 1 })
    ctx.emit('session/event', session, firstTurn)

    for (const dir of REQUIRED_DIRS) expect(existsSync(join(root, dir))).toBe(true)
    expect(runtime.forSession(session).state.projection().meta?.initialized).toBe(true)
  })

  it('replays a durable child report that landed before the observer committed', () => {
    const ctx = new Context()
    const runtime = createRuntime(ctx, CONFIG)
    const root = mkdtempSync(join(tmpdir(), 'autoreport-recover-'))
    tempDirs.push(root)
    const session = rootSession('main-recover', AUTOREPORT_MAIN_PRESET, root)
    appendWorkflowEvent(session, 'autoreport/task', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-7',
      subject: 'Analyze',
      role: 'DATA_ANALYSIS',
      dependencies: [],
      status: 'running',
      revision: 1,
      steps: [],
      scopes: ['Data/Processed'],
      latestDelegationRevision: 1,
    })
    appendWorkflowEvent(session, 'autoreport/delegation', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-7',
      delegationRevision: 1,
      role: 'DATA_ANALYSIS',
      childSessionId: SessionId('child-da'),
      acceptedMessageId: 'msg-out',
      phase: 'waiting_for_child',
      dispatchedAt: 10,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({
        task_id: 'task-7',
        delegation_revision: 1,
        status: 'success',
        block_type: null,
        response: 'processed.csv written',
        produced_files: ['Data/Processed/out.csv'],
      }) }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-da') },
    }), { surfaceOp: 'append' })
    const live = runtime.forSession(session)
    expect(live.state.currentDelegation('task-7')?.phase).toBe('completed')
    expect(live.state.currentDelegation('task-7')?.report?.response).toBe('processed.csv written')
    expect(live.state.getTask('task-7')?.status).toBe('completed')
  })
})

describe('per-workspace language switching', () => {
  /** The runtime installs its settings section from an inject callback, as a live host does. */
  async function waitForSettingsSection(ctx: Context): Promise<void> {
    await vi.waitFor(() => {
      expect(ctx.settings.describe().some(entry => entry.ns === 'autoreport')).toBe(true)
    })
  }

  it('resolves the language from the user workspace map and adopts a legacy project setting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    tempDirs.push(root, home)
    saveProjectSettings(home, workspaceIdForRoot(root), { reportLanguage: 'typst' })
    const ctx = new Context()
    await ctx.plugin(MemorySettings, { doc: { autoreport: {} } })
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
    await waitForSettingsSection(ctx)
    const session = rootSession('main-adopt', AUTOREPORT_MAIN_PRESET)
    runtime.maybeInitialize(session)
    expect(runtime.forSession(session).state.projection().meta?.settings?.reportLanguage).toBe('typst')
    // Adopting the legacy value is not a move: no template is deleted or added.
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
    // The first initialization adopts the legacy value into the authoritative map.
    await vi.waitFor(() => {
      expect(ctx.settings.describe().find(entry => entry.ns === 'autoreport')?.user)
        .toMatchObject({ workspaceLanguages: { [root]: 'typst' } })
    })
  })

  it('switches the workspace templates when the map changes under a live runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    tempDirs.push(root, home)
    const ctx = new Context()
    await ctx.plugin(MemorySettings, { doc: { autoreport: {} } })
    const runtime = createRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
    await waitForSettingsSection(ctx)
    const session = rootSession('main-switch', AUTOREPORT_MAIN_PRESET)
    runtime.maybeInitialize(session)
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)

    await ctx.settings.mutate(AUTOREPORT_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['workspaceLanguages', root], value: 'typst' },
    ])
    await vi.waitFor(() => {
      expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    })
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
  })
})
