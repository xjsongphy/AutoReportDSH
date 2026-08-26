import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import AutoReportWorkflowRuntime from '../src/runtime.js'
import { REQUIRED_DIRS } from '../src/workspace/init.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CONFIG: Config = {
  reportLanguage: 'latex',
  latexEngine: 'latexmk',
  pythonEnv: undefined,
  workspaceRoot: undefined,
  specialistRoute: undefined,
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
    runtime.maybeInitialize(session)
    expect(runtime.forSession(session).state.projection().meta?.initialized).toBe(true)
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
