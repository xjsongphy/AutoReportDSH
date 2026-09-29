import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderReportPage } from '../src/tools/render-report-page.js'

describe('render_report_page', () => {
  it('renders a chosen Report PDF page as a readable PNG in Report cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-preview-'))
    mkdirSync(join(root, 'Report'))
    writeFileSync(join(root, 'Report', 'main.pdf'), '%PDF')
    let argv: readonly string[] = []
    const ctx = {
      get: (name: string) => name === 'sandbox'
        ? { confine: async (args: readonly string[]) => { argv = args; return { argv: args, enforcement: 'full' } } }
        : name === 'subprocess'
          ? { spawn: (spec: { argv: readonly string[] }) => {
            writeFileSync(`${spec.argv.at(-1)}.png`, 'PNG')
            return {
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
            }
          } }
          : undefined,
    }
    const agent = { session: { id: 'report', header: { cwd: root } } }
    const result = await renderReportPage(ctx as never, agent as never, 'Report/main.pdf', 3, new AbortController().signal)
    expect(result.status).toBe('success')
    expect(result.page).toBe(3)
    expect(result.image).toMatch(/^Report\/\.cache\/preview\/[^/]+\.png$/u)
    expect(readFileSync(join(root, result.image as string), 'utf8')).toBe('PNG')
    expect(argv.slice(0, 6)).toEqual(['pdftoppm', '-f', '3', '-l', '3', '-singlefile'])
  })

  it('rejects PDFs outside Report and invalid page numbers before spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-preview-scope-'))
    mkdirSync(join(root, 'Report'))
    mkdirSync(join(root, 'References'))
    writeFileSync(join(root, 'References', 'paper.pdf'), '%PDF')
    const agent = { session: { id: 'report', header: { cwd: root } } }
    await expect(renderReportPage({} as never, agent as never, 'References/paper.pdf', 1, new AbortController().signal))
      .rejects.toThrow(/inside Report/)
    await expect(renderReportPage({} as never, agent as never, 'References/paper.pdf', 0, new AbortController().signal))
      .rejects.toThrow(/page must/)
  })
})
