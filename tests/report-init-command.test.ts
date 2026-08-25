import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReportInitCommand, renderInitialization } from '../src/workspace/command.js'

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

describe('report-init command', () => {
  const definition = createReportInitCommand({ reportLanguage: 'latex' })

  it('registers under the report-init name with a hint', () => {
    expect(definition.name).toBe('report-init')
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
    if (result.kind === 'error') expect(result.text).toContain('/report-init <directory>')
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
})
