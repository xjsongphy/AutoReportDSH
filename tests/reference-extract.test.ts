import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installReferenceExtractTool } from '../src/tools/reference-extract.js'

describe('reference_extract', () => {
  it('passes a References PDF and an Outline output directory as fixed argv', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-reference-'))
    mkdirSync(join(root, 'References'))
    mkdirSync(join(root, 'Outline'))
    writeFileSync(join(root, 'References', 'handout.pdf'), '%PDF')
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    let argv: readonly string[] = []
    const ctx = {
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
      get: (name: string) => name === 'sandbox'
        ? { confine: (args: readonly string[]) => { argv = args; return { argv: args, enforcement: 'full' } } }
        : name === 'subprocess'
          ? { spawn: () => ({
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: { stdout: { readFrom: () => ({ text: 'done' }) }, stderr: { readFrom: () => ({ text: '' }) } },
          }) }
          : undefined,
    }
    installReferenceExtractTool(ctx as never)
    const result = await tool?.execute({ path: 'References/handout.pdf' }, {
      agent: { session: { id: 'main', header: { cwd: root } } },
      signal: new AbortController().signal,
    }) as { status: string; outputDir: string }
    expect(result).toMatchObject({ status: 'success', outputDir: 'Outline/.cache/mineru/handout' })
    expect(argv.slice(0, 2)).toEqual(['mineru-open-api', 'extract'])
    expect(argv.at(-2)).toBe('-o')
    expect(argv.at(-1)).toBe(join(root, 'Outline', '.cache', 'mineru', 'handout'))
  })
})
