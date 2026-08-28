import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncManagedResources, type ManagedResource } from '../scripts/sync-resources.js'

const resource = (id: string, remotePath: string, destination: string): ManagedResource => ({
  id,
  owner: 'example',
  repository: 'skills',
  remotePath,
  destination,
})

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
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
  it('returns an empty outcome list when no managed resources are configured', async () => {
    const root = tempRoot()
    await mkdir(join(root, 'resources'), { recursive: true })
    await expect(syncManagedResources({ root, resources: [], fetchFn: async () => response('') }))
      .resolves.toEqual([])
  })

  it('downloads every managed file on its first sync and records commit/blob state', async () => {
    const root = tempRoot()
    await mkdir(join(root, 'resources'), { recursive: true })
    const a = resource('alpha-skill', 'alpha/SKILL.md', 'resources/skills/alpha.md')
    const b = resource('beta-skill', 'beta/SKILL.md', 'resources/skills/beta.md')
    const remote = upstream({ [a.remotePath]: 'blob-a1', [b.remotePath]: 'blob-b1' }, {
      [a.remotePath]: skill('alpha'), [b.remotePath]: skill('beta'),
    })

    await expect(syncManagedResources({ root, resources: [a, b], fetchFn: remote.fetchFn, now: () => new Date('2026-01-02T03:04:05Z') }))
      .resolves.toMatchObject([{ id: 'alpha-skill', status: 'updated' }, { id: 'beta-skill', status: 'updated' }])

    expect(readFileSync(join(root, 'resources/skills/alpha.md'), 'utf8')).toBe(skill('alpha'))
    const state = JSON.parse(readFileSync(join(root, 'resources/.sync-state.json'), 'utf8'))
    expect(state.resources['alpha-skill']).toMatchObject({ commit: 'commit-2', blob: 'blob-a1' })
    expect(state.resources['beta-skill']).toMatchObject({ commit: 'commit-2', blob: 'blob-b1' })
  })

  it('checks the remote tree but downloads only files whose blob changed', async () => {
    const root = tempRoot()
    await mkdir(join(root, 'resources/skills'), { recursive: true })
    const a = resource('alpha-skill', 'alpha/SKILL.md', 'resources/skills/alpha.md')
    const b = resource('beta-skill', 'beta/SKILL.md', 'resources/skills/beta.md')
    writeFileSync(join(root, 'resources/skills/alpha.md'), skill('alpha'))
    writeFileSync(join(root, 'resources/skills/beta.md'), skill('beta'))
    writeFileSync(join(root, 'resources/.sync-state.json'), JSON.stringify({
      schemaVersion: 1,
      resources: {
        'alpha-skill': { commit: 'commit-1', blob: 'blob-a1', remotePath: a.remotePath, destination: a.destination, syncedAt: 'old' },
        'beta-skill': { commit: 'commit-1', blob: 'blob-b1', remotePath: b.remotePath, destination: b.destination, syncedAt: 'old' },
      },
    }))
    const remote = upstream({ [a.remotePath]: 'blob-a2', [b.remotePath]: 'blob-b1' }, {
      [a.remotePath]: skill('alpha'), [b.remotePath]: skill('beta'),
    })

    const outcome = await syncManagedResources({ root, resources: [a, b], fetchFn: remote.fetchFn })
    expect(outcome.map(entry => entry.status)).toEqual(['updated', 'unchanged'])
    expect(remote.calls.filter(url => url.startsWith('https://raw.githubusercontent.com/'))).toEqual([
      expect.stringContaining('/alpha/SKILL.md'),
    ])
    const state = JSON.parse(readFileSync(join(root, 'resources/.sync-state.json'), 'utf8'))
    expect(state.resources['alpha-skill'].blob).toBe('blob-a2')
    expect(state.resources['beta-skill'].blob).toBe('blob-b1')
    const stateAfterDelta = readFileSync(join(root, 'resources/.sync-state.json'), 'utf8')
    await syncManagedResources({ root, resources: [a, b], fetchFn: remote.fetchFn, now: () => new Date('2027-01-01T00:00:00Z') })
    // A repeat against the exact same remote state is a pure check: neither
    // managed content nor its state manifest is rewritten.
    expect(readFileSync(join(root, 'resources/.sync-state.json'), 'utf8')).toBe(stateAfterDelta)
  })
})
