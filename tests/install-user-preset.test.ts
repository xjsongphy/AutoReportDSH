import { spawnSync } from 'node:child_process'
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

function builtEntry(): string {
  return join(ROOT, 'dist', 'src', 'index.js')
}

function ensureBuilt(): void {
  if (existsSync(builtEntry())) return
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (build.status !== 0 || !existsSync(builtEntry())) {
    throw new Error(`autoreportdsh test: pnpm run build failed (${build.status}): ${(build.stderr ?? '').slice(-400)}`)
  }
}

describe('install-user-preset', () => {
  it('copies the preset, substitutes persona and tool paths, and renders the overlay', () => {
    ensureBuilt()
    const home = makeTemp()
    const entry = builtEntry()
    const result = install({ home, repoRoot: ROOT, entry })

    expect(result.presetDir).toBe(join(home, '.agent-presets', 'autoreport-main'))
    const composed = readFileSync(join(result.presetDir, 'agent.cordis.yml'), 'utf8')
    expect(composed).toContain('You coordinate automated physics experiment report writing')
    expect(composed).not.toContain('__AUTOREPORT_MAIN_PERSONA__')
    expect(composed).not.toContain('PLACEHOLDER_MAIN_PERSONA')
    expect(composed).toContain(join(ROOT, 'dist', 'src', 'preset.js'))
    expect(composed).not.toContain('__AUTOREPORT_PRESET__')
    expect(composed).not.toContain('__AUTOREPORT_SEND_TO_AGENT__')
    expect(composed).not.toContain('tool-subagent')
    expect(composed).toContain('dsh-tool-bash')
    expect(composed).not.toContain('dsh-tool-fs-search')
    expect(composed).not.toContain('dsh-tool-ralph')
    expect(composed).not.toContain('dsh-tool-workflow')
    expect(composed).not.toContain('dsh-tool-web')
    expect(composed).not.toContain('dsh-tool-todo')

    const overlay = readFileSync(result.overlayFile, 'utf8')
    expect(overlay).toContain('name: autoreportdsh')
    expect(overlay).not.toContain(entry)
    expect(overlay).toContain(join(ROOT, 'dist', 'src', 'tools', 'report-router.js'))
    expect(overlay).toContain('tool-subagent-report')
    expect(overlay).toContain('disabled: true')
    expect(overlay).not.toContain('__AUTOREPORT_ENTRY__')
    expect(overlay).not.toContain('__AUTOREPORT_REPORT_ROUTER__')
    expect(result.packageLink).toBe(join(home, 'profiles', 'node_modules', 'autoreportdsh'))
    expect(existsSync(result.packageLink)).toBe(true)
  })

  it('is idempotent: a rerun overwrites ours and keeps foreign files', () => {
    ensureBuilt()
    const home = makeTemp()
    const presetDir = join(home, '.agent-presets', 'autoreport-main')
    mkdirSync(presetDir, { recursive: true })
    const foreign = join(presetDir, 'user-notes.md')
    writeFileSync(foreign, 'keep me')

    install({ home, repoRoot: ROOT, entry: builtEntry() })
    writeFileSync(join(presetDir, 'agent.cordis.yml'), 'user edited this')
    install({ home, repoRoot: ROOT, entry: builtEntry() })

    expect(readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')).toContain('You coordinate automated physics experiment report writing')
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('keep me')
  })

  it('fails loud when the built entry is missing', () => {
    const home = makeTemp()
    expect(() => install({ home, repoRoot: ROOT, entry: join(home, 'does-not-exist.js') })).toThrowError(/built plugin entry not found/)
  })

  it('fails loud when the preset composition is missing', () => {
    const home = makeTemp()
    const dummyEntry = join(home, 'fake-entry.js')
    writeFileSync(dummyEntry, '')
    const emptyRoot = makeTemp()
    expect(() => install({ home, repoRoot: emptyRoot, entry: dummyEntry })).toThrowError(/preset composition missing/)
  })
})
