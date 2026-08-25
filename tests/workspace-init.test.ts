import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureInitialized, ensureWorkspaceDirs, REQUIRED_DIRS, resourcesRoot, materializeResources } from '../src/workspace/init.js'

const cleanup: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-workspace-'))
  cleanup.push(root)
  return root
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

describe('REQUIRED_DIRS', () => {
  it('matches the AutoReportCLI loader layout including Data/Processed', () => {
    expect(REQUIRED_DIRS).toEqual([
      'Data',
      'Data/Processed',
      'References',
      'Theory',
      'Plots',
      'Plots/Fig',
      'Plots/Scripts',
      'Report',
      'Outline',
    ])
  })
})

describe('ensureWorkspaceDirs', () => {
  it('creates every required directory in a fresh root', () => {
    const root = tempRoot()
    const created = ensureWorkspaceDirs(root)
    expect(created).toEqual([...REQUIRED_DIRS])
    for (const dir of REQUIRED_DIRS) expect(existsSync(join(root, dir))).toBe(true)
  })

  it('is idempotent: a second pass creates nothing', () => {
    const root = tempRoot()
    ensureWorkspaceDirs(root)
    expect(ensureWorkspaceDirs(root)).toEqual([])
  })
})

describe('materializeResources', () => {
  it('writes every latex resource into Report/ for a fresh workspace', () => {
    const root = tempRoot()
    const { written, skipped } = materializeResources(root, 'latex')
    expect(written.sort()).toEqual(['Report/main.tex', 'Report/mpltx.cls'])
    expect(skipped).toEqual([])
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toContain('\\documentclass')
    expect(readFileSync(join(root, 'Report/mpltx.cls'), 'utf8')).toContain('ProvidesClass')
  })

  it('writes every typst resource into Report/ for a fresh workspace', () => {
    const root = tempRoot()
    const { written, skipped } = materializeResources(root, 'typst')
    expect(written.sort()).toEqual([
      'Report/american-physics-society.csl',
      'Report/bibli.bib',
      'Report/main.typ',
      'Report/mplts.typ',
    ])
    expect(skipped).toEqual([])
    expect(readFileSync(join(root, 'Report/main.typ'), 'utf8')).toContain('#import "mplts.typ": *')
  })

  it('never overwrites an existing user file', () => {
    const root = tempRoot()
    ensureWorkspaceDirs(root)
    writeFileSync(join(root, 'Report/main.tex'), '% user content sentinel')
    const { written, skipped } = materializeResources(root, 'latex')
    expect(skipped).toEqual(['Report/main.tex'])
    expect(written).toEqual(['Report/mpltx.cls'])
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toBe('% user content sentinel')
  })
})

describe('ensureInitialized', () => {
  it('composes directories and resources into one manifest on a fresh root', () => {
    const root = tempRoot()
    const result = ensureInitialized(root, 'latex')
    expect(result.createdDirs.length).toBe(REQUIRED_DIRS.length)
    expect(result.writtenFiles.sort()).toEqual(['Report/main.tex', 'Report/mpltx.cls'])
    expect(result.skippedFiles).toEqual([])
  })

  it('converges to a no-op with only skips after the first pass', () => {
    const root = tempRoot()
    ensureInitialized(root, 'typst')
    const second = ensureInitialized(root, 'typst')
    expect(second.createdDirs).toEqual([])
    expect(second.writtenFiles).toEqual([])
    expect(second.skippedFiles.sort().length).toBeGreaterThan(0)
  })
})

describe('resourcesRoot', () => {
  it('resolves to a directory containing the bundled assets', () => {
    const root = resourcesRoot()
    expect(existsSync(join(root, 'latex/templates/main.tex'))).toBe(true)
    expect(existsSync(join(root, 'typst/themes/mplts.typ'))).toBe(true)
    expect(existsSync(join(root, 'skills/experiment-report-writer.md'))).toBe(true)
  })
})
