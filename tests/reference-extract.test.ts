import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTRACT_TIMEOUT_MS, MINERU_TIMEOUT_SECONDS, installReferenceExtractTool } from '../src/tools/reference-extract.js'

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
    expect(argv.at(-1)).toBe(realpathSync(join(root, 'Outline', '.cache', 'mineru', 'handout')))
  })

  it('passes the configured CLI timeout through to mineru before the -o flag', async () => {
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
    await tool?.execute({ path: 'References/handout.pdf' }, {
      agent: { session: { id: 'main', header: { cwd: root } } },
      signal: new AbortController().signal,
    })
    const timeoutIndex = argv.indexOf('--timeout')
    expect(timeoutIndex).toBeGreaterThan(-1)
    expect(argv[timeoutIndex + 1]).toBe('300')
    expect(timeoutIndex).toBeLessThan(argv.indexOf('-o'))
  })

  it('keeps CJK characters in the cache output directory name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-reference-'))
    mkdirSync(join(root, 'References'))
    mkdirSync(join(root, 'Outline'))
    writeFileSync(join(root, 'References', '教材讲义.pdf'), '%PDF')
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    const ctx = {
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
      get: (name: string) => name === 'sandbox'
        ? { confine: (args: readonly string[]) => ({ argv: args, enforcement: 'full' }) }
        : name === 'subprocess'
          ? { spawn: () => ({
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: { stdout: { readFrom: () => ({ text: 'done' }) }, stderr: { readFrom: () => ({ text: '' }) } },
          }) }
          : undefined,
    }
    installReferenceExtractTool(ctx as never)
    const result = await tool?.execute({ path: 'References/教材讲义.pdf' }, {
      agent: { session: { id: 'main', header: { cwd: root } } },
      signal: new AbortController().signal,
    }) as { status: string; outputDir: string }
    expect(result).toMatchObject({ status: 'success', outputDir: 'Outline/.cache/mineru/教材讲义' })
  })

  it('reports CLI failures with the real error instead of a bare timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-reference-'))
    mkdirSync(join(root, 'References'))
    mkdirSync(join(root, 'Outline'))
    writeFileSync(join(root, 'References', 'handout.pdf'), '%PDF')
    let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    const ctx = {
      tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
      get: (name: string) => name === 'sandbox'
        ? { confine: (args: readonly string[]) => ({ argv: args, enforcement: 'full' }) }
        : name === 'subprocess'
          ? { spawn: () => ({
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: 'Thinking... handout.pdf\n' }) },
              stderr: { readFrom: () => ({ text: 'Error: timeout waiting for batch abc\n' }) },
            },
          }) }
          : undefined,
    }
    installReferenceExtractTool(ctx as never)
    const result = await tool?.execute({ path: 'References/handout.pdf' }, {
      agent: { session: { id: 'main', header: { cwd: root } } },
      signal: new AbortController().signal,
    }) as { status: string; diagnostics: string }
    expect(result.status).toBe('failed')
    expect(result.diagnostics).toContain('Error: timeout waiting for batch abc')
  })

  it('surfaces a real CLI error before the wrapper deadline when the server stalls', async () => {
    // Wrapper deadline must sit at CLI timeout + 30s (Python-reference parity),
    // so mineru's own `--timeout` error lands in diagnostics instead of a bare kill.
    expect(EXTRACT_TIMEOUT_MS).toBe((MINERU_TIMEOUT_SECONDS + 30) * 1000)
    expect(MINERU_TIMEOUT_SECONDS).toBe(300)
  })
})
