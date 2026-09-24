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
 * facts, `/init` language selection from DSH settings, and agent-facing
 * manifest projection.
 * @module tests/integration.host
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { roleWritableRoot } from '../src/policy/sandbox-roots.js'
import { REQUIRED_DIRS } from '../src/workspace/init.js'
import { resolveWorkflowSettings, workspaceIdForRoot } from '../src/settings.js'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import { ARTIFACT_SCHEMA_VERSION } from '../src/artifacts/refresh.js'
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
    const assembled = await boot({ roleSandbox: true })
    const roleTools = ['bash', 'read', 'read_image', 'write', 'edit', 'str_replace_editor', 'manifest', 'report_workflow']

    // Ordinary DSH child: the router installs nothing — stock messaging comes
    // from the base bundle since the standalone report tool was removed upstream.
    const ordinary = makeChildRecorder('it-ordinary', assembled.runtime)
    assembled.routeChild(ordinary)
    expect(ordinary.toolNames).toEqual([])

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
    const theory = makeChildRecorder('it-theory', assembled.runtime, assembled.workspaceRoot)
    assembled.routeChild(theory)
    expect(theory.toolNames).toEqual(roleTools)
    expect(theory.bashDescriptions[0]).toContain('AutoReport THEORY')
    expect(theory.bashLookupScopes).toEqual([theory.agent])
    expect(theory.toolDescriptions.get('read')).toContain(`Relative paths resolve from ${assembled.workspaceRoot}.`)
    expect(theory.toolDescriptions.get('write')).toContain(
      `Relative paths resolve from ${roleWritableRoot(assembled.workspaceRoot, 'THEORY')}.`,
    )
    expect(theory.toolDescriptions.get('str_replace_editor')).toContain(
      `the absolute workspace root for this agent is ${assembled.workspaceRoot}`,
    )
    expect(theory.toolLookupScopes.get('read')).toEqual([theory.agent])
    expect(theory.toolLookupScopes.get('write')).toEqual([theory.agent])
    expect(theory.skillNames).toEqual([])
    expect(theory.toolNames).not.toContain('report')
    expect(theory.sections.some(section => section.name === 'tool:report-workflow')).toBe(false)
    // The report protocol is a runtime context on every routed child, so the
    // prompt stays uniform across parents and children.
    expect(theory.contexts.some(context => context.name === 'autoreport:report-protocol')).toBe(true)

    const reportBinding: RoleBindingSnapshot = { ...binding, role: 'REPORT', childSessionId: SessionId('it-report') }
    assembled.runtime.roleRegistry.registerReserved(reportBinding)
    const reporter = makeChildRecorder('it-report', assembled.runtime, assembled.workspaceRoot)
    assembled.routeChild(reporter)
    expect(reporter.toolNames).toEqual(roleTools)
    expect(reporter.bashDescriptions[0]).toContain('AutoReport REPORT')
    expect(reporter.skillNames).toEqual([
      'experiment-report-writer', 'latex-compile',
    ])
    expect(reporter.sections.map(section => section.name)).not.toEqual(expect.arrayContaining([
      'autoreport:skill:experiment-report-writer',
      'autoreport:skill:latex-compile',
    ]))
    const plotter = makeChildRecorder('it-plotting-bound', assembled.runtime, assembled.workspaceRoot)
    assembled.runtime.roleRegistry.registerReserved({
      ...binding, role: 'PLOTTING', childSessionId: SessionId('it-plotting-bound'),
    })
    assembled.routeChild(plotter)
    expect(plotter.toolNames).toEqual(roleTools)
    expect(plotter.bashDescriptions[0]).toContain('AutoReport PLOTTING')
    expect(plotter.skillNames).toEqual([])
  })

  it('initializes the workspace once with the frozen settings snapshot on the workflow event', async () => {
    const assembled = await boot({ workspaceLanguage: 'typst' })
    expect(assembled.presetSkillNames).toEqual(['pdf-reference-reader'])
    admitFirstTurn(assembled)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(assembled.workspaceRoot, dir))).toBe(true)
    const meta = assembled.runtime.forSession(assembled.mainSession).state.projection().meta
    expect(meta?.initialized).toBe(true)
    expect(meta?.settings?.reportLanguage).toBe('typst')
    expect(meta?.settings).toEqual(resolveWorkflowSettings({
      user: { workspaceLanguages: { [resolve(assembled.workspaceRoot)]: 'typst' } },
      workspaceRoot: assembled.workspaceRoot,
      composition: CONFIG,
    }))
  })

  it('maintains the durable task board through MAIN workflow_task', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)

    const dispatched = await execute(assembled.ctx, 'send_to_agent', {
      role: 'THEORY', prompt: 'derive the governing equation', wait: false,
      steps: [{ description: 'derive the equation' }],
    }, assembled.mainAgent, assembled.mainSession)
    expect(dispatched.isError, dispatched.text).toBe(false)

    const updated = await execute(assembled.ctx, 'workflow_task', {
      action: 'update', task_id: 'task-1',
      steps: [{ description: 'derive the equation', done: true }, { description: 'check units' }],
    }, assembled.mainAgent, assembled.mainSession)
    expect(updated.isError, updated.text).toBe(false)
    expect((updated.value as { task: { steps: unknown[] } }).task.steps).toHaveLength(2)

    const cancelled = await execute(assembled.ctx, 'workflow_task', {
      action: 'cancel', task_id: 'task-1',
    }, assembled.mainAgent, assembled.mainSession)
    expect(cancelled.isError, cancelled.text).toBe(false)
    expect(assembled.runtime.forSession(assembled.mainSession).state.getTask('task-1')?.status).toBe('cancelled')

    const reopened = await execute(assembled.ctx, 'workflow_task', {
      action: 'reopen', task_id: 'task-1',
    }, assembled.mainAgent, assembled.mainSession)
    expect(reopened.isError, reopened.text).toBe(false)
    expect(assembled.runtime.forSession(assembled.mainSession).state.getTask('task-1')?.status).toBe('pending')
  })

  it('runs explicit /init and /reset targets without initializing the caller workspace', async () => {
    const callerRoot = makeTemp('autoreport-command-caller-')
    const targetRoot = makeTemp('autoreport-command-target-')
    const assembled = await boot({ workspaceRoot: callerRoot })
    const invocation = (rawInput: string) => ({ agent: assembled.mainAgent, rawInput })

    expect(assembled.reportInitCommand).toBeDefined()
    const initialized = await assembled.reportInitCommand!.handler(invocation(targetRoot))
    expect(initialized.kind).toBe('success')
    for (const dir of REQUIRED_DIRS) {
      expect(existsSync(join(targetRoot, dir))).toBe(true)
      expect(existsSync(join(callerRoot, dir))).toBe(false)
    }
    expect(assembled.runtime.forSession(assembled.mainSession).state.projection().meta).toBeUndefined()

    mkdirSync(join(targetRoot, 'Data', 'Raw'), { recursive: true })
    writeFileSync(join(targetRoot, 'Data', 'Raw', 'measurements.csv'), 'x,y\n1,2\n')
    writeFileSync(join(targetRoot, 'References', 'procedure.md'), 'keep this input')
    writeFileSync(join(targetRoot, 'Outline', 'generated.md'), 'clear this output')
    expect(assembled.reportResetCommand).toBeDefined()
    const reset = await assembled.reportResetCommand!.handler(invocation(targetRoot))
    expect(reset.kind).toBe('success')
    expect(existsSync(join(targetRoot, 'Data', 'Raw', 'measurements.csv'))).toBe(true)
    expect(existsSync(join(targetRoot, 'References', 'procedure.md'))).toBe(true)
    expect(existsSync(join(targetRoot, 'Outline', 'generated.md'))).toBe(false)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(callerRoot, dir))).toBe(false)
    expect(assembled.runtime.forSession(assembled.mainSession).state.projection().meta).toBeUndefined()
  })

  it('runs the whole delegation round trip: reserve -> authorized first call -> denial -> report -> artifacts -> manifest', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)
    // Fixture process tool with a REAL executor: the observer's process path
    // (before/after writable-root snapshots) keys on the tool NAME 'bash', so
    // the child-bash regression below needs an actual command to run.
    assembled.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'fixture process execution',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute(args) {
        const { execFileSync } = await import('node:child_process')
        // Bare `bash` on every platform: the Windows runners carry Git for
        // Windows on PATH (the repo's own confinement probes rely on it), and
        // an absolute /bin/bash would not resolve there.
        execFileSync('bash', ['-c', String(args.command)], { stdio: 'ignore' })
        return { command: args.command }
      },
    }))

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
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
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

    // Regression guard for the silent 2026-09-23 field failure: a CHILD's
    // process-tool write window must also produce an artifact. The DA session
    // in that run ran 58 potentially-writing bash commands and the fold
    // produced nothing, leaving the manifest tracker empty for the whole run.
    const scriptPath = join(assembled.workspaceRoot, 'Data', 'Processed', 'from_bash.csv')
    // Absolute path with forward slashes: execFileSync inherits the TEST
    // process's cwd (the repo root, not the experiment workspace), so a
    // relative target would miss; forward slashes keep the drive-letter path
    // portable under Git Bash on Windows without any backslash escaping.
    const writeCommand = `printf 'bash wrote this' > "${scriptPath.replaceAll('\\', '/')}"`
    const bash = await execute(assembled.ctx, 'bash', {
      command: writeCommand,
    }, childAgent, childSession)
    expect(bash.isError, bash.text).toBe(false)
    expect(existsSync(scriptPath)).toBe(true)
    const afterBash = assembled.runtime.forSession(assembled.mainSession).state.projection().artifacts
    const bashArtifact = afterBash.find(a => a.path === 'Data/Processed/from_bash.csv')
    expect(bashArtifact, 'child bash write must be observed as an artifact').toBeDefined()
    expect(bashArtifact).toMatchObject({
      producedBy: 'DATA_ANALYSIS',
      origin: 'process',
      status: 'created',
      taskId: 'task-1',
      delegationKey: 'task-1#1',
    })

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
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]).toMatchObject({
      version: ARTIFACT_SCHEMA_VERSION,
      path: 'Data/Processed/out.csv',
      producedBy: 'DATA_ANALYSIS',
      origin: 'fs-tool',
      status: 'created',
      taskId: 'task-1',
      delegationKey: 'task-1#1',
    })
    // Baseline stamped: the manifest refresh compares size+mtime against this.
    expect(artifacts[0]?.sizeBytes).toBe('fit results'.length)

    const manifestResult = await execute(assembled.ctx, 'manifest', { action: 'read' }, childAgent, childSession)
    expect(manifestResult.isError, manifestResult.text).toBe(false)
    const manifestFiles = (manifestResult.value as { files: { path: string; description: string; description_updated_at: string | null; file_updated_at: string }[] }).files
    expect(manifestFiles).toHaveLength(2)
    expect(manifestFiles.find(f => f.path === 'Data/Processed/out.csv')).toMatchObject({
      description: '',
      description_updated_at: null,
    })
    expect(manifestFiles.find(f => f.path === 'Data/Processed/from_bash.csv')?.file_updated_at)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/u)
    expect((manifestResult.value as { files: { file_updated_at: string }[] }).files[0]?.file_updated_at)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/u)
    expect(existsSync(join(assembled.home, 'autoreport', workspaceIdForRoot(assembled.workspaceRoot), 'manifests'))).toBe(false)

    await assembled.ctx.fiber?.dispose()
  })

  it('/init is membership-gated, then switches languages without deleting either backend', async () => {
    const assembled = await boot()
    const command = assembled.reportInitCommand
    if (command === undefined) throw new Error('/init was not registered by the host plugin')

    // The command service is host-global, so a stock caller must be rejected
    // BEFORE settings persistence or workspace materialization.
    const stockCwd = makeTemp('autoreport-it-init-stock-')
    const stockSession = Session.create(SessionId('it-init-stock'), undefined, {
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
      id: SessionId('it-init-stock'),
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

    admitFirstTurn(assembled)
    const invoke = (rawInput: string) => command.handler({
      rawInput,
      agent: { session: assembled.mainSession },
    }) as Promise<{ kind: string; text?: string }>

    // Snapshot before: the in-flight workflow keeps its creation-time settings.
    const before = assembled.runtime.forSession(assembled.mainSession).state.projection().meta?.settings

    const typst = await invoke('--language typst')
    expect(typst.kind).toBe('success')
    expect(typst.text).toContain('report language: typst (saved to settings)')
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'main.typ'))).toBe(true)
    // The recorded move reaches the workspace through the host, so the
    // unmodified LaTeX template set is gone rather than coexisting.
    await waitUntil(() => !existsSync(join(assembled.workspaceRoot, 'Report', 'main.tex')))
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'mpltx.cls'))).toBe(false)

    const latex = await invoke('--language latex')
    expect(latex.kind).toBe('success')
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'main.tex'))).toBe(true)
    await waitUntil(() => !existsSync(join(assembled.workspaceRoot, 'Report', 'main.typ')))

    // A template the user edited is the user's: the switch keeps it.
    writeFileSync(join(assembled.workspaceRoot, 'Report', 'main.tex'), '% mine\n')
    const backToTypst = await invoke('--language typst')
    expect(backToTypst.kind).toBe('success')
    await waitUntil(() => existsSync(join(assembled.workspaceRoot, 'Report', 'main.typ')))
    expect(readFileSync(join(assembled.workspaceRoot, 'Report', 'main.tex'), 'utf8')).toBe('% mine\n')

    // The durable snapshot NEVER adopts a later change (PLAN §2.14).
    const after = assembled.runtime.forSession(assembled.mainSession).state.projection().meta?.settings
    expect(after).toEqual(before)
  })

  it('/reset clears the generated work through the host, inputs and gating intact', async () => {
    const assembled = await boot()
    const command = assembled.reportResetCommand
    if (command === undefined) throw new Error('/reset was not registered by the host plugin')
    const root = assembled.workspaceRoot

    // A stock session may not reset anything, exactly like /init.
    const stockCwd = mkdtempSync(join(tmpdir(), 'autoreport-reset-stock-'))
    const stockSession = Session.create(SessionId('it-reset-stock'), undefined, {
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
      id: SessionId('it-reset-stock'),
      createdAt: Date.now(),
      cwd: stockCwd,
    })
    const rejected = await command.handler({ rawInput: '', agent: { session: stockSession } })
    expect(rejected.kind).toBe('error')
    expect(rejected.text).toContain("only in an 'autoreport' session")
    expect(existsSync(join(stockCwd, 'Outline'))).toBe(false)

    admitFirstTurn(assembled)
    // Generated work from every reset target, plus the two input trees.
    mkdirSync(join(root, 'Outline', '.cache'), { recursive: true })
    writeFileSync(join(root, 'Outline', 'report_outline.md'), 'outline')
    writeFileSync(join(root, 'Theory', 'theory.md'), 'theory')
    writeFileSync(join(root, 'Data', 'raw.txt'), 'raw')
    mkdirSync(join(root, 'Data', 'Processed'), { recursive: true })
    writeFileSync(join(root, 'Data', 'Processed', 'clean.csv'), 'processed')
    mkdirSync(join(root, 'References'), { recursive: true })
    writeFileSync(join(root, 'References', 'handout.pdf'), 'paper')
    assembled.runtime.commit(assembled.mainSession, 'autoreport/task', {
      version: AUTOREPORT_SCHEMA_VERSION,
      taskId: 'task-1',
      subject: 'analysis',
      role: 'DATA_ANALYSIS',
      dependencies: [],
      status: 'pending',
      revision: 1,
      steps: [],
      scopes: ['Data/Processed'],
    })
    expect(assembled.runtime.forSession(assembled.mainSession).state.projection().tasks.size).toBe(1)

    const result = await command.handler({ rawInput: '', agent: { session: assembled.mainSession } })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('cleared: Outline, Theory')
    expect(result.text).toContain('task board: this session workflow cleared')

    expect(existsSync(join(root, 'Outline', 'report_outline.md'))).toBe(false)
    expect(existsSync(join(root, 'Outline', '.cache'))).toBe(false)
    expect(existsSync(join(root, 'Theory', 'theory.md'))).toBe(false)
    expect(existsSync(join(root, 'Data', 'Processed', 'clean.csv'))).toBe(false)
    // Inputs and the re-materialized skeleton survive.
    expect(readFileSync(join(root, 'Data', 'raw.txt'), 'utf8')).toBe('raw')
    expect(readFileSync(join(root, 'References', 'handout.pdf'), 'utf8')).toBe('paper')
    expect(existsSync(join(root, 'Report', 'main.tex'))).toBe(true)
    expect(existsSync(join(root, 'Outline'))).toBe(true)
    // The host re-admitted a FRESH workflow: metadata is back, the board is not.
    const after = assembled.runtime.forSession(assembled.mainSession).state.projection()
    expect(after.meta?.workspaceRoot).toBe(root)
    expect(after.tasks.size).toBe(0)

    await assembled.ctx.fiber?.dispose()
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
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
      id: SessionId('it-stock'),
      createdAt: Date.now(),
      cwd: stockCwd,
    })
    const stockAgent = { id: stockSession.id, session: stockSession } as Agent

    // Ordinary first user turn.
    userTurn(ctx, stockSession, 'just answer my question')

    expect(assembled.runtime.isMainSession(stockSession.id)).toBe(false)
    expect(assembled.runtime.ownsSession(stockSession)).toBe(false)
    expect(stockSession.snapshotEvents().some(event => event.type.startsWith('autoreport/'))).toBe(false)
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
