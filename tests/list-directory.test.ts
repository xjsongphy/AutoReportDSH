import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorkspaceDirectory } from '../src/tools/list-directory.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-list-directory-'))
  roots.push(root)
  mkdirSync(join(root, 'Theory', 'Derivations'), { recursive: true })
  mkdirSync(join(root, 'Data'), { recursive: true })
  mkdirSync(join(root, '.autoreport'), { recursive: true })
  writeFileSync(join(root, 'Theory', 'formulas.md'), 'not returned as content')
  writeFileSync(join(root, 'Theory', 'Derivations', 'model.md'), 'derivation body')
  writeFileSync(join(root, 'Data', 'raw.csv'), 'private readings')
  return root
}

describe('listWorkspaceDirectory', () => {
  it('lists names at bounded depth without exposing contents or internal metadata', () => {
    const root = workspace()
    const top = listWorkspaceDirectory(root)
    expect(top).toMatchObject({ path: '.', directories: ['Data', 'Theory'], files: [], truncated: false })
    const theory = listWorkspaceDirectory(root, 'Theory', 2)
    expect(theory.directories).toEqual(['Derivations'])
    expect(theory.files).toEqual(['formulas.md', 'Derivations/model.md'].sort((a, b) => a.localeCompare(b)))
    expect(JSON.stringify(theory)).not.toContain('derivation body')
  })

  it('refuses traversal outside the workspace and non-directory paths', () => {
    const root = workspace()
    expect(() => listWorkspaceDirectory(root, '..')).toThrow(/outside/)
    expect(() => listWorkspaceDirectory(root, join(root, 'Theory', 'formulas.md'))).toThrow(/not a directory/)
    expect(() => listWorkspaceDirectory(root, 'Theory', 5)).toThrow(/depth/)
  })

  it.skipIf(process.platform === 'win32')('does not follow a symlink outside the workspace', () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-list-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'Theory', 'external'))
    expect(listWorkspaceDirectory(root, 'Theory').links).toEqual(['external'])
    expect(() => listWorkspaceDirectory(root, 'Theory/external')).toThrow(/outside/)
  })
})
