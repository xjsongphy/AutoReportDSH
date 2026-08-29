import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  syncManagedResources,
  MANAGED_RESOURCES,
  TYPST_SKILL_REFS,
  type ManagedResource,
} from '../src/workspace/resource-sync.js'

const resource = (
  id: string,
  remotePath: string,
  destination: string,
  rest: Partial<ManagedResource> = {},
): ManagedResource => ({
  id,
  owner: 'example',
  repository: 'skills',
  remotePath,
  destination,
  kind: 'skill',
  ...rest,
})

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempOverlay(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-resource-sync-'))
  tempDirs.push(root)
  return root
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function upstream(blobs: Record<string, string>, bodies: Record<string, string>) {
  const calls: string[] = []
  const fetchFn: typeof fetch = async input => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/commits/HEAD')) return response({ sha: 'commit-2', commit: { tree: { sha: 'tree-2' } } })
    if (url.includes('/git/trees/tree-2?recursive=1')) {
      return response({ tree: Object.entries(blobs).map(([path, sha]) => ({ path, sha, type: 'blob' })) })
    }
    const remotePath = Object.keys(bodies).find(path => url.endsWith(`/${path}`))
    return remotePath === undefined ? response('missing', 404) : response(bodies[remotePath])
  }
  return { calls, fetchFn }
}

const skill = (name: string) => `---\nname: ${name}\ndescription: synced ${name}\n---\n\n# ${name}\n`

