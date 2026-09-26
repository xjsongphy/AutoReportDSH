import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorkspaceDirectory, listWorkspaceDirectoryFromFs, type DirectoryFileSystem } from '../src/tools/list-directory.js'

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
    expect(() => listWorkspaceDirectory(root, join(root, 'Theory', 'formulas.md'))).toThrow(/workspace-relative/)
    expect(() => listWorkspaceDirectory(root, 'Theory/formulas.md')).toThrow(/not a directory/)
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

  it('uses DSH fs metadata and containment for provider-neutral listings', async () => {
    const root = 'mem://virtual/workspace'
    const joinProvider = (base: string, child: string) => `${base.replace(/\/+$/u, '')}/${child}`
    const entries = new Map<string, { type: string; children?: string[]; symlink?: boolean; target?: string }>([
      [root, { type: 'directory', children: ['.autoreport', 'Data', 'References'] }],
      [`${root}/.autoreport`, { type: 'directory' }],
      [`${root}/Data`, { type: 'directory', children: ['external', 'raw.csv'] }],
      [`${root}/Data/external`, { type: 'file', symlink: true, target: '/outside/secret.txt' }],
      [`${root}/Data/raw.csv`, { type: 'file' }],
      [`${root}/References`, { type: 'directory', children: ['guide.md'] }],
      [`${root}/References/guide.md`, { type: 'file' }],
    ])
    const listingSignals: (AbortSignal | undefined)[] = []
    const fs = {
      async resolve(path: string, opts?: { cwd?: string }) {
        const base = opts?.cwd ?? root
        if (path === '.') return { displayPath: base }
        return { displayPath: isAbsolute(path) || path.includes('://') ? path : joinProvider(base, path) }
      },
      contains(parent: { displayPath: string }, child: { displayPath: string }) {
        return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath.replace(/\/+$/u, '')}/`)
      },
      async stat(target: { displayPath: string }) {
        const entry = entries.get(target.displayPath)
        return entry === undefined ? undefined : { type: entry.type }
      },
      async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
        listingSignals.push(signal)
        const entry = entries.get(joinProvider(opts?.cwd ?? root, path))
        return entry === undefined ? undefined : { type: entry.symlink ? 'symlink' : entry.type }
      },
      async listDir(target: { displayPath: string }) {
        return (entries.get(target.displayPath)?.children ?? []).map(name => {
          const path = joinProvider(target.displayPath, name)
          const entry = entries.get(path)
          return {
            name,
            type: entry?.type ?? 'other',
            target: { displayPath: entry?.target ?? path },
          }
        })
      },
    } satisfies DirectoryFileSystem

    const controller = new AbortController()
    const listing = await listWorkspaceDirectoryFromFs(fs, root, '.', 2, controller.signal)
    expect(listing.directories).toEqual(['Data', 'References'])
    expect(listing.files).toEqual(['Data/raw.csv', 'References/guide.md'])
    expect(listing.links).toEqual(['Data/external'])
    expect(listingSignals.length).toBeGreaterThan(0)
    expect(listingSignals.every(signal => signal === controller.signal)).toBe(true)
    await expect(listWorkspaceDirectoryFromFs(fs, root, '../outside', 1)).rejects.toThrow(/outside/)
    await expect(listWorkspaceDirectoryFromFs(fs, root, root, 1)).rejects.toThrow(/workspace-relative/)
    await expect(listWorkspaceDirectoryFromFs(fs, root, 'mem://virtual/secret', 1)).rejects.toThrow(/workspace-relative/)
  })
})
