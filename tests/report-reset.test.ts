/** `/reset`: back to a freshly initialized workspace, user inputs untouched. */

import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureInitialized, type ReportLanguage } from '../src/workspace/init.js'
import {
  createReportResetCommand,
  parseReportResetInput,
  renderReset,
  resetWorkspace,
} from '../src/workspace/reset.js'

const cleanup: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-reset-'))
  cleanup.push(root)
  return root
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

function write(path: string, body = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

/** One workspace carrying both generated work and user-supplied inputs. */
function seededWorkspace(language: ReportLanguage = 'latex'): string {
  const root = tempRoot()
  ensureInitialized(root, language)
  write(join(root, 'Outline/report_outline.md'))
  write(join(root, 'Outline/.cache/mineru/lecture/lecture.md'))
  write(join(root, 'Theory/theory.md'))
  write(join(root, 'Plots/Fig/iv.png'))
  write(join(root, 'Plots/Scripts/plot.py'))
  write(join(root, 'Report/main.pdf'))
  write(join(root, 'Data/Processed/clean.csv'))
  write(join(root, 'Data/raw.txt'), 'raw measurement')
  write(join(root, 'References/handout.pdf'), 'paper')
  return root
}

/** Minimal invocation stub: the command reads rawInput and the agent session. */
function invocation(rawInput: string, cwd?: string, sessionId = 'reset-main'): CommandInvocation {
  const id = SessionId(sessionId)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id,
    createdAt: 1,
    ...(cwd === undefined ? {} : { cwd }),
  })
  return {
    commandId: 'cmd-1',
    agent: { session },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
}

describe('resetWorkspace', () => {
  it('clears the generated work, restores the skeleton, and leaves the inputs alone', () => {
    const root = seededWorkspace()
    const result = resetWorkspace(root, 'latex')

    for (const gone of [
      'Outline/report_outline.md',
      'Outline/.cache/mineru/lecture/lecture.md',
      'Theory/theory.md',
      'Plots/Fig/iv.png',
      'Plots/Scripts/plot.py',
      'Report/main.pdf',
      'Data/Processed/clean.csv',
    ]) {
      expect(existsSync(join(root, gone)), gone).toBe(false)
    }
    // The skeleton comes back immediately, so the workspace is usable at once.
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toContain('\\documentclass')
    for (const kept of ['Data/raw.txt', 'References/handout.pdf']) {
      expect(existsSync(join(root, kept)), kept).toBe(true)
    }
    expect(result.clearedDirs).toEqual(['Outline', 'Theory', 'Plots', 'Report', 'Data/Processed'])
    expect(result.removedEntries).toBeGreaterThanOrEqual(7)
    expect(result.writtenFiles).toContain('Report/main.tex')
  })

  it('restores the templates of the workspace language, not the other one', () => {
    const root = seededWorkspace('typst')
    resetWorkspace(root, 'typst')
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
  })

  it('clears only what holds something, and restores the skeleton it did clear', () => {
    const root = tempRoot()
    ensureInitialized(root, 'latex')
    const result = resetWorkspace(root, 'latex')
    // A freshly initialized workspace holds only its own skeleton: Plots'
    // required subdirectories and the materialized templates (main.tex and
    // mpltx.cls for LaTeX). Empty targets are already what a reset wants, so
    // Outline, Theory and Data/Processed are not named.
    expect(result.clearedDirs).toEqual(['Plots', 'Report'])
    expect(result.removedEntries).toBe(4)
    expect(existsSync(join(root, 'Outline'))).toBe(true)
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toContain('\\documentclass')
  })

  it('refuses a root that is not a directory instead of creating one', () => {
    expect(() => resetWorkspace(join(tempRoot(), 'missing'), 'latex')).toThrow(/not a directory/)
  })
})

describe('parseReportResetInput', () => {
  it('treats the whole tail as the directory', () => {
    expect(parseReportResetInput(' /tmp/my dir ')).toEqual({ directory: '/tmp/my dir' })
    expect(parseReportResetInput('')).toEqual({ directory: '' })
  })

  it('rejects options it does not have', () => {
    expect(parseReportResetInput('--language typst /x')).toMatchObject({ error: /unknown option --language/ })
  })
})

