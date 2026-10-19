import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installReferenceExtractTool } from '../src/tools/extract-pdf.js'
import { hasMineruAttempt } from '../src/tools/reference-preview.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function bench(extracted = true, modalities = ['text', 'image']) {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-reference-page-')); dirs.push(root)
  mkdirSync(join(root, 'References')); mkdirSync(join(root, 'Outline'))
  writeFileSync(join(root, 'References/book.pdf'), '%PDF-source')
  if (extracted) { mkdirSync(join(root, 'References/book')); writeFileSync(join(root, 'References/book/book.md'), 'MinerU output omitted a handwritten dimension.') }
  let definition: any
  const calls: string[][] = []
  const ctx = {
    tools: { register: (tool: any) => { definition = tool; return () => {} } },
    get: (name: string) => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: modalities }) }
      : name === 'sandbox' ? { confine: async (argv: string[], options: any) => {
        if (options.workspaceRoot !== realpathSync(join(root, 'Outline'))) throw new Error('wrong writable root')
        return { argv, enforcement: 'full' }
      } } : name === 'subprocess' ? { spawn: ({ argv }: { argv: string[] }) => {
        calls.push(argv); writeFileSync(argv.at(-1)!, 'PNG')
        return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      } } : undefined,
  }
  installReferenceExtractTool(ctx as never)
  const agent = { options: { provider: 'test', model: 'image' }, session: {
    id: 'main', header: { cwd: root }, requestHeader: () => undefined, snapshotEvents: () => [],
  } }
  return { root, agent, calls, run: (args: any) => definition.execute(args, { agent, signal: new AbortController().signal }) }
}
const request = { path: 'References/book.pdf', page: 3, extraction_issue: 'The handwritten dimension beside the diagram is absent from MinerU output.' }

describe('MinerU-first original-page fallback', () => {
  it('renders a bounded page under Outline without changing the source or extracted text', async () => {
    const b = bench(); const result = await b.run(request)
    expect(result.status).toBe('success')
    expect(result.image).toMatch(/^Outline\/\.cache\/reference-preview\/.+\.png$/u)
    expect(readFileSync(join(b.root, 'References/book.pdf'), 'utf8')).toBe('%PDF-source')
    expect(readFileSync(join(b.root, 'References/book/book.md'), 'utf8')).toContain('MinerU output')
    expect(b.calls[0]?.slice(-3, -1)).toEqual([realpathSync(join(b.root, 'References/book.pdf')), '3'])
    expect(b.calls[0]?.[2]).toContain('2000/max(')
  })
  it('refuses a bypass before any extraction attempt', async () => {
    const b = bench(false)
    await expect(b.run(request)).rejects.toThrow(/MinerU extraction first/)
    expect(b.calls).toHaveLength(0)
  })
  it('requires an explicit extraction gap', async () => {
    const b = bench()
    await expect(b.run({ path: request.path, page: 1 })).rejects.toThrow(/extraction_issue/)
    await expect(b.run({ ...request, extraction_issue: 'look' })).rejects.toThrow(/specific MinerU/)
    expect(b.calls).toHaveLength(0)
  })
  it('keeps the source root, page bounds and image-capability checks', async () => {
    const b = bench()
    await expect(b.run({ ...request, path: '../outside.pdf' })).rejects.toThrow()
    await expect(b.run({ ...request, page: 0 })).rejects.toThrow(/page must/)
    await expect(bench(true, ['text']).run(request)).rejects.toThrow(/does not declare image input/)
    expect(b.calls).toHaveLength(0)
  })
  it('accepts a recorded failed MinerU attempt but not a dispatch error', () => {
    const b = bench(false)
    const rows = [
      { type: 'tool/call', data: { name: 'extract_pdf', callId: 'c', arguments: JSON.stringify({ path: request.path }) } },
      { type: 'tool/result', data: { message: { toolCallId: 'c', content: [{ type: 'text', text: JSON.stringify({ status: 'failed' }) }] } } },
    ]
    const agent = { session: { snapshotEvents: () => rows } }
    expect(hasMineruAttempt(agent as never, request.path, join(b.root, 'References/book.pdf'))).toBe(true)
    rows[1]!.data = { message: { toolCallId: 'c', content: [{ type: 'text', text: 'permission denied' }] } } as never
    expect(hasMineruAttempt(agent as never, request.path, join(b.root, 'References/book.pdf'))).toBe(false)
  })
})
