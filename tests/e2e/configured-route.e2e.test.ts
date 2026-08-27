/**
 * Opt-in live deployment smoke.
 *
 * It boots the source DeepSeek Harness against a user-selected, already
 * configured DSH home and loads the AutoReport overlay. The test deliberately
 * does NOT declare a provider, endpoint, credential, or model: DSH resolves
 * its current default route exactly as the user's normal profile does.
 *
 * Set both variables to run:
 *   AUTOREPORT_LIVE_TEST=1
 *   AUTOREPORT_E2E_DSH_HOME=/path/to/a/configured/dsh-home
 *
 * @module tests/e2e/configured-route
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const HOST_ENTRY = join(REPO_ROOT, 'dist', 'src', 'host.js')
const ROUTER_ENTRY = join(REPO_ROOT, 'dist', 'src', 'tools', 'report-router.js')
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-user-preset.ts')
const TEST_TIMEOUT_MS = 125_000
const PROCESS_TIMEOUT_MS = 110_000

/** Locate the local source Harness through development link dependencies. */
function findHarnessRoot(): string | undefined {
  try {
    let current = realpathSync(join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session'))
    while (dirname(current) !== current) {
      if (existsSync(join(current, 'tsconfig.json')) && existsSync(join(current, 'pnpm-workspace.yaml'))) return current
      current = dirname(current)
    }
  } catch {
    // A missing local harness is an ordinary source-install precondition.
  }
  return undefined
}

/** Build once when an opt-in test is invoked before a local package build. */
function ensureBuilt(): string | undefined {
  if (existsSync(HOST_ENTRY) && existsSync(ROUTER_ENTRY)) return undefined
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, CI: process.env.CI ?? 'true' },
  })
  return existsSync(HOST_ENTRY) && existsSync(ROUTER_ENTRY)
    ? undefined
    : `built overlay entries unavailable (build status ${String(build.status)})`
}

/** Explicit opt-in avoids consuming a configured provider route during normal tests. */
function skipReason(): string | undefined {
  if (process.env.AUTOREPORT_LIVE_TEST !== '1') return 'AUTOREPORT_LIVE_TEST=1 is not set'
  const home = process.env.AUTOREPORT_E2E_DSH_HOME
  if (home === undefined || home.trim() === '') return 'AUTOREPORT_E2E_DSH_HOME is not set'
  if (!existsSync(home)) return `configured DSH home does not exist: ${home}`
  const harness = findHarnessRoot()
  if (harness === undefined) return 'local deepseek-harness checkout is not resolvable through link dependencies'
  if (!existsSync(join(harness, 'apps', 'cli', 'src', 'bin.ts'))) return 'local Harness CLI source is unavailable'
  try {
    createRequire(join(harness, 'package.json')).resolve('tsx/esm')
  } catch {
    return 'tsx/esm is not resolvable from the local Harness checkout'
  }
  return ensureBuilt()
}

const reason = skipReason()
if (reason !== undefined) console.warn(`configured-route e2e ${reason}`)

describe.skipIf(reason !== undefined)('integration: configured DSH route with AutoReport overlay', () => {
  it('uses the deployment default model route and receives one assistant response', () => {
    expect(reason).toBeUndefined()
    const harnessRoot = findHarnessRoot()!
    const dshHome = process.env.AUTOREPORT_E2E_DSH_HOME!
    const profile = process.env.AUTOREPORT_E2E_PROFILE ?? 'headless'
    const workspace = mkdtempSync(join(tmpdir(), 'autoreport-live-workspace-'))
    const tsxLoader = createRequire(join(harnessRoot, 'package.json')).resolve('tsx/esm')
    try {
      // Materialize only this package's user preset in the explicitly chosen
      // DSH home. The installer is idempotent and does not alter profile routes
      // or credentials.
      const install = spawnSync(process.execPath, [
        '--import', createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx'),
        INSTALLER,
        '--home', dshHome,
        '--repo-root', REPO_ROOT,
      ], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DSH_HOME: dshHome },
      })
      expect(install.status, `preset installer failed:\n${install.stderr}`).toBe(0)

      const run = spawnSync(process.execPath, [
        '--import', tsxLoader,
        join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts'),
        '--profile', profile,
        '--patch', join(REPO_ROOT, 'cordis.overlay.generated.yml'),
        'Reply with exactly: ACK',
      ], {
        // The ordinary headless profile resolves its configured default route;
        // this workspace only supplies the agent cwd for the turn.
        cwd: workspace,
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          TSX_TSCONFIG_PATH: join(harnessRoot, 'tsconfig.json'),
        },
      })

      const diagnostic = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`
      expect(run.error, diagnostic).toBeUndefined()
      expect(run.status, diagnostic).toBe(0)
      expect(run.stdout.trim(), diagnostic).not.toBe('')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)
})
