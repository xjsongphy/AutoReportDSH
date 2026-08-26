import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import AutoReportWorkflowRuntime from '../src/runtime.js'
import { REQUIRED_DIRS } from '../src/workspace/init.js'
import { resolveWorkflowSettings, saveProjectSettings, workspaceIdForRoot } from '../src/settings.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  defaultLatexEngine: 'latexmk',
  defaultPythonEnv: undefined,
  workspaceRoot: undefined,
  specialistModel: undefined,
  executionTimeoutMs: 600_000,
}

describe('host workflow runtime', () => {
  it('initializes the experiment workspace once and records workflow metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = new AutoReportWorkflowRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = Session.create(SessionId('main'))
    runtime.maybeInitialize(session)
    for (const dir of REQUIRED_DIRS) {
      expect(existsSync(join(root, dir))).toBe(true)
    }
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)
    const meta = runtime.forSession(session).state.projection().meta
    expect(meta?.initialized).toBe(true)
    expect(meta?.workspaceRoot).toBe(root)
    // The resolved settings snapshot is committed with the workflow event.
    expect(meta?.settings).toEqual(resolveWorkflowSettings({ composition: { ...CONFIG, workspaceRoot: root } }))
    runtime.maybeInitialize(session)
    expect(runtime.forSession(session).state.projection().meta?.initialized).toBe(true)
  })

  it('resolves the language from external project settings, never the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    tempDirs.push(root, home)
    saveProjectSettings(home, workspaceIdForRoot(root), { reportLanguage: 'typst' })
    const ctx = new Context()
    const runtime = new AutoReportWorkflowRuntime(ctx, { ...CONFIG, workspaceRoot: root }, { settingsHome: home })
    const session = Session.create(SessionId('main'))
    runtime.maybeInitialize(session)
    const meta = runtime.forSession(session).state.projection().meta
    expect(meta?.language).toBe('typst')
    expect(meta?.settings?.reportLanguage).toBe('typst')
    // Typst resources materialize; no LaTeX template ever lands in the workspace.
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
  })

  it('does not treat continuable children as Main parents', () => {
    const ctx = new Context()
    const runtime = new AutoReportWorkflowRuntime(ctx, CONFIG)
    const child = Session.create(SessionId('child'), undefined, {
      version: 0,
      id: SessionId('child'),
      createdAt: Date.now(),
      parentSession: SessionId('main'),
    })
    ctx.emit('session/event', child, child.append('turn/start', { turn: 1 }))
    expect(runtime.isMainSession(SessionId('child'))).toBe(false)
    expect(() => runtime.forSession(child)).toThrow(/owned by Main/)
  })
})
