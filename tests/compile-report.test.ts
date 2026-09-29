import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { compileReport } from '../src/tools/compile-report.js'

function fixture(language: 'latex' | 'typst', exitCode: number, diagnostic: string, writePdfOnSuccess = true) {
  const workspace = mkdtempSync(join(tmpdir(), 'autoreport-compile-'))
  mkdirSync(join(workspace, 'Report'))
  const ext = language === 'latex' ? 'tex' : 'typ'
  writeFileSync(join(workspace, 'Report', `main.${ext}`), 'source')
  const argv: string[][] = []
  const ctx = {
    get: (name: string) => name === 'sandbox'
      ? { confine: (args: string[]) => { argv.push(args); return { argv: args, enforcement: 'full' } } }
      : name === 'subprocess'
        ? { spawn: () => {
          if (exitCode === 0 && writePdfOnSuccess) writeFileSync(join(workspace, 'Report', 'main.pdf'), '%PDF')
          return {
            stdout: Readable.from(['routine output\n']),
            stderr: Readable.from([diagnostic]),
            done: Promise.resolve({ exitCode, signal: null }),
          }
        } }
        : undefined,
  }
  const agent = { session: { id: 'report-session', header: { cwd: workspace } } }
  return { workspace, ctx: ctx as never, agent: agent as never, argv, path: `Report/main.${ext}` }
}

describe('compile_report', () => {
  it('uses fixed Typst argv and saves the complete diagnostic log on failure', async () => {
    const { workspace, ctx, agent, argv, path } = fixture('typst', 1, 'error: missing figure\n  ┌─ Report/main.typ:7:2\n')
    const result = await compileReport(ctx, agent, 'typst', path, new AbortController().signal)
    expect(argv[0]?.slice(0, 2)).toEqual(['typst', 'compile'])
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, pdf: null, language: 'typst' })
    expect(result.diagnostics).toContain('Report/main.typ:7:2')
    expect(readFileSync(join(workspace, result.log as string), 'utf8')).toContain('error: missing figure')
  })

  it('uses latexmk with shell escape disabled and reports only this build as successful', async () => {
    const { ctx, agent, argv, path } = fixture('latex', 0, 'LaTeX Warning: Example warning.\n')
    const result = await compileReport(ctx, agent, 'latex', path, new AbortController().signal)
    expect(argv[0]).toContain('-norc')
    expect(argv[0]).toContain('-pdfxelatex=xelatex -no-shell-escape %O %S')
    expect(result).toMatchObject({ status: 'success', pdf: 'Report/main.pdf', language: 'latex' })
    expect(result.diagnostics).toContain('LaTeX Warning')
  })

  it('accepts latexmk confirming an existing PDF is up-to-date', async () => {
    const { workspace, ctx, agent, path } = fixture('latex', 0, '', false)
    writeFileSync(join(workspace, 'Report', 'main.pdf'), '%PDF')
    const result = await compileReport(ctx, agent, 'latex', path, new AbortController().signal)
    expect(result).toMatchObject({ status: 'success', pdf: 'Report/main.pdf' })
  })

  it('rejects a wrong-language file before starting a process', async () => {
    const { ctx, agent, argv, path } = fixture('typst', 0, '')
    await expect(compileReport(ctx, agent, 'latex', path, new AbortController().signal)).rejects.toThrow(/\.tex entry/)
    expect(argv).toEqual([])
  })

  it('rejects shell-sensitive LaTeX entry names before calling latexmk', async () => {
    const { workspace, ctx, agent, argv } = fixture('latex', 0, '')
    writeFileSync(join(workspace, 'Report', 'bad;name.tex'), 'source')
    await expect(compileReport(ctx, agent, 'latex', 'Report/bad;name.tex', new AbortController().signal))
      .rejects.toThrow(/cannot safely pass/)
    expect(argv).toEqual([])
  })
})
