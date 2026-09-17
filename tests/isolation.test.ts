import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyRoleSandbox, roleWritableRoot } from '../src/policy/sandbox-roots.js'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-sandbox-'))
  cleanup.push(root)
  for (const dir of ['Outline', 'Theory', 'Data/Processed', 'Plots', 'Report']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

describe('roleWritableRoot', () => {
  it('maps each role to its writable directory under the experiment root', () => {
    const root = workspace()
    expect(roleWritableRoot(root, 'MAIN')).toBe(resolve(root, 'Outline'))
    expect(roleWritableRoot(root, 'THEORY')).toBe(resolve(root, 'Theory'))
    expect(roleWritableRoot(root, 'DATA_ANALYSIS')).toBe(resolve(root, 'Data/Processed'))
    expect(roleWritableRoot(root, 'PLOTTING')).toBe(resolve(root, 'Plots'))
    expect(roleWritableRoot(root, 'REPORT')).toBe(resolve(root, 'Report'))
  })
})

describe('applyRoleSandbox', () => {
  it('pins workspace-write mode without changing session cwd', () => {
    const root = workspace()
    const session = Session.create(SessionId('sandbox-main'), undefined, {
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
      id: SessionId('sandbox-main'),
      createdAt: Date.now(),
      cwd: root,
    })
    applyRoleSandbox(session, 'DATA_ANALYSIS', root)
    expect(session.header.cwd).toBe(root)
    expect(
      session.snapshotEvents().filter(event => event.type === 'sandbox/mode').map(event => event.data),
    ).toEqual([{ mode: 'workspace-write' }])
  })
})