describe('incremental external resource sync', () => {
  it('syncs AutoReportCLI remotes that still exist, not cc-switch or the reorganized writer', () => {
    expect(MANAGED_RESOURCES.some(entry => entry.repository === 'cc-switch')).toBe(false)
    expect(MANAGED_RESOURCES.some(entry => entry.remotePath.includes('writer'))).toBe(false)
    expect(MANAGED_RESOURCES.some(entry => entry.remotePath.includes('experiment-report-writer'))).toBe(false)
    expect(MANAGED_RESOURCES.every(entry => !entry.destination.startsWith('resources/'))).toBe(true)
    expect(MANAGED_RESOURCES.some(entry => entry.id === 'skills-latex-compile')).toBe(true)
    expect(MANAGED_RESOURCES.some(entry => entry.id === 'pkumpl-mplts')).toBe(true)
    expect(MANAGED_RESOURCES.some(entry => entry.id === 'typst-skill')).toBe(true)
    expect([...TYPST_SKILL_REFS]).toEqual(['basics.md', 'styling.md', 'tables.md', 'academic.md'])
  })

  it('returns an empty outcome list when no managed resources are configured', async () => {
    const overlayRoot = tempOverlay()
    await expect(syncManagedResources({ overlayRoot, resources: [], fetchFn: async () => response('') }))
      .resolves.toEqual([])
  })

  it('downloads every managed file on its first sync and records commit/blob state', async () => {
    const overlayRoot = tempOverlay()
    const a = resource('alpha-skill', 'alpha/SKILL.md', 'skills/alpha.md')
    const b = resource('beta-skill', 'beta/SKILL.md', 'skills/beta.md')
    const remote = upstream({ [a.remotePath]: 'blob-a1', [b.remotePath]: 'blob-b1' }, {
      [a.remotePath]: skill('alpha'), [b.remotePath]: skill('beta'),
    })

    await expect(syncManagedResources({ overlayRoot, resources: [a, b], fetchFn: remote.fetchFn, now: () => new Date('2026-01-02T03:04:05Z') }))
      .resolves.toMatchObject([{ id: 'alpha-skill', status: 'updated' }, { id: 'beta-skill', status: 'updated' }])

    expect(readFileSync(join(overlayRoot, 'skills/alpha.md'), 'utf8')).toBe(skill('alpha'))
    const state = JSON.parse(readFileSync(join(overlayRoot, '.sync-state.json'), 'utf8'))
    expect(state.resources['alpha-skill']).toMatchObject({ commit: 'commit-2', blob: 'blob-a1' })
    expect(state.resources['beta-skill']).toMatchObject({ commit: 'commit-2', blob: 'blob-b1' })
  })

  it('checks the remote tree but downloads only files whose blob changed', async () => {
    const overlayRoot = tempOverlay()
    await mkdir(join(overlayRoot, 'skills'), { recursive: true })
    const a = resource('alpha-skill', 'alpha/SKILL.md', 'skills/alpha.md')
    const b = resource('beta-skill', 'beta/SKILL.md', 'skills/beta.md')
    writeFileSync(join(overlayRoot, 'skills/alpha.md'), skill('alpha'))
    writeFileSync(join(overlayRoot, 'skills/beta.md'), skill('beta'))
    writeFileSync(join(overlayRoot, '.sync-state.json'), JSON.stringify({
      schemaVersion: 1,
      resources: {
        'alpha-skill': { commit: 'commit-1', blob: 'blob-a1', remotePath: a.remotePath, destination: a.destination, syncedAt: 'old' },
        'beta-skill': { commit: 'commit-1', blob: 'blob-b1', remotePath: b.remotePath, destination: b.destination, syncedAt: 'old' },
      },
    }))
    const remote = upstream({ [a.remotePath]: 'blob-a2', [b.remotePath]: 'blob-b1' }, {
      [a.remotePath]: skill('alpha'), [b.remotePath]: skill('beta'),
    })

    const outcome = await syncManagedResources({ overlayRoot, resources: [a, b], fetchFn: remote.fetchFn })
    expect(outcome.map(entry => entry.status)).toEqual(['updated', 'unchanged'])
    expect(remote.calls.filter(url => url.startsWith('https://raw.githubusercontent.com/'))).toEqual([
      expect.stringContaining('/alpha/SKILL.md'),
    ])
    const state = JSON.parse(readFileSync(join(overlayRoot, '.sync-state.json'), 'utf8'))
    expect(state.resources['alpha-skill'].blob).toBe('blob-a2')
    expect(state.resources['beta-skill'].blob).toBe('blob-b1')
    const stateAfterDelta = readFileSync(join(overlayRoot, '.sync-state.json'), 'utf8')
    await syncManagedResources({ overlayRoot, resources: [a, b], fetchFn: remote.fetchFn, now: () => new Date('2027-01-01T00:00:00Z') })
    expect(readFileSync(join(overlayRoot, '.sync-state.json'), 'utf8')).toBe(stateAfterDelta)
  })

  it('keeps the local copy when the remote path disappeared', async () => {
    const overlayRoot = tempOverlay()
    await mkdir(join(overlayRoot, 'skills'), { recursive: true })
    const a = resource('gone-skill', 'gone/SKILL.md', 'skills/gone.md')
    writeFileSync(join(overlayRoot, 'skills/gone.md'), skill('gone'))
    const remote = upstream({}, {})
    const outcome = await syncManagedResources({ overlayRoot, resources: [a], fetchFn: remote.fetchFn })
    expect(outcome).toMatchObject([{ id: 'gone-skill', status: 'missing' }])
    expect(readFileSync(join(overlayRoot, 'skills/gone.md'), 'utf8')).toBe(skill('gone'))
    expect(remote.calls.some(url => url.startsWith('https://raw.githubusercontent.com/'))).toBe(false)
  })

  it('writes non-skill assets without SKILL.md frontmatter', async () => {
    const overlayRoot = tempOverlay()
    const theme = resource('theme', 'mplts.typ', 'typst/themes/mplts.typ', { kind: 'asset' })
    const remote = upstream({ [theme.remotePath]: 'blob-t1' }, { [theme.remotePath]: '// theme\n' })
    await expect(syncManagedResources({ overlayRoot, resources: [theme], fetchFn: remote.fetchFn }))
      .resolves.toMatchObject([{ id: 'theme', status: 'updated' }])
    expect(readFileSync(join(overlayRoot, 'typst/themes/mplts.typ'), 'utf8')).toBe('// theme\n')
  })

  it('keeps overlay copies when the tree fetch fails', async () => {
    const overlayRoot = tempOverlay()
    await mkdir(join(overlayRoot, 'skills'), { recursive: true })
    const a = resource('alpha-skill', 'alpha/SKILL.md', 'skills/alpha.md')
    writeFileSync(join(overlayRoot, 'skills/alpha.md'), skill('alpha'))
    const fetchFn: typeof fetch = async () => response('down', 503)
    const outcome = await syncManagedResources({ overlayRoot, resources: [a], fetchFn })
    expect(outcome).toMatchObject([{ id: 'alpha-skill', status: 'failed' }])
    expect(readFileSync(join(overlayRoot, 'skills/alpha.md'), 'utf8')).toBe(skill('alpha'))
  })
})
