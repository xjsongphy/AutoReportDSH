import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_SCAN_DEPTH,
  MAX_SCAN_ENTRIES,
  diffSnapshots,
  directoryOf,
  shouldIgnore,
  shouldIgnoreDir,
  shouldIgnoreFile,
  snapshotDir,
  type DirSnapshot,
  type FileSnapshot,
} from '../src/artifacts/artifact-policy.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'autoreport-policy-'))
})

afterAll(() => {
  // Temp roots are per-test-run scratch under the OS tempdir.
})

function snapshotPaths(root: string, bounds?: { maxDepth?: number; maxEntries?: number }): string[] {
  return [...snapshotDir(root, bounds).keys()]
}

function makeSnapshot(entries: Readonly<Record<string, FileSnapshot>>): DirSnapshot {
  return new Map(Object.entries(entries))
}

function file(relPath: string): void {
  const absolute = join(root, relPath)
  mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true })
  writeFileSync(absolute, 'x')
}

describe('AutoReport artifact ignore rules (manifest.rs port)', () => {
  it('ignores the exact directory-name set including .cache', () => {
    for (const name of ['.git', '__pycache__', '.autoreport', '.cache', 'target']) {
      expect(shouldIgnoreDir(name)).toBe(true)
    }
    expect(shouldIgnoreDir('Target')).toBe(false)
    expect(shouldIgnoreDir('.gitignore')).toBe(false)
  })

  it('ignores the exact file-name set and suffixes', () => {
    expect(shouldIgnoreFile('.DS_Store')).toBe(true)
    expect(shouldIgnoreFile('Thumbs.db')).toBe(true)
    expect(shouldIgnoreFile('notes~')).toBe(true)
    for (const suffix of [
      '.tmp', '.bak', '.swp', '.swo', '.aux', '.log', '.out', '.toc', '.lof',
      '.lot', '.fls', '.fdb_latexmk', '.synctex.gz', '.bbl', '.blg', '.bcf',
      '.dvi', '.ps', '.idx', '.ilg', '.ind', '.nav', '.snm', '.vrb',
    ]) {
      expect(shouldIgnoreFile(`main${suffix}`)).toBe(true)
    }
    expect(shouldIgnoreFile('main.tex')).toBe(false)
    expect(shouldIgnoreFile('catalog.outline')).toBe(false)
  })

  it('rejects paths with an ignored segment anywhere before the leaf', () => {
    expect(shouldIgnore('Outline/.cache/mineru/out.md')).toBe(true)
    expect(shouldIgnore('__pycache__/model.pkl')).toBe(true)
    expect(shouldIgnore('Plots/Fig/target/keep.txt')).toBe(true)
    expect(shouldIgnore('Report/main.aux')).toBe(true)
    expect(shouldIgnore('Report/main.tex')).toBe(false)
    expect(shouldIgnore('Data/Processed/result.csv')).toBe(false)
  })

  it('treats empty and malformed relative paths as ignored', () => {
    expect(shouldIgnore('')).toBe(true)
    expect(shouldIgnore('a/')).toBe(true)
  })
})

