import { describe, expect, it, vi } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config } from '../src/config.js'
import { createCompileReportTool } from '../src/tools/compile-report.js'

const CONFIG: Pick<Config, 'reportLanguage' | 'latexEngine'> = {
  reportLanguage: 'latex',
  latexEngine: 'latexmk',
}

function exec(sessionId = 'report-child'): ToolExecution {
  return {
    name: 'compile_report',
    arguments: {},
    agent: { id: sessionId },
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function harness(options: {
  role?: string
  runnerOutcome?: { exit_code: number | null; stdout?: string; stderr?: string; timed_out?: boolean }
} = {}) {
  const runnerCalls: Array<{ argv: readonly string[]; cwd: string }> = []
  const artifacts: Array<Record<string, unknown>> = []
  let listed = ['main.tex', 'main.aux', 'Report.tex~']
  const tool = createCompileReportTool({
    config: CONFIG,
    resolveCallerRole: () => {
      if (options.role !== undefined && options.role !== 'REPORT') throw new Error(`AutoReport compile_report is available only to REPORT (caller: ${options.role})`)
      return { sessionId: 'report-child', workspaceRoot: '/workspace' }
    },
    runner: async request => {
      runnerCalls.push({ argv: request.argv, cwd: request.cwd })
      // The compiler produced main.pdf and an ignored .aux intermediate.
      listed = [...listed, 'main.pdf']
      return {
        exit_code: options.runnerOutcome !== undefined && 'exit_code' in options.runnerOutcome ? options.runnerOutcome.exit_code : 0,
        stdout: options.runnerOutcome?.stdout ?? 'out',
        stderr: options.runnerOutcome?.stderr ?? 'err',
        timed_out: options.runnerOutcome?.timed_out ?? false,
      }
    },
    listFilesFiltered: () => listed,
    commitArtifact: snapshot => artifacts.push(snapshot),
  })
  const call = (args: Record<string, unknown> = {}) => tool.execute(args as never, exec() as never) as Promise<Record<string, unknown>>
  return { call, runnerCalls, artifacts }
}

describe('compile_report', () => {
  it('builds latexmk argv by default for latex and records created PDFs only', async () => {
    const run = harness()
    const result = await run.call()
    expect(run.runnerCalls[0]).toMatchObject({
      argv: ['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-cd', 'main.tex'],
      cwd: '/workspace/Report',
    })
    expect(result).toMatchObject({ ok: true, engine: 'latexmk', artifact_path: 'Report/main.pdf' })
    expect(String(result['log_tail'])).toContain('err')
    expect(run.artifacts.map(artifact => artifact['path'])).toEqual(['main.pdf'])
    expect(run.artifacts[0]).toMatchObject({ status: 'created', producedBy: 'REPORT', origin: 'process' })
  })

  it('derives typst engine and entry from language when overriding engine=typst', async () => {
    const run = harness()
    await run.call({ engine: 'typst' })
    expect(run.runnerCalls[0]?.argv).toEqual(['typst', 'compile', 'main.typ', 'main.pdf'])
  })

  it('uses typst defaults when configured language is typst', async () => {
    const listed = ['main.typ']
    const tool = createCompileReportTool({
      config: { reportLanguage: 'typst', latexEngine: 'latexmk' },
      resolveCallerRole: () => ({ sessionId: 'r', workspaceRoot: '/w' }),
      runner: async () => ({ exit_code: 0, stdout: '', stderr: '', timed_out: false }),
      listFilesFiltered: () => listed,
      commitArtifact: () => undefined,
    })
    const result = await tool.execute({}, exec() as never) as Record<string, unknown>
    expect(result).toMatchObject({ engine: 'typst', artifact_path: 'Report/main.pdf' })
  })

  it('denies non-REPORT callers before running anything', async () => {
    const run = harness({ role: 'PLOTTING' })
    await expect(run.call()).rejects.toThrow(/only to REPORT/)
    expect(run.runnerCalls).toHaveLength(0)
    expect(run.artifacts).toHaveLength(0)
  })

  it('refuses tectonic without a verified local cache and never runs it', async () => {
    delete process.env['AUTOREPORT_TECTONIC_CACHE']
    delete process.env['TECTONIC_CACHE']
    const run = harness()
    await expect(run.call({ engine: 'tectonic' })).rejects.toThrow(/local bundle cache/)
    expect(run.runnerCalls).toHaveLength(0)
  })

  it('runs tectonic when a local cache directory exists', async () => {
    process.env['TECTONIC_CACHE'] = '/tmp'
    try {
      const run = harness()
      await run.call({ engine: 'tectonic' })
      expect(run.runnerCalls[0]?.argv).toEqual(['tectonic', 'main.tex'])
    } finally {
      delete process.env['TECTONIC_CACHE']
    }
  })

  it('maps timeout outcomes without recording artifacts on failure', async () => {
    const run = harness({ runnerOutcome: { exit_code: null, timed_out: true } })
    const result = await run.call({ timeout_ms: 50 })
    expect(result).toMatchObject({ ok: false, timed_out: true })
    expect(run.artifacts).toHaveLength(0)
  })

  it('does not record artifacts when compilation fails', async () => {
    const run = harness({ runnerOutcome: { exit_code: 1 } })
    const result = await run.call()
    expect(result['ok']).toBe(false)
    expect(run.artifacts).toHaveLength(0)
  })

  it('validates timeout bounds', async () => {
    const run = harness()
    await expect(run.call({ timeout_ms: 0 })).rejects.toThrow(/timeout_ms/)
    await expect(run.call({ timeout_ms: 3_600_001 })).rejects.toThrow(/timeout_ms/)
  })
})
