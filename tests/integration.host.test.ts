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
 * settings, and agent-facing manifest projection.
 * @module tests/integration.host
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { REQUIRED_DIRS } from '../src/workspace/init.js'
import { resolveWorkflowSettings, workspaceIdForRoot } from '../src/settings.js'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import {
  ASSEMBLED_CONFIG as CONFIG,
  admitFirstTurn,
  assemble,
  type Assembled,
  disposeAssembled,
  execute,
  makeChildRecorder,
  publish,
  userTurn,
  waitUntil,
} from './helpers/assembled-host.js'

const live: Assembled[] = []
const tempDirs: string[] = []
afterEach(async () => {
  for (const assembled of live.splice(0)) await disposeAssembled(assembled)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function boot(options: Parameters<typeof assemble>[0] = {}): Promise<Assembled> {
  const assembled = await assemble(options)
  live.push(assembled)
  return assembled
}

describe('integration: assembled host (real context)', () => {
  it('registers exactly ONE continuable setup and routes it by RoleRegistry', async () => {
    const assembled = await boot()
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
    expect(theory.toolNames).toEqual(['manifest', 'report_workflow'])
    expect(theory.skillNames).toEqual([])
    expect(theory.toolNames).not.toContain('report')
    expect(theory.sections.some(section => section.text.includes('THEORY'))).toBe(true)

    const reportBinding: RoleBindingSnapshot = { ...binding, role: 'REPORT', childSessionId: SessionId('it-report') }
    assembled.runtime.roleRegistry.registerReserved(reportBinding)
    const reporter = makeChildRecorder('it-report')
    setup(reporter.ctx)
    expect(reporter.toolNames).toEqual(['manifest', 'report_workflow'])
    expect(reporter.skillNames).toEqual(['experiment-report-writer', 'latex-compile'])
    expect(reporter.sections.map(section => section.name)).not.toEqual(expect.arrayContaining([
      'autoreport:skill:experiment-report-writer',
      'autoreport:skill:latex-compile',
    ]))
    const plotter = makeChildRecorder('it-plotting-bound')
    assembled.runtime.roleRegistry.registerReserved({
      ...binding, role: 'PLOTTING', childSessionId: SessionId('it-plotting-bound'),
    })
    setup(plotter.ctx)
    expect(plotter.toolNames).toEqual(['manifest', 'report_workflow'])
    expect(plotter.skillNames).toEqual([])
  })

  it('initializes the workspace once with the frozen settings snapshot on the workflow event', async () => {
    const assembled = await boot({ projectLanguage: 'typst' })
    expect(assembled.presetSkillNames).toEqual(['pdf-reference-reader'])
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

  it('runs the whole delegation round trip: reserve -> authorized first call -> denial -> report -> artifacts -> manifest', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)

    // Auto-create and dispatch with wait:true: resolves ONLY when the child reports.
    const dispatchPromise = execute(assembled.ctx, 'send_to_agent', {
      role: 'DATA_ANALYSIS',
      subject: 'Analyze the raw dataset',
      prompt: 'fit the raw data',
      wait: true,
      timeout_ms: 15_000,
    }, assembled.mainAgent, assembled.mainSession)
    await waitUntil(() => assembled.startedSpecs.length > 0)
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

    const manifestResult = await execute(assembled.ctx, 'manifest', { action: 'read' }, childAgent, childSession)
    expect(manifestResult.isError, manifestResult.text).toBe(false)
    expect(manifestResult.value).toMatchObject({
      agent_type: 'data_analysis',
      files: [{
        path: 'Data/Processed/out.csv',
        description: '',
        description_updated_at: null,
      }],
      notes: '',
      notes_updated_at: null,
    })
    expect((manifestResult.value as { files: { file_updated_at: string }[] }).files[0]?.file_updated_at)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/u)
    expect(existsSync(join(assembled.home, 'autoreport', workspaceIdForRoot(assembled.workspaceRoot), 'manifests'))).toBe(false)

    await assembled.ctx.fiber?.dispose()
  })

  it('/report-init is membership-gated, then switches languages without deleting either backend', async () => {
    const assembled = await boot()
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
    expect(rejected.text).toContain("only in an 'autoreport' session")
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

  it('releases Main guard restrictions when an admitted root switches away from autoreport', async () => {
    const assembled = await boot()
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
    const assembled = await boot()
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

    // Coexistence both ways: the autoreport session still initializes on
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
