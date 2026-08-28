import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderManifest, writeManifests, type ManifestWriter } from '../src/artifacts/manifest.js'
import type { ArtifactSnapshot } from '../src/workflow/events.js'

function artifact(path: string, overrides: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    version: 1,
    path,
    producedBy: 'REPORT',
    origin: 'process',
    status: 'created',
    recordedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function failingRenameWriter(): ManifestWriter & { renamed: { temp: string; target: string }[] } {
  const calls: { temp: string; target: string }[] = []
  return {
    renamed: calls,
    mkdirSync: (path) => mkdirSync(path, { recursive: true }),
    writeFileSync: (path, data) => writeFileSync(path, data),
    renameSync: (from, to) => {
      calls.push({ temp: from, target: to })
      throw new Error('rename exploded')
    },
    unlinkSync: path => {
      // Record which temps were cleaned so the test can assert atomic rollback.
      try {
        require('node:fs').unlinkSync(path)
      } catch {
        // The injected writer has no real file backing for this hook unless
        // the temp existed; cleanup attempts are best-effort by contract.
      }
      calls.push({ temp: path, target: '<cleanup>' })
    },
  }
}

describe('renderManifest', () => {
  it('groups snapshots per directory with root files keyed "."', () => {
    const rendered = renderManifest([
      artifact('Report/main.tex'),
      artifact('Plots/Fig/fig1.png', { producedBy: 'PLOTTING' }),
      artifact('Outline/plan.md', { producedBy: 'MAIN', origin: 'fs-tool' }),
      artifact('README.txt'),
    ])
    expect([...rendered.keys()].sort()).toEqual(['.', 'Outline', 'Plots/Fig', 'Report'])
    const report = JSON.parse(rendered.get('Report') ?? '{}')
    expect(report.directory).toBe('Report')
    expect(report.files).toHaveLength(1)
    expect(report.files[0]).toMatchObject({
      path: 'Report/main.tex',
      status: 'created',
      producedBy: 'REPORT',
      origin: 'process',
    })
  })

  it('keeps the latest snapshot per path and orders entries by path', () => {
    const rendered = renderManifest([
      artifact('Report/b.tex'),
      artifact('Report/a.tex', { status: 'modified' }),
      artifact('Report/a.tex'),
    ])
    const document = JSON.parse(rendered.get('Report') ?? '{}')
    expect(document.files.map((file: { path: string }) => file.path)).toEqual(['Report/a.tex', 'Report/b.tex'])
    expect(document.files[0].status).toBe('created')
  })

  it('emits valid JSON text ending in a newline', () => {
    const rendered = renderManifest([artifact('Data/Processed/result.csv')])
    const text = rendered.get('Data/Processed') ?? ''
    expect(text.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(text)).not.toThrow()
  })
})

describe('writeManifests', () => {
  it('writes <home>/autoreport/<id>/manifests/<dir>.json including nested dirs', () => {
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    writeManifests(home, 'ws-42', renderManifest([
      artifact('Report/main.pdf'),
      artifact('Plots/Fig/fig1.png'),
    ]))
    const base = join(home, 'autoreport', 'ws-42', 'manifests')
    const report = JSON.parse(readFileSync(join(base, 'Report', 'Report.json'), 'utf8'))
    expect(report.files[0].path).toBe('Report/main.pdf')
    const fig = JSON.parse(readFileSync(join(base, 'Plots', 'Fig', 'Plots_Fig.json'), 'utf8'))
    expect(fig.directory).toBe('Plots/Fig')
  })

  it('is idempotent across reruns', () => {
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    const manifests = renderManifest([artifact('Theory/note.md')])
    writeManifests(home, 'ws', manifests)
    writeManifests(home, 'ws', manifests)
    const text = readFileSync(join(home, 'autoreport/ws/manifests/Theory/Theory.json'), 'utf8')
    expect(JSON.parse(text).files).toHaveLength(1)
  })

  it('fails loud on traversal keys and never writes outside the manifest root', () => {
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    for (const bad of ['../evil', '/abs/path', 'a/../..']) {
      expect(() => writeManifests(home, 'ws', new Map([[bad, '{}']]))).toThrow()
    }
    expect(() => writeManifests(home, '../escape', renderManifest([]))).toThrow()
  })

  it('leaves no partial or temp files when rename fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    const writer = failingRenameWriter()
    expect(() => writeManifests(home, 'ws', renderManifest([artifact('Report/x.pdf')]), writer)).toThrow('rename exploded')
    const base = join(home, 'autoreport', 'ws', 'manifests', 'Report')
    expect(existsSync(join(base, 'Report.json'))).toBe(false)
    const leftovers = readdirSync(base).filter(name => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
    // The cleanup attempt ran against the failed temp.
    expect(writer.renamed.some(entry => entry.target === '<cleanup>')).toBe(true)
  })

  it('never writes inside an experiment workspace passed as cwd context', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autoreport-experiment-'))
    const home = mkdtempSync(join(tmpdir(), 'autoreport-home-'))
    writeManifests(home, basename(workspace), renderManifest([
      artifact('Report/main.pdf'),
    ]))
    // The projection only ever touches <home>; the workspace stays untouched
    // because no API here accepts it as a write destination.
    expect(readdirSync(workspace)).toEqual([])
    expect(existsSync(join(home, 'autoreport'))).toBe(true)
  })
})
