import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import AutoReportWorkflowRuntime from '../src/runtime.js'
import { AUTOREPORT_MAIN_PRESET, isAutoReportMainSession } from '../src/membership.js'
import { REQUIRED_DIRS } from '../src/workspace/init.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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

/** A detached root session whose header names its composing agent preset. */
function rootSession(id: string, preset: string | undefined): Session {
  return Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: Date.now(),
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
}

describe('host workflow runtime', () => {
  it('initializes the experiment workspace once and records workflow metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = new AutoReportWorkflowRuntime(ctx, { ...CONFIG, workspaceRoot: root })
    const session = rootSession('main', AUTOREPORT_MAIN_PRESET)
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
    const session = rootSession('main', AUTOREPORT_MAIN_PRESET)
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

  it('leaves stock sessions untouched: no membership, no initialization, no workflow events', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-runtime-'))
    tempDirs.push(root)
    const ctx = new Context()
    const runtime = new AutoReportWorkflowRuntime(ctx, { ...CONFIG, workspaceRoot: root })

    // An ordinary top-level DSH session without the AutoReport preset…
    const stock = rootSession('stock-main', undefined)
    expect(isAutoReportMainSession(stock)).toBe(false)

    // …producing a normal first user turn must not join the runtime…
    const message = createUserMessage({
      content: [{ type: 'text', text: 'just answer my question' }],
      source: { kind: 'user' },
    })
    ctx.emit('session/event', stock, stock.append('user/message', message, { surfaceOp: 'append' }))

    // …and must show none of the AutoReport side effects.
    expect(runtime.isMainSession(SessionId('stock-main'))).toBe(false)
    expect(runtime.ownsSession(stock)).toBe(false)
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(root, dir))).toBe(false)
    expect(stock.events.some(event => event.type.startsWith('autoreport/'))).toBe(false)
    expect(() => runtime.forSession(stock)).toThrow(/requires the 'autoreport-main' preset/)
  })

  it('admits autoreport-main roots and ignores a later switch away while blank', () => {
    const ctx = new Context()
    const runtime = new AutoReportWorkflowRuntime(ctx, CONFIG)
    const session = rootSession('switchable', AUTOREPORT_MAIN_PRESET)
    ctx.emit('session/event', session, session.append('turn/start', { turn: 1 }))
    expect(runtime.isMainSession(SessionId('switchable'))).toBe(true)
    expect(runtime.ownsSession(session)).toBe(true)

    // A blank session may change presets; the newest logged selection wins and
    // ends AutoReport ownership (DSH's own resolveSessionPreset semantics).
    session.append('agent-preset/selected', { agentPreset: 'other-preset' })
    expect(isAutoReportMainSession(session)).toBe(false)
    expect(runtime.ownsSession(session)).toBe(false)
  })
})
