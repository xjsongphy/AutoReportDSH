import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installRenderReportPageTool, renderReportPage } from '../src/tools/render-report-page.js'

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

describe('render_report_page image-capability gate', () => {
  /** A REPORT agent whose route the gate resolves, plus the services it reads. */
  function bench(modalities: readonly string[] | undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'autoreport-preview-route-'))
    mkdirSync(join(dir, 'Report'))
    writeFileSync(join(dir, 'Report', 'main.pdf'), '%PDF')
    const spawned: { argv?: readonly string[] } = {}
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    const ctx = {
      get: (name: string) => name === 'llm'
        ? { resolveModelInfo: async () => ({ ...(modalities === undefined ? {} : { inputModalities: [...modalities] }) }) }
        : name === 'sandbox'
          ? { confine: async (args: readonly string[]) => { spawned.argv = args; return { argv: args, enforcement: 'full' } } }
          : name === 'subprocess'
            ? { spawn: (spec: { argv: readonly string[] }) => {
              writeFileSync(`${spec.argv.at(-1)}.png`, 'PNG')
              return {
                done: Promise.resolve({ exitCode: 0, signal: null }),
                collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
              }
            } }
            : undefined,
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
    }
    installRenderReportPageTool(ctx as never)
    if (tool === undefined) throw new Error('render_report_page was not registered')
    const route = { provider: 'deepseek', model: 'v41' }
    return {
      run: () => tool!.execute(
        { path: 'Report/main.pdf', page: 1 },
        { agent: { session: { id: 'report', header: { cwd: dir }, requestHeader: () => ({ config: route }) }, options: route }, signal: new AbortController().signal },
      ),
      spawned,
    }
  }

  it('renders for a route that declares image input', async () => {
    const { run, spawned } = bench(['text', 'image'])
    const result = await run() as { status: string }
    expect(result.status).toBe('success')
    expect(spawned.argv?.at(0)).toBe('pdftoppm')
  })

  it('refuses a text-only route before spawning anything', async () => {
    const { run, spawned } = bench(['text'])
    await expect(run()).rejects.toThrow(/model "v41" does not declare image input; switch to an image-capable model/)
    expect(spawned.argv).toBeUndefined()
  })

  it('refuses an unknown capability instead of gambling on the adapter', async () => {
    const { run } = bench(undefined)
    await expect(run()).rejects.toThrow(/does not declare image input/)
  })

  it('refuses a route it cannot resolve at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoreport-preview-route-'))
    mkdirSync(join(dir, 'Report'))
    writeFileSync(join(dir, 'Report', 'main.pdf'), '%PDF')
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    const ctx = {
      get: (name: string) => name === 'llm'
        ? { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
        : undefined,
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
    }
    installRenderReportPageTool(ctx as never)
    await expect(tool!.execute(
      { path: 'Report/main.pdf', page: 1 },
      { agent: { session: { id: 'report', header: { cwd: dir }, requestHeader: () => ({ config: {} }) }, options: {} }, signal: new AbortController().signal },
    )).rejects.toThrow(/route could not be resolved/)
  })
})
