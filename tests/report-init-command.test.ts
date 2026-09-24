import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReportInitCommand, parseReportInitInput, renderInitialization } from '../src/workspace/command.js'

const cleanup: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-cmd-'))
  cleanup.push(root)
  return root
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

/** Minimal invocation stub: the command only reads rawInput and agent.session.header.cwd. */
function invocation(rawInput: string, cwd?: string): CommandInvocation {
  return {
    commandId: 'cmd-1' as CommandInvocation['commandId'],
    agent: {
      session: { header: { cwd } },
    },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

describe('renderInitialization', () => {
  it('summarizes counts and marks skipped files as kept', () => {
    const text = renderInitialization({
      createdDirs: ['Data', 'Report'],
      writtenFiles: ['Report/main.tex'],
      skippedFiles: ['Report/mpltx.cls'],
    })
    expect(text).toContain('directories created: 2')
    expect(text).toContain('files written: 1')
    expect(text).toContain('files already present: 1')
    expect(text).toContain('= Report/mpltx.cls (kept)')
  })
})

describe('parseReportInitInput', () => {
  it('extracts the language flag anywhere and preserves multi-token directories', () => {
    expect(parseReportInitInput('--language typst /tmp/exp')).toEqual({ language: 'typst', directory: '/tmp/exp' })
    expect(parseReportInitInput('/tmp/my dir --language latex')).toEqual({ language: 'latex', directory: '/tmp/my dir' })
    expect(parseReportInitInput('  /only/dir  ')).toEqual({ language: undefined, directory: '/only/dir' })
    expect(parseReportInitInput('')).toEqual({ language: undefined, directory: '' })
  })

  it('rejects malformed flags loud', () => {
    expect(parseReportInitInput('--language')).toMatchObject({ error: /--language requires/ })
    expect(parseReportInitInput('--language markdown /x')).toMatchObject({ error: /--language must be latex or typst/ })
    expect(parseReportInitInput('--json /x')).toMatchObject({ error: /unknown option --json/ })
  })

  it('accepts a bare language token anywhere, first one winning', () => {
    expect(parseReportInitInput('typst /tmp/exp')).toEqual({ language: 'typst', directory: '/tmp/exp' })
    expect(parseReportInitInput('/tmp/my dir latex')).toEqual({ language: 'latex', directory: '/tmp/my dir' })
    // Only the first bare token is the language; a second one stays positional,
    // so a directory literally named `latex` can still be reached as `./latex`.
    expect(parseReportInitInput('typst latex /x')).toEqual({ language: 'typst', directory: 'latex /x' })
  })
})

describe('init command', () => {
  const definition = createReportInitCommand({ reportLanguage: 'latex' })

  it('registers under the init name with a hint', () => {
    expect(definition.name).toBe('init')
    expect(definition.input?.hint).toContain('[workspace-directory]')
  })

  it('initializes the explicit argument directory and reports the summary', async () => {
    const root = tempRoot()
    const result = await definition.handler(invocation(root))
    if (result.kind !== 'success') throw new Error(`expected success: ${JSON.stringify(result)}`)
    expect(result.text).toContain('Workspace ready')
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toContain('\\documentclass')
  })

  it('falls back to the session cwd when no argument is given', async () => {
    const root = tempRoot()
    const result = await definition.handler(invocation('', root))
    if (result.kind !== 'success') throw new Error(`expected success: ${JSON.stringify(result)}`)
    expect(result.text).toContain('files written: 2')
  })

  it('errors when neither argument, session cwd, nor default is available', async () => {
    const bare = createReportInitCommand({ reportLanguage: 'typst' })
    const result = await bare.handler(invocation('', undefined))
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.text).toContain('/init [--language latex|typst] <directory>')
    }
  })

  it('uses the configured workspaceRoot as last fallback', async () => {
    const root = tempRoot()
    const configured = createReportInitCommand({ reportLanguage: 'latex', workspaceRoot: root })
    const result = await configured.handler(invocation('', undefined))
    expect(result.kind).toBe('success')
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toContain('\\documentclass')
  })

  it('is idempotent through repeated invocations', async () => {
    const root = tempRoot()
    await definition.handler(invocation(root))
    const second = await definition.handler(invocation(root))
    if (second.kind !== 'success') throw new Error('expected success')
    expect(second.text).toContain('directories created: 0')
    expect(second.text).toContain('files already present: 2')
  })

  it('materializes the flagged language without a language store', async () => {
    const root = tempRoot()
    const result = await definition.handler(invocation(`--language typst ${root}`))
    if (result.kind !== 'success') throw new Error(`expected success: ${JSON.stringify(result)}`)
    expect(result.text).toContain('+ Report/main.typ')
    expect(result.text).toContain('report language: typst')
    expect(result.text).not.toContain('(saved')
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('records the explicit language in the settings store', async () => {
    const root = tempRoot()
    const written: Array<[string, string]> = []
    const store = createReportInitCommand({
      reportLanguage: 'latex',
      languageStore: {
        read: () => undefined,
        write: (workspaceRoot, language) => { written.push([workspaceRoot, language]) },
      },
    })
    const result = await store.handler(invocation(`typst ${root}`))
    if (result.kind !== 'success') throw new Error(`expected success: ${JSON.stringify(result)}`)
    expect(result.text).toContain('report language: typst (saved to settings)')
    expect(written).toEqual([[root, 'typst']])
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('prefers a recorded workspace language over the user default', async () => {
    const root = tempRoot()
    const store = createReportInitCommand({
      reportLanguage: 'latex',
      currentDefaultReportLanguage: () => 'latex',
      languageStore: { read: () => 'typst', write: () => undefined },
    })
    const implicit = await store.handler(invocation(root))
    if (implicit.kind !== 'success') throw new Error('expected success')
    expect(implicit.text).toContain('report language: typst')
    expect(implicit.text).not.toContain('(saved')
  })

  it('resolves a relative directory so the record and the files name one workspace', async () => {
    const root = tempRoot()
    const written: Array<[string, string]> = []
    const definition = createReportInitCommand({
      reportLanguage: 'latex',
      languageStore: { read: () => undefined, write: (workspaceRoot, language) => { written.push([workspaceRoot, language]) } },
    })
    // Relative to the process cwd, so the resolved key must be absolute while
    // the tree still lands in the same directory the key names.
    const result = await definition.handler(invocation(`typst ${relative(process.cwd(), root)}`))
    expect(result.kind).toBe('success')
    expect(written).toEqual([[root, 'typst']])
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

})
