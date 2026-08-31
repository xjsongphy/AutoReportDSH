/**
 * Assembled workflow evals: the eight traces that close AutoReportDSH's
 * static-architecture phase. No live provider; the real host runtime is
 * driven through send_to_agent, report_workflow, turn-stopping, and
 * artifact observation.
 * @module tests/eval/workflow-eval
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  effectiveSandboxMode,
  effectiveSandboxWorkspaceRoot,
} from '@deepseek-ai/dsh-sandbox-policy/src/session-mode.ts'
import { REQUIRED_DIRS } from '../../src/workspace/init.js'
import { saveProjectSettings, workspaceIdForRoot } from '../../src/settings.js'
import { resetAcknowledgedBlockedKeys } from '../../src/workflow/turn-guard.js'
import {
  MAIN_STEER_SUMMARY,
  MANIFEST_STEER_SUMMARY,
  REPORT_STEER_SUMMARY,
} from '../../src/workflow/display.js'
import type { SpecialistRole } from '../../src/roles.js'
import {
  admitFirstTurn,
  assemble,
  type Assembled,
  dispatch,
  disposeAssembled,
  execute,
  eventTypes,
  describeFiles,
  messageSource,
  messageText,
  publish,
  reportWorkflow,
  specialistSkills,
  specialistWrite,
  stopTurn,
  turnGuardSteers,
  userTurn,
} from '../helpers/assembled-host.js'

const live: Assembled[] = []
afterEach(async () => {
  for (const assembled of live.splice(0)) await disposeAssembled(assembled)
})
beforeEach(() => {
  resetAcknowledgedBlockedKeys()
})

async function boot(options: Parameters<typeof assemble>[0] = {}): Promise<Assembled> {
  const assembled = await assemble(options)
  live.push(assembled)
  return assembled
}

function tasks(assembled: Assembled) {
  return assembled.runtime.forSession(assembled.mainSession).state
}

function hostPython(): string | undefined {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    const path = probe.stdout?.trim()
    if (probe.status === 0 && path !== undefined && path.length > 0) return path
  }
  return undefined
}

async function finishRole(
  assembled: Assembled,
  role: SpecialistRole,
  produced: readonly { path: string; content: string }[],
): Promise<{ taskId: string; childId: string }> {
  const child = await dispatch(assembled, { role, prompt: `complete ${role}` })
  for (const file of produced) {
    await specialistWrite(assembled, child, file.path, file.content)
  }
  const taskId = String(child.value.task_id)
  const described = await describeFiles(assembled, child, produced.map(file => ({
    path: file.path,
    description: `${role} output ${file.path}`,
  })))
  expect(described.isError).toBe(false)
  const reported = await reportWorkflow(assembled, child, {
    task_id: taskId,
    delegation_revision: Number(child.value.delegation_revision),
    status: 'success',
    response: `${role} complete`,
    produced_files: produced.map(file => file.path),
  })
  expect(reported.isError).toBe(false)
  expect(tasks(assembled).getTask(taskId)?.status).toBe('completed')
  return { taskId, childId: child.childId }
}

describe('workflow eval', () => {
  it('1. completes a LaTeX report pipeline: MAIN → theory/data/plot/report → compile', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)
    expect(tasks(assembled).projection().meta?.settings?.reportLanguage).toBe('latex')

    await finishRole(assembled, 'THEORY', [
      { path: 'Theory/theory.md', content: '# theory\n' },
    ])
    await finishRole(assembled, 'DATA_ANALYSIS', [
      { path: 'Data/Processed/out.csv', content: 'x,y\n1,2\n' },
    ])
    await finishRole(assembled, 'PLOTTING', [
      { path: 'Plots/Fig/fig1.png', content: 'png' },
    ])
    const report = await dispatch(assembled, { role: 'REPORT', prompt: 'write and compile latex' })
    expect(specialistSkills(assembled, report.childId).skillNames).toEqual([
      'experiment-report-writer',
      'latex-compile',
    ])
    await specialistWrite(assembled, report, 'Report/main.tex', '\\documentclass{article}\\begin{document}ok\\end{document}\n')
    await specialistWrite(assembled, report, 'Report/main.pdf', '%PDF-eval\n')
    expect((await describeFiles(assembled, report, [
      { path: 'Report/main.tex', description: 'LaTeX source' },
      { path: 'Report/main.pdf', description: 'compiled PDF' },
    ])).isError).toBe(false)
    const reported = await reportWorkflow(assembled, report, {
      task_id: String(report.value.task_id),
      delegation_revision: Number(report.value.delegation_revision),
      status: 'success',
      response: 'compiled latex',
      produced_files: ['Report/main.tex', 'Report/main.pdf'],
    })
    expect(reported.isError).toBe(false)
    const fold = tasks(assembled).projection()
    expect([...fold.tasks.values()].map(task => task.status)).toEqual([
      'completed', 'completed', 'completed', 'completed',
    ])
    expect(fold.artifacts.some(item => item.path === 'Report/main.pdf' && item.status === 'created')).toBe(true)
    expect(existsSync(join(assembled.workspaceRoot, 'Report', 'main.pdf'))).toBe(true)
    const logged = eventTypes(assembled.mainSession)
    expect(logged).toEqual(expect.arrayContaining([
      'autoreport/workflow',
      'autoreport/task',
      'autoreport/delegation',
      'autoreport/artifact',
      'autoreport/file-note',
    ]))
    expect(assembled.mainSession.events.some(event => (
      event.type === 'user/message'
      && event.data.source.kind === 'subagent-report'
    ))).toBe(true)
  })

  it('2. completes a Typst report pipeline with language snapshot and REPORT compile skills', async () => {
    const assembled = await boot({ projectLanguage: 'typst' })
    admitFirstTurn(assembled)
    expect(tasks(assembled).projection().meta?.language).toBe('typst')
    expect(tasks(assembled).projection().meta?.settings?.reportLanguage).toBe('typst')

    await finishRole(assembled, 'THEORY', [{ path: 'Theory/theory.md', content: '# theory\n' }])
    const report = await dispatch(assembled, { role: 'REPORT', prompt: 'write and compile typst' })
    expect(specialistSkills(assembled, report.childId).skillNames).toEqual([
      'experiment-report-writer',
      'typst',
      'typst-compile',
    ])
    expect(specialistSkills(assembled, report.childId).skillNames).not.toContain('latex-compile')
    await specialistWrite(assembled, report, 'Report/main.typ', '#set page(paper: "a4")\nHello\n')
    await specialistWrite(assembled, report, 'Report/main.pdf', '%PDF-typst-eval\n')
    expect((await describeFiles(assembled, report, [
      { path: 'Report/main.typ', description: 'Typst source' },
      { path: 'Report/main.pdf', description: 'compiled PDF' },
    ])).isError).toBe(false)
    await reportWorkflow(assembled, report, {
      task_id: String(report.value.task_id),
      delegation_revision: Number(report.value.delegation_revision),
      status: 'success',
      response: 'compiled typst',
      produced_files: ['Report/main.typ', 'Report/main.pdf'],
    })
    expect(tasks(assembled).getTask(String(report.value.task_id))?.status).toBe('completed')
  })

  it('3. blocked missing_data/quality steers MAIN and redispatch recovers', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)
    const child = await dispatch(assembled, { role: 'DATA_ANALYSIS', prompt: 'fit the csv' })
    const taskId = String(child.value.task_id)
    const blocked = await reportWorkflow(assembled, child, {
      task_id: taskId,
      delegation_revision: Number(child.value.delegation_revision),
      status: 'blocked',
      block_type: 'missing_data',
      response: 'need Data/Raw/run.csv',
    })
    expect(blocked.isError).toBe(false)
    expect(tasks(assembled).getTask(taskId)?.status).toBe('blocked')
    expect(tasks(assembled).currentDelegation(taskId)?.phase).toBe('blocked')

    stopTurn(assembled, assembled.mainAgent, 1)
    const firstSteers = turnGuardSteers(assembled.mainSession)
    expect(firstSteers).toHaveLength(1)
    expect(messageText(firstSteers[0])).toMatch(/blocked/i)
    expect(messageSource(firstSteers[0])).toMatchObject({
      kind: 'plugin',
      plugin: 'autoreportdsh/turn-guard',
      form: 'notice',
      summary: MAIN_STEER_SUMMARY,
    })
    stopTurn(assembled, assembled.mainAgent, 1)
    expect(turnGuardSteers(assembled.mainSession)).toHaveLength(1)

    const retry = await dispatch(assembled, {
      role: 'DATA_ANALYSIS',
      task_id: taskId,
      prompt: 'csv is now in Data/Raw',
    })
    expect(retry.childId).toBe(child.childId)
    await specialistWrite(assembled, retry, 'Data/Processed/out.csv', 'ok\n')
    expect((await describeFiles(assembled, retry, [
      { path: 'Data/Processed/out.csv', description: 'fitted results' },
    ])).isError).toBe(false)
    await reportWorkflow(assembled, retry, {
      task_id: taskId,
      delegation_revision: Number(retry.value.delegation_revision),
      status: 'success',
      response: 'fitted',
      produced_files: ['Data/Processed/out.csv'],
    })
    expect(tasks(assembled).getTask(taskId)?.status).toBe('completed')

    const quality = await dispatch(assembled, { role: 'THEORY', prompt: 'derive' })
    const qualityId = String(quality.value.task_id)
    await reportWorkflow(assembled, quality, {
      task_id: qualityId,
      delegation_revision: Number(quality.value.delegation_revision),
      status: 'blocked',
      block_type: 'quality',
      response: 'method unspecified',
    })
    expect(tasks(assembled).getTask(qualityId)?.status).toBe('blocked')
    stopTurn(assembled, assembled.mainAgent, 2)
    expect(turnGuardSteers(assembled.mainSession)).toHaveLength(2)
    const repaired = await dispatch(assembled, {
      role: 'THEORY',
      task_id: qualityId,
      prompt: 'use linearised model',
    })
    await reportWorkflow(assembled, repaired, {
      task_id: qualityId,
      delegation_revision: Number(repaired.value.delegation_revision),
      status: 'success',
      response: 'derived',
    })
    expect(tasks(assembled).getTask(qualityId)?.status).toBe('completed')
  })

  it('4. forgotten report_workflow steers the subagent and does not fail the task', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)
    const child = await dispatch(assembled, { role: 'THEORY', prompt: 'derive' })
    const taskId = String(child.value.task_id)
    await specialistWrite(assembled, child, 'Theory/theory.md', '# leftover without report\n')

    stopTurn(assembled, child.childAgent, 1)
    const afterManifest = turnGuardSteers(child.childSession)
    expect(afterManifest).toHaveLength(1)
    expect(messageText(afterManifest[0])).toMatch(/describe_files/)
    expect(messageSource(afterManifest[0])).toMatchObject({
      kind: 'plugin',
      plugin: 'autoreportdsh/turn-guard',
      form: 'notice',
      summary: MANIFEST_STEER_SUMMARY,
    })
    stopTurn(assembled, child.childAgent, 1)
    const afterReport = turnGuardSteers(child.childSession)
    expect(afterReport).toHaveLength(2)
    expect(messageText(afterReport[1])).toMatch(/report_workflow/)
    expect(messageSource(afterReport[1])).toMatchObject({
      summary: REPORT_STEER_SUMMARY,
    })
    stopTurn(assembled, child.childAgent, 1)
    expect(turnGuardSteers(child.childSession)).toHaveLength(2)

    expect(tasks(assembled).getTask(taskId)?.status).toBe('running')
    expect(tasks(assembled).currentDelegation(taskId)?.phase).toBe('waiting_for_child')

    const rejected = await reportWorkflow(assembled, child, {
      task_id: taskId,
      delegation_revision: Number(child.value.delegation_revision),
      status: 'success',
      response: 'reported after steer',
      produced_files: ['Theory/theory.md'],
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toMatch(/semantic manifest is stale/)

    expect((await describeFiles(assembled, child, [
      { path: 'Theory/theory.md', description: 'leftover derivation' },
    ])).isError).toBe(false)
    await reportWorkflow(assembled, child, {
      task_id: taskId,
      delegation_revision: Number(child.value.delegation_revision),
      status: 'success',
      response: 'reported after steer',
      produced_files: ['Theory/theory.md'],
    })
    expect(tasks(assembled).getTask(taskId)?.status).toBe('completed')
    expect(tasks(assembled).getTask(taskId)?.status).not.toBe('failed')
  })

  it('5. cold resume plus permanent child resume failure rebinds and supersedes the role', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)
    await finishRole(assembled, 'THEORY', [{ path: 'Theory/theory.md', content: '# v1\n' }])
    const firstBinding = tasks(assembled).bindingForRole('THEORY')
    expect(firstBinding?.provisioning).toBe('active')

    const dirs = assembled.ownedDirs.splice(0)
    await assembled.ctx.fiber?.dispose()
    const resumed = await assemble({
      workspaceRoot: assembled.workspaceRoot,
      home: assembled.home,
      mainSession: assembled.mainSession,
      followup: async () => {
        throw Object.assign(new Error('child gone'), { code: 'NOT_RESUMABLE' })
      },
    })
    resumed.ownedDirs.push(...dirs)
    live.push(resumed)

    const rebound = await dispatch(resumed, { role: 'THEORY', prompt: 'continue derivation' })
    const next = tasks(resumed).bindingForRole('THEORY')
    expect(next?.childSessionId).toBe(rebound.childId)
    expect(next?.childSessionId).not.toBe(firstBinding?.childSessionId)
    expect(next?.supersedes).toBe(firstBinding?.childSessionId)
    expect(resumed.runtime.roleRegistry.lookup(firstBinding!.childSessionId)).toBeUndefined()
    expect(resumed.runtime.roleRegistry.lookup(rebound.childId)?.binding.provisioning).toBe('active')
    const rebindPrompt = resumed.startedSpecs.at(-1)?.prompt ?? ''
    expect(rebindPrompt).toContain('Role memory for THEORY')
    expect(rebindPrompt).toContain('Theory/theory.md')
  })

  it('6. edit and bash against existing files record modified artifacts', async () => {
    const assembled = await boot()
    admitFirstTurn(assembled)
    assembled.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'fixture shell',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute(args) {
        const command = String(args.command)
        const redirected = />>\s+(\S+)/u.exec(command)
        if (redirected?.[1] !== undefined) {
          appendFileSync(join(assembled.workspaceRoot, redirected[1]), 'appended\n')
        }
        return { ran: true }
      },
    }))

    const report = await dispatch(assembled, { role: 'REPORT', prompt: 'edit existing report' })
    const existing = join(assembled.workspaceRoot, 'Report', 'main.tex')
    expect(existsSync(existing)).toBe(true)
    const edited = await execute(assembled.ctx, 'edit', {
      file_path: existing,
      content: '\\documentclass{article}\n',
    }, report.childAgent, report.childSession)
    expect(edited.isError).toBe(false)

    const shelled = await execute(assembled.ctx, 'bash', {
      command: 'echo extra >> Report/main.tex',
    }, report.childAgent, report.childSession)
    expect(shelled.isError).toBe(false)

    const artifacts = tasks(assembled).projection().artifacts
    expect(artifacts.some(item => item.path === 'Report/main.tex' && item.origin === 'fs-tool' && item.status === 'modified')).toBe(true)
    expect(artifacts.some(item => item.path === 'Report/main.tex' && item.origin === 'process' && item.status === 'modified')).toBe(true)
  })

  it.skipIf(hostPython() === undefined)('7. selected Python interpreter stays the workflow snapshot after dispatch and resume', async () => {
    const python = hostPython()
    if (python === undefined) throw new Error('python is required when this case is not skipped')
    const assembled = await boot({ pythonExecutable: python })
    admitFirstTurn(assembled)
    expect(tasks(assembled).projection().meta?.settings?.pythonExecutable).toBe(python)
    const child = await dispatch(assembled, { role: 'DATA_ANALYSIS', prompt: 'fit in python' })
    expect(assembled.pythonResolve({ agent: child.childAgent })).toMatchObject({
      DSH_AUTOREPORT_PYTHON: python,
    })

    const other = mkdtempSync(join(tmpdir(), 'autoreport-py-other-'))
    assembled.ownedDirs.push(other)
    mkdirSync(join(other, 'bin'), { recursive: true })
    const decoy = join(other, 'bin', 'python')
    writeFileSync(decoy, '#!/bin/sh\necho Python 3.99.0-decoy\n')
    chmodSync(decoy, 0o755)
    saveProjectSettings(assembled.home, workspaceIdForRoot(assembled.workspaceRoot), {
      pythonExecutable: decoy,
    })

    const dirs = assembled.ownedDirs.splice(0)
    await assembled.ctx.fiber?.dispose()
    const resumed = await assemble({
      workspaceRoot: assembled.workspaceRoot,
      home: assembled.home,
      mainSession: assembled.mainSession,
    })
    resumed.ownedDirs.push(...dirs)
    live.push(resumed)
    admitFirstTurn(resumed)
    expect(tasks(resumed).projection().meta?.settings?.pythonExecutable).toBe(python)
    const resumedChild = {
      agent: {
        session: Session.create(SessionId(child.childId), undefined, {
          version: 0,
          id: SessionId(child.childId),
          createdAt: Date.now(),
          cwd: resumed.workspaceRoot,
          parentSession: resumed.mainSession.id,
        }),
      },
    }
    expect(resumed.pythonResolve(resumedChild)).toMatchObject({
      DSH_AUTOREPORT_PYTHON: python,
    })
    expect(resumed.pythonResolve({
      agent: { session: Session.create(SessionId('stock-py'), undefined, {
        version: 0,
        id: SessionId('stock-py'),
        createdAt: Date.now(),
        cwd: resumed.workspaceRoot,
      }) },
    })).toEqual({})
  })

  it('8. standard session and preset switch stay unpolluted in the same process', async () => {
    const assembled = await boot()
    assembled.ctx.tools.register(defineTool({
      name: 'bash',
      description: 'fixture unrestricted executor',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'ran' }],
      },
      async execute() { return { ran: true } },
    }))

    const stockCwd = mkdtempSync(join(tmpdir(), 'autoreport-eval-stock-'))
    assembled.ownedDirs.push(stockCwd)
    const stockSession = Session.create(SessionId('eval-stock'), undefined, {
      version: 0,
      id: SessionId('eval-stock'),
      createdAt: Date.now(),
      cwd: stockCwd,
    })
    const stockAgent = { id: stockSession.id, session: stockSession } as Agent
    userTurn(assembled.ctx, stockSession, 'just answer')
    expect(assembled.runtime.ownsSession(stockSession)).toBe(false)
    expect(stockSession.events.some(event => event.type.startsWith('autoreport/'))).toBe(false)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(stockCwd, dir))).toBe(false)
    expect(assembled.pythonResolve({ agent: stockAgent })).toEqual({})
    expect(effectiveSandboxWorkspaceRoot(stockSession.events)).toBeUndefined()

    const stockWrite = await execute(assembled.ctx, 'write', {
      file_path: join(stockCwd, 'notes.txt'),
      content: 'stock',
    }, stockAgent, stockSession)
    expect(stockWrite.isError).toBe(false)
    const stockBash = await execute(assembled.ctx, 'bash', { command: 'true' }, stockAgent, stockSession)
    expect(stockBash.isError).toBe(false)

    admitFirstTurn(assembled)
    await finishRole(assembled, 'THEORY', [{ path: 'Theory/theory.md', content: '# t\n' }])
    expect(assembled.runtime.ownsSession(stockSession)).toBe(false)
    expect(stockSession.events.some(event => event.type.startsWith('autoreport/'))).toBe(false)
    expect(existsSync(join(stockCwd, 'Theory'))).toBe(false)
    expect(effectiveSandboxMode(assembled.mainSession.events)).toBe('workspace-write')
    expect(effectiveSandboxWorkspaceRoot(assembled.mainSession.events)).toContain('Outline')

    publish(assembled.ctx, assembled.mainSession, 'agent-preset/selected', { agentPreset: 'standard' })
    expect(assembled.runtime.ownsSession(assembled.mainSession)).toBe(false)
    const released = await execute(assembled.ctx, 'write', {
      file_path: join(assembled.workspaceRoot, 'Report', 'main.tex'),
      content: 'stock after switch',
    }, assembled.mainAgent, assembled.mainSession)
    expect(released.isError).toBe(false)
    expect(assembled.pythonResolve({ agent: assembled.mainAgent })).toEqual({})
  })
})
