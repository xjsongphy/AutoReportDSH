import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureInitialized, ensureWorkspaceDirs, REQUIRED_DIRS, resourcesRoot, materializeResources, switchReportLanguage, workspaceIsComplete } from '../src/workspace/init.js'

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
  it('reports completeness from directories only', () => {
    const root = tempRoot()
    expect(workspaceIsComplete(root)).toBe(false)
    ensureWorkspaceDirs(root)
    expect(workspaceIsComplete(root)).toBe(true)
  })

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

  it('writes every bundled typst resource into Report/ for a fresh offline workspace', () => {
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

describe('switchReportLanguage', () => {
  function workspaceWith(language: 'latex' | 'typst'): string {
    const root = tempRoot()
    ensureInitialized(root, language)
    return root
  }

  it('deletes the unmodified source template and installs the target set', () => {
    const root = workspaceWith('latex')
    const result = switchReportLanguage(root, 'latex', 'typst')
    expect(result.deleted).toEqual(['Report/main.tex', 'Report/mpltx.cls'])
    expect(result.written).toEqual([
      'Report/main.typ', 'Report/mplts.typ', 'Report/american-physics-society.csl', 'Report/bibli.bib',
    ])
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(false)
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('keeps a modified source template and still installs the target set', () => {
    const root = workspaceWith('latex')
    writeFileSync(join(root, 'Report/main.tex'), '% my own report\n')
    const result = switchReportLanguage(root, 'latex', 'typst')
    expect(result.deleted).toEqual(['Report/mpltx.cls'])
    expect(result.kept).toContain('Report/main.tex')
    expect(readFileSync(join(root, 'Report/main.tex'), 'utf8')).toBe('% my own report\n')
    expect(existsSync(join(root, 'Report/main.typ'))).toBe(true)
  })

  it('never overwrites an existing target template', () => {
    const root = workspaceWith('latex')
    switchReportLanguage(root, 'latex', 'typst')
    writeFileSync(join(root, 'Report/main.typ'), '// mine\n')
    const back = switchReportLanguage(root, 'typst', 'latex')
    expect(back.kept).toContain('Report/main.typ')
    expect(readFileSync(join(root, 'Report/main.typ'), 'utf8')).toBe('// mine\n')
    expect(existsSync(join(root, 'Report/main.tex'))).toBe(true)
  })

  it('leaves non-template files alone and writes nothing on a second pass', () => {
    const root = workspaceWith('latex')
    writeFileSync(join(root, 'Report/custom.typ'), 'not a template\n')
    switchReportLanguage(root, 'latex', 'typst')
    const again = switchReportLanguage(root, 'latex', 'typst')
    expect(again.deleted).toEqual([])
    expect(again.written).toEqual([])
    expect(again.kept).toEqual([
      'Report/main.typ', 'Report/mplts.typ', 'Report/american-physics-society.csl', 'Report/bibli.bib',
    ])
    expect(readFileSync(join(root, 'Report/custom.typ'), 'utf8')).toBe('not a template\n')
  })

  it('skips a workspace directory that no longer exists', () => {
    expect(switchReportLanguage('/nonexistent/autoreport-workspace', 'latex', 'typst'))
      .toEqual({ deleted: [], written: [], kept: [] })
  })
})

describe('resourcesRoot', () => {
  it('resolves to a directory containing the bundled assets', () => {
    const root = resourcesRoot()
    expect(existsSync(join(root, 'latex/templates/main.tex'))).toBe(true)
    expect(existsSync(join(root, 'skills/experiment-report-writer/SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'typst/themes/mplts.typ'))).toBe(true)
  })
})
