/**
 * Loader-level boot smoke (PLAN.md §3 keyless assembled smokes): run
 * `scripts/install-user-preset.ts` as the real CLI against a temporary
 * harness home with the BUILT dist, then verify the deployment contract —
 * preset materialized under `<home>/.agent-presets/autoreport` with
 * substituted persona text and absolute entry paths, and a rendered overlay
 * that disables the stock child-report row and inserts both AutoReport rows.
 *
 * Global setup builds once when `dist/` is absent, before any worker starts.
 * @module tests/integration.boot
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..')
const HOST_ENTRY = join(REPO_ROOT, 'dist', 'src', 'index.js')
const CLIENT_BUNDLE = join(REPO_ROOT, 'dist', 'client.js')
const ROUTER_ENTRY = join(REPO_ROOT, 'dist', 'src', 'tools', 'report-router.js')
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-user-preset.ts')
const OVERLAY_FILE = join(REPO_ROOT, 'cordis.overlay.generated.yml')

/**
 * Ensure global setup materialized dist; workers never build shared output.
 */
function ensureBuilt(): void {
  if (existsSync(HOST_ENTRY) && existsSync(ROUTER_ENTRY) && existsSync(CLIENT_BUNDLE)) return
  throw new Error('AutoReport test global setup did not build all required dist entries')
}

ensureBuilt()

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('integration: installer CLI against a temp DSH_HOME', () => {
  it('materializes the user preset and renders the two-row patch overlay', () => {
    const home = mkdtempSync(join(tmpdir(), 'autoreport-boot-home-'))
    tempDirs.push(home)

    // Run the REAL CLI through tsx exactly as `pnpm install:preset` would,
    // pointed at an isolated DSH home.
    const run = spawnSync(process.execPath, [
      '--import', 'tsx',
      INSTALLER,
      '--',
      '--home', home,
      '--repo-root', REPO_ROOT,
    ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 })
    expect(run.status, `installer failed: ${run.stderr}`).toBe(0)
    expect(run.stdout).toContain(`preset installed at ${join(home, '.agent-presets', 'autoreport')}`)

    // Preset composition: persona substituted, absolute tool paths, no tokens.
    const composed = readFileSync(join(home, '.agent-presets', 'autoreport', 'agent.cordis.yml'), 'utf8')
    expect(composed).toContain('Coordinate a physics experiment report from scope through completion.')
    expect(composed).not.toMatch(/__AUTOREPORT_[A-Z_]+__/)
    expect(composed).toContain(join(REPO_ROOT, 'dist', 'src', 'preset.js'))

    // Overlay: no stock child-report row (removed upstream); host row is the
    // package name so the client-module scan can resolve dsh.client; router
    // stays a path.
    const overlay = readFileSync(OVERLAY_FILE, 'utf8')
    expect(overlay).toContain('- id: autoreport-host')
    expect(overlay).toMatch(/name: dsh-autoreport\s*$/m)
    expect(overlay).not.toContain(HOST_ENTRY)
    expect(overlay).toContain('- id: autoreport-report-router')
    expect(overlay).toContain(`name: '${ROUTER_ENTRY}'`)
    expect(overlay).not.toMatch(/__AUTOREPORT_/)
    expect(existsSync(join(home, 'profiles', 'node_modules', 'dsh-autoreport'))).toBe(true)

    // Idempotent rerun stays green (deployment re-runs install freely).
    const rerun = spawnSync(process.execPath, [
      '--import', 'tsx',
      INSTALLER,
      '--',
      '--home', home,
      '--repo-root', REPO_ROOT,
    ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 })
    expect(rerun.status).toBe(0)
  })
})