describe('snapshotDir traversal', () => {
  it('collects filtered workspace-relative POSIX paths sorted ascending', () => {
    file('Report/main.tex')
    file('Report/main.aux')
    file('Report/.DS_Store')
    file('Plots/Fig/fig1.png')
    file('Plots/__pycache__/cache.bin')
    file('Theory/derivation.md')
    file('target/stale.txt')
    file('Outline/.cache/mineru/out.md')

    const snapshot = snapshotPaths(root)
    expect(snapshot).toEqual([
      'Plots/Fig/fig1.png',
      'Report/main.tex',
      'Theory/derivation.md',
    ])
  })

  it('skips symlinks without following them in either direction', () => {
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    mkdirSync(join(outside, 'linked-dir'))
    writeFileSync(join(outside, 'linked-dir', 'nested.txt'), 'nested')

    symlinkSync(join(outside, 'secret.txt'), join(root, 'Theory', 'leak.txt'))
    symlinkSync(outside, join(root, 'Theory', 'linked'))

    const snapshot = snapshotPaths(root)
    expect(snapshot).not.toContain('Theory/leak.txt')
    expect(snapshot).not.toContain('Theory/linked/nested.txt')
    expect(snapshot).toEqual([
      'Plots/Fig/fig1.png',
      'Report/main.tex',
      'Theory/derivation.md',
    ])
  })

  it('stops at the depth bound (default matches manifest.rs MAX_DEPTH)', () => {
    expect(MAX_SCAN_DEPTH).toBe(16)
    let deep = root
    for (let level = 0; level <= MAX_SCAN_DEPTH + 2; level++) {
      deep = join(deep, `d${level}`)
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'leaf.txt'), 'x')
    }
    const snapshot = snapshotPaths(root)
    // depth counts recursions below the root: with MAX_DEPTH = 16 the walk
    // enters directories d0..d15 (16 levels), so d15/leaf.txt is collected and
    // d16/leaf.txt is not — matching manifest.rs's `if depth > MAX_DEPTH` gate.
    expect(snapshot).toContain('d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/d13/d14/d15/leaf.txt')
    expect(JSON.stringify(snapshot)).not.toContain('d16/leaf.txt')
  }, 30_000)

  it('honors the total-entry bound through overridable bounds', () => {
    const boundedRoot = mkdtempSync(join(tmpdir(), 'autoreport-bounded-'))
    for (let index = 0; index < 10; index++) {
      writeFileSync(join(boundedRoot, `f${index}.txt`), 'x')
    }
    const snapshot = snapshotDir(boundedRoot, { maxEntries: 5 })
    expect(snapshot.size).toBe(5)
    expect(MAX_SCAN_ENTRIES).toBe(50_000)
  })

  it('returns empty for missing or non-directory roots', () => {
    expect(snapshotDir(join(root, 'does-not-exist')).size).toBe(0)
    expect(snapshotDir(join(root, 'Report/main.tex')).size).toBe(0)
  })

  it('collects size and mtime metadata per file', () => {
    const rel = 'Report/main.tex'
    file(rel)
    const absolute = join(root, rel)
    const stats = statSync(absolute)
    const snapshot = snapshotDir(root)
    expect(snapshot.get(rel)).toEqual({ size: stats.size, mtimeMs: stats.mtimeMs })
  })

  it('diffSnapshots reports created, modified, unchanged, and ignores deletions', () => {
    const before = makeSnapshot({
      a: { size: 1, mtimeMs: 100 },
      b: { size: 2, mtimeMs: 200 },
      gone: { size: 9, mtimeMs: 900 },
    })
    const after = makeSnapshot({
      a: { size: 1, mtimeMs: 100 },
      b: { size: 3, mtimeMs: 200 },
      c: { size: 4, mtimeMs: 400 },
      d: { size: 5, mtimeMs: 500 },
    })
    expect(diffSnapshots(before, after)).toEqual([
      { path: 'b', kind: 'modified' },
      { path: 'c', kind: 'created' },
      { path: 'd', kind: 'created' },
    ])
    expect(diffSnapshots(makeSnapshot({ x: { size: 1, mtimeMs: 1 } }), makeSnapshot({ x: { size: 1, mtimeMs: 1 } }))).toEqual([])
    expect(diffSnapshots(makeSnapshot({}), makeSnapshot({ y: { size: 1, mtimeMs: 1 } }))).toEqual([
      { path: 'y', kind: 'created' },
    ])
    expect(diffSnapshots(before, makeSnapshot({ a: { size: 1, mtimeMs: 100 } }))).toEqual([])
  })

  it('diffSnapshots treats mtime-only changes as modified', () => {
    const before = makeSnapshot({ f: { size: 10, mtimeMs: 1000 } })
    const after = makeSnapshot({ f: { size: 10, mtimeMs: 2000 } })
    expect(diffSnapshots(before, after)).toEqual([{ path: 'f', kind: 'modified' }])
  })

  it('keys root-level files to "." in directoryOf', () => {
    expect(directoryOf('main.tex')).toBe('.')
    expect(directoryOf('Plots/Fig/fig1.png')).toBe('Plots/Fig')
  })
})
