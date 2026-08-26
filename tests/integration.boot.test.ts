/**
 * Loader-level boot smoke (PLAN.md §3 keyless assembled smokes): run
 * `scripts/install-user-preset.ts` as the real CLI against a temporary
 * harness home with the BUILT dist, then verify the deployment contract —
 * preset materialized under `<home>/.agent-presets/autoreport-main` with
 * substituted persona text and absolute entry paths, and a rendered overlay
 * that disables the stock child-report row and inserts both AutoReport rows.
 *
 * The suite builds once when `dist/` is absent and skips with a reason only
 * if even the build attempt fails (e.g. no toolchain on a bare checkout).
 * @module tests/integration.boot
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..')
const HOST_ENTRY = join(REPO_ROOT, 'dist', 'src', 'host.js')
const ROUTER_ENTRY = join(REPO_ROOT, 'dist', 'src', 'tools', 'report-router.js')
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-user-preset.ts')
const OVERLAY_FILE = join(REPO_ROOT, 'cordis.overlay.generated.yml')

/**
 * Ensure built dist exists; try one bounded `pnpm run build` otherwise.
 * Returns undefined when ready, or the skip reason string.
 */
function ensureBuilt(): string | undefined {
  if (existsSync(HOST_ENTRY) && existsSync(ROUTER_ENTRY)) return undefined
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, CI: process.env['CI'] ?? 'true' },
  })
  if (build.status !== 0) {
    return `skipping: \`pnpm run build\` failed (${build.status}): ${(build.stderr ?? '').slice(-400)}`
  }
  if (!existsSync(HOST_ENTRY) || !existsSync(ROUTER_ENTRY)) {
    return 'skipping: build succeeded but dist entries are still missing'
  }
  return undefined
}

const skipReason = ensureBuilt()
if (skipReason !== undefined) console.warn(skipReason)

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(skipReason !== undefined)('integration: installer CLI against a temp DSH_HOME', () => {
  it('materializes the user preset and renders the two-row patch overlay', () => {
    expect(skipReason).toBeUndefined()
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
    expect(run.stdout).toContain(`preset installed at ${join(home, '.agent-presets', 'autoreport-main')}`)

    // Preset composition: persona substituted, absolute tool paths, no tokens.
    const composed = readFileSync(join(home, '.agent-presets', 'autoreport-main', 'agent.cordis.yml'), 'utf8')
    expect(composed).toContain('You coordinate automated physics experiment report writing')
    expect(composed).not.toMatch(/__AUTOREPORT_[A-Z_]+__/)
    expect(composed).toContain(join(REPO_ROOT, 'dist', 'src', 'preset.js'))

    // Overlay: stock child-report row disabled; BOTH replacement rows present
    // with absolute built-entry paths and no unresolved tokens.
    const overlay = readFileSync(OVERLAY_FILE, 'utf8')
    expect(overlay).toMatch(/- id: tool-subagent-report\s*\n\s+disabled: true/)
    expect(overlay).toContain('- id: autoreportdsh-host')
    expect(overlay).toContain(`name: '${HOST_ENTRY}'`)
    expect(overlay).toContain('- id: autoreportdsh-report-router')
    expect(overlay).toContain(`name: '${ROUTER_ENTRY}'`)
    expect(overlay).not.toMatch(/__AUTOREPORT_/)

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
