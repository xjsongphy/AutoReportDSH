import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyRoleSandbox, roleWritableRoot } from '../src/policy/sandbox-roots.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('role sandbox roots', () => {
  it('maps each role to its writable directory under the experiment root', () => {
    const root = '/experiment'
    expect(roleWritableRoot(root, 'MAIN')).toBe(resolve(root, 'Outline'))
    expect(roleWritableRoot(root, 'THEORY')).toBe(resolve(root, 'Theory'))
    expect(roleWritableRoot(root, 'DATA_ANALYSIS')).toBe(resolve(root, 'Data/Processed'))
    expect(roleWritableRoot(root, 'PLOTTING')).toBe(resolve(root, 'Plots'))
    expect(roleWritableRoot(root, 'REPORT')).toBe(resolve(root, 'Report'))
  })

  it('pins workspace-write and a role writable root without changing session cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-sandbox-root-'))
    dirs.push(root)
    const sessionId = SessionId('main')
    const session = Session.create(sessionId, undefined, {
      version: 0,
      id: sessionId,
      createdAt: 0,
      cwd: root,
    })
    applyRoleSandbox(session, 'MAIN', root)
    expect(session.header.cwd).toBe(root)
    expect(session.events.filter(event => event.type === 'sandbox/mode').map(event => event.data)).toEqual([
      { mode: 'workspace-write' },
    ])
    expect(session.events.filter(event => event.type === 'sandbox/workspace-root').map(event => event.data)).toEqual([
      { workspaceRoot: resolve(root, 'Outline') },
    ])
  })
})
