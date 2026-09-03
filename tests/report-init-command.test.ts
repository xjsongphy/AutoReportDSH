import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createReportInitCommand, parseReportInitInput, renderInitialization } from '../src/workspace/command.js'
import { seedSyncedResourceStubs } from './helpers/synced-resource-stubs.js'

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
})

describe('init command', () => {
  const overlayRoot = seedSyncedResourceStubs(mkdtempSync(join(tmpdir(), 'autoreport-cmd-overlay-')))
  afterAll(() => rmSync(overlayRoot, { recursive: true, force: true }))
  const definition = createReportInitCommand({ reportLanguage: 'latex', overlayRoot })

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

  it('materializes the flagged language without a settings store', async () => {
    const root = tempRoot()
    const result = await definition.handler(invocation(`--language typst ${root}`))
    if (result.kind !== 'success') throw new Error(`expected success: ${JSON.stringify(result)}`)
    expect(result.text).toContain('+ Report/main.typ')
    expect(result.text).toContain('report language: typst')
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('prefers the stored project language over factory defaults when no flag is given', async () => {
    const root = tempRoot()
    const saved: unknown[] = []
    const store = createReportInitCommand({
      reportLanguage: 'latex',
      overlayRoot,
      projectStore: () => ({
        load: () => ({ reportLanguage: 'typst' }),
        save: next => void saved.push(next),
      }),
    })
    const implicit = await store.handler(invocation(root))
    if (implicit.kind !== 'success') throw new Error('expected success')
    expect(implicit.text).toContain('report language: typst')
    expect(saved).toHaveLength(0)

    const explicit = await store.handler(invocation(`--language latex ${root}`))
    if (explicit.kind !== 'success') throw new Error('expected success')
    expect(explicit.text).toContain('report language: latex (saved to project settings)')
    expect(saved).toEqual([{ reportLanguage: 'latex' }])
  })

  it('surfaces store failures as command errors without initializing', async () => {
    const root = tempRoot()
    const failing = createReportInitCommand({
      reportLanguage: 'latex',
      projectStore: () => ({ load: () => { throw new Error('corrupt document') }, save: () => undefined }),
    })
    const result = await failing.handler(invocation(root))
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('corrupt document')
    expect(existsSync(join(root, 'Data'))).toBe(false)
  })
})
