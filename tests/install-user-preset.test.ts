import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { install } from '../scripts/install-user-preset.js'

const tempDirs: string[] = []

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autoreportdsh-install-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const ROOT = resolveRepoRoot()

function resolveRepoRoot(): string {
  // tests/ sits directly under the repo root.
  return join(import.meta.dirname, '..')
}

describe('install-user-preset', () => {
  it('copies the preset into <home>/.agent-presets/autoreport-main and renders the overlay', () => {
    const home = makeTemp()
    const entry = join(ROOT, 'dist', 'src', 'index.js')
    const result = install({ home, repoRoot: ROOT, entry })

    expect(result.presetDir).toBe(join(home, '.agent-presets', 'autoreport-main'))
    const composed = readFileSync(join(result.presetDir, 'agent.cordis.yml'), 'utf8')
    expect(composed).toContain('PLACEHOLDER_MAIN_PERSONA')
    const overlay = readFileSync(result.overlayFile, 'utf8')
    expect(overlay).toContain(entry)
    expect(overlay).not.toContain('__AUTOREPORT_ENTRY__')
  })

  it('is idempotent: a rerun overwrites ours and keeps foreign files', () => {
    const home = makeTemp()
    const presetDir = join(home, '.agent-presets', 'autoreport-main')
    mkdirSync(presetDir, { recursive: true })
    const foreign = join(presetDir, 'user-notes.md')
    writeFileSync(foreign, 'keep me')

    install({ home, repoRoot: ROOT, entry: join(ROOT, 'dist', 'src', 'index.js') })
    // User edits our file between installs; the rerun restores it.
    writeFileSync(join(presetDir, 'agent.cordis.yml'), 'user edited this')
    install({ home, repoRoot: ROOT, entry: join(ROOT, 'dist', 'src', 'index.js') })

    expect(readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')).toContain('PLACEHOLDER_MAIN_PERSONA')
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('keep me')
  })

  it('fails loud when the built entry is missing', () => {
    const home = makeTemp()
    expect(() => install({ home, repoRoot: ROOT, entry: join(home, 'does-not-exist.js') })).toThrowError(/built plugin entry not found/)
  })

  it('fails loud when the preset composition is missing', () => {
    const home = makeTemp()
    const emptyRoot = makeTemp()
    expect(() => install({ home, repoRoot: emptyRoot, entry: join(ROOT, 'dist', 'src', 'index.js') })).toThrowError(/preset composition missing/)
  })
})
