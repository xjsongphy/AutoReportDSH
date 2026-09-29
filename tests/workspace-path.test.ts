import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertWorkspaceRoot, ensureOwnedDirectory, existingWorkspacePath } from '../src/workspace/path.js'

describe('workspace tool paths', () => {
  it('uses the experiment root and rejects traversal and symlink escapes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autoreport-path-'))
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-outside-'))
    mkdirSync(join(workspace, 'Report'))
    writeFileSync(join(workspace, 'Report', 'main.typ'), 'Hello')
    writeFileSync(join(outside, 'secret.typ'), 'secret')
    symlinkSync(outside, join(workspace, 'Report', 'escape'))

    const entry = existingWorkspacePath(workspace, 'Report/main.typ')
    expect(entry.relative).toBe('Report/main.typ')
    expect(existingWorkspacePath(workspace, 'Report\\main.typ')).toEqual(entry)
    expect(existingWorkspacePath(workspace, join(workspace, 'Report', 'main.typ'))).toEqual(entry)
    expect(() => assertWorkspaceRoot(entry, 'Report')).not.toThrow()
    expect(() => existingWorkspacePath(workspace, '../secret.typ')).toThrow(/invalid workspace-relative path/)
    expect(() => existingWorkspacePath(workspace, 'Report/escape/secret.typ')).toThrow(/outside/)
    expect(() => ensureOwnedDirectory(workspace, 'Report', ['escape', 'build'])).toThrow(/unsafe/)
  })
})