describe('renderReset', () => {
  it('lists what was cleared, what came back, and what was kept', () => {
    const text = renderReset({
      clearedDirs: ['Theory'],
      removedEntries: 2,
      createdDirs: ['Theory'],
      writtenFiles: [],
    })
    expect(text).toContain('cleared: Theory (2 entries)')
    expect(text).toContain('directories created: 1')
    expect(text).toContain('kept: Data/ (except Data/Processed), References/')
  })
})

describe('reset command', () => {
  const definition = createReportResetCommand({ reportLanguage: 'latex' })

  it('registers under the reset name with a directory hint', () => {
    expect(definition.name).toBe('reset')
    expect(definition.input?.hint).toContain('[workspace-directory]')
  })

  it('resets the explicit argument directory', async () => {
    const root = seededWorkspace()
    const result = await definition.handler(invocation(root))
    if (result.kind !== 'success') throw new Error(`expected success: ${JSON.stringify(result)}`)
    expect(result.text).toContain('Workspace reset')
    expect(existsSync(join(root, 'Theory/theory.md'))).toBe(false)
    expect(result.text).toContain('report language: latex')
  })

  it('falls back to the session cwd and to the configured root', async () => {
    const root = seededWorkspace()
    const fromCwd = await definition.handler(invocation('', root))
    expect(fromCwd.kind).toBe('success')
    const configured = createReportResetCommand({ reportLanguage: 'latex', workspaceRoot: root })
    const fromConfig = await configured.handler(invocation('', undefined))
    expect(fromConfig.kind).toBe('success')
  })

  it('errors when no directory is available and when the directory is missing', async () => {
    const bare = createReportResetCommand({ reportLanguage: 'latex' })
    const none = await bare.handler(invocation('', undefined))
    expect(none.kind).toBe('error')
    if (none.kind === 'error') expect(none.text).toContain('/reset <workspace-directory>')
    const missing = await definition.handler(invocation(join(tempRoot(), 'nope')))
    expect(missing.kind).toBe('error')
  })

  it('resolves a relative directory to the workspace it clears', async () => {
    const root = seededWorkspace()
    const result = await definition.handler(invocation(relative(process.cwd(), root)))
    expect(result.kind).toBe('success')
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)
  })

  it('clears the invoking session workflow when the reset root owns it', async () => {
    const root = seededWorkspace()
    const cleared: string[] = []
    const command = createReportResetCommand({
      reportLanguage: 'latex',
      workflow: {
        root: () => root,
        reset: session => { cleared.push(String(session.id)) },
      },
    })
    const result = await command.handler(invocation(root))
    if (result.kind !== 'success') throw new Error('expected success')
    expect(cleared).toEqual(['reset-main'])
    expect(result.text).toContain('task board: this session workflow cleared')
  })

  it('leaves a foreign session workflow alone and says so', async () => {
    const root = seededWorkspace()
    const cleared: string[] = []
    const command = createReportResetCommand({
      reportLanguage: 'latex',
      workflow: {
        root: () => '/somewhere/else',
        reset: session => { cleared.push(String(session.id)) },
      },
    })
    const result = await command.handler(invocation(root))
    if (result.kind !== 'success') throw new Error('expected success')
    expect(cleared).toEqual([])
    expect(result.text).toContain('task board: left alone (/somewhere/else)')
  })

  it('does not clear the workflow when the reset itself failed', async () => {
    const cleared: string[] = []
    const command = createReportResetCommand({
      reportLanguage: 'latex',
      workflow: {
        root: () => '/nowhere',
        reset: session => { cleared.push(String(session.id)) },
      },
    })
    const result = await command.handler(invocation(join(tempRoot(), 'missing')))
    expect(result.kind).toBe('error')
    expect(cleared).toEqual([])
  })

  it('uses the recorded workspace language for the restored templates', async () => {
    const root = seededWorkspace('latex')
    const command = createReportResetCommand({
      reportLanguage: 'latex',
      languageStore: { read: () => 'typst', write: () => undefined },
    })
    const result = await command.handler(invocation(root))
    if (result.kind !== 'success') throw new Error('expected success')
    expect(result.text).toContain('report language: typst')
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
  })
})
