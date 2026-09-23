import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_SCHEMA_VERSION,
  artifactMatchesDisk,
  latestArtifactsForRole,
  refreshArtifactsFromDisk,
} from '../src/artifacts/refresh.js'
import type { ArtifactSnapshot, WorkflowProjection } from '../src/workflow/events.js'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'artifact-refresh-'))
  roots.push(root)
  mkdirSync(join(root, 'Data/Processed'), { recursive: true })
  mkdirSync(join(root, 'Report'), { recursive: true })
  return root
}

function artifact(path: string, recordedAt: number, extra: Partial<ArtifactSnapshot> = {}): ArtifactSnapshot {
  return {
    version: ARTIFACT_SCHEMA_VERSION,
    path,
    producedBy: 'DATA_ANALYSIS',
    origin: 'fs-tool',
    status: 'created',
    recordedAt,
    ...extra,
  }
}

function projectionWith(artifacts: ArtifactSnapshot[]): WorkflowProjection {
  return {
    meta: undefined,
    tasks: new Map(),
    delegations: new Map(),
    bindingsByChild: new Map(),
    bindingsByRole: new Map(),
    artifacts,
    fileNotes: new Map(),
    roleNotes: new Map(),
  } as unknown as WorkflowProjection
}

describe('artifactMatchesDisk', () => {
  it('compares size and mtime when the baseline exists', () => {
    const base = { recordedAt: 1000, sizeBytes: 10, mtimeMs: 2000 }
    expect(artifactMatchesDisk(base, { sizeBytes: 10, mtimeMs: 2000 })).toBe(true)
    expect(artifactMatchesDisk(base, { sizeBytes: 11, mtimeMs: 2000 })).toBe(false)
    expect(artifactMatchesDisk(base, { sizeBytes: 10, mtimeMs: 3000 })).toBe(false)
  })

  it('falls back to recordedAt comparison for legacy snapshots without a baseline', () => {
    const legacy = { recordedAt: 1000 }
    expect(artifactMatchesDisk(legacy, { sizeBytes: 10, mtimeMs: 1000 })).toBe(true)
    expect(artifactMatchesDisk(legacy, { sizeBytes: 10, mtimeMs: 1001 })).toBe(false)
  })

  it('treats a missing file as unchanged (deletions are not refreshed here)', () => {
    expect(artifactMatchesDisk({ recordedAt: 1000 }, undefined)).toBe(true)
  })
})

describe('refreshArtifactsFromDisk', () => {
  it('commits a modified snapshot for an externally edited tracked file', () => {
    const root = workspace()
    const file = join(root, 'Data/Processed/result.csv')
    writeFileSync(file, 'v1')
    const stats = statSync(file)
    const artifacts = [artifact('Data/Processed/result.csv', stats.mtimeMs, { sizeBytes: stats.size, mtimeMs: stats.mtimeMs })]
    // Simulate an external edit after the artifact was recorded.
    utimesSync(file, new Date(stats.mtimeMs + 5000), new Date(stats.mtimeMs + 5000))
    writeFileSync(file, 'v2-longer-content')

    const committed: ArtifactSnapshot[] = []
    refreshArtifactsFromDisk(projectionWith(artifacts), 'DATA_ANALYSIS', root, 9_999, s => committed.push(s))
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({
      path: 'Data/Processed/result.csv',
      producedBy: 'DATA_ANALYSIS',
      status: 'modified',
      recordedAt: 9_999,
    })
    expect(committed[0].sizeBytes).toBe(statSync(file).size)
    expect(committed[0].mtimeMs).toBe(statSync(file).mtimeMs)
  })

  it('commits nothing when tracked files match their baselines', () => {
    const root = workspace()
    const file = join(root, 'Data/Processed/stable.csv')
    writeFileSync(file, 'same')
    const stats = statSync(file)
    const artifacts = [artifact('Data/Processed/stable.csv', stats.mtimeMs, { sizeBytes: stats.size, mtimeMs: stats.mtimeMs })]
    const committed: ArtifactSnapshot[] = []
    refreshArtifactsFromDisk(projectionWith(artifacts), 'DATA_ANALYSIS', root, 9_999, s => committed.push(s))
    expect(committed).toHaveLength(0)
  })

  it('detects external edits of legacy baseline-less artifacts via mtime', () => {
    const root = workspace()
    const file = join(root, 'Data/Processed/legacy.csv')
    writeFileSync(file, 'x')
    // Legacy artifact recorded BEFORE the file was touched.
    const artifacts = [artifact('Data/Processed/legacy.csv', 1)]
    const committed: ArtifactSnapshot[] = []
    refreshArtifactsFromDisk(projectionWith(artifacts), 'DATA_ANALYSIS', root, 9_999, s => committed.push(s))
    expect(committed).toHaveLength(1)
    // And the refreshed snapshot now carries a full baseline.
    expect(committed[0].sizeBytes).toBeDefined()
    expect(committed[0].mtimeMs).toBeDefined()
  })

  it('leaves deleted files and ignored paths alone', () => {
    const root = workspace()
    const artifacts = [
      artifact('Data/Processed/gone.csv', 1),
      artifact('Report/main.log', 1),
      artifact('Data/Processed/.cache/thing.csv', 1),
    ]
    const committed: ArtifactSnapshot[] = []
    refreshArtifactsFromDisk(projectionWith(artifacts), 'DATA_ANALYSIS', root, 9_999, s => committed.push(s))
    expect(committed).toHaveLength(0)
  })

  it('only refreshes the requested role and uses the latest artifact per path', () => {
    const root = workspace()
    const file = join(root, 'Data/Processed/two.csv')
    writeFileSync(file, 'edited externally')
    const other = join(root, 'Report/main.tex')
    writeFileSync(other, 'edited by report')
    const artifacts = [
      artifact('Data/Processed/two.csv', 1, { producedBy: 'DATA_ANALYSIS' }),
      artifact('Data/Processed/two.csv', 5_000, { producedBy: 'DATA_ANALYSIS' }),
      artifact('Report/main.tex', 1, { producedBy: 'REPORT' }),
    ]
    const committed: ArtifactSnapshot[] = []
    refreshArtifactsFromDisk(projectionWith(artifacts), 'DATA_ANALYSIS', root, 9_999, s => committed.push(s))
    expect(committed).toHaveLength(1)
    expect(committed[0].path).toBe('Data/Processed/two.csv')
  })
})

describe('latestArtifactsForRole', () => {
  it('keeps the last-write-wins artifact per path', () => {
    const projection = projectionWith([
      artifact('a.csv', 1),
      artifact('a.csv', 9),
      artifact('b.csv', 2),
    ])
    const latest = latestArtifactsForRole(projection, 'DATA_ANALYSIS')
    expect(latest.get('a.csv')?.recordedAt).toBe(9)
    expect(latest.size).toBe(2)
  })
})
