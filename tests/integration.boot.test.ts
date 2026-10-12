/** Exercise the real source-overlay CLI against an isolated Harness home. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
const root = join(import.meta.dirname, '..')
it('renders a RC2 bundle preset through the installer CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'autoreport-boot-'))
  try {
    const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/install-user-preset.ts'), '--home', home, '--repo-root', root], { cwd: root, encoding: 'utf8', timeout: 120_000 })
    expect(run.status, run.stderr).toBe(0)
    const result = JSON.parse(run.stdout)
    const patch = readFileSync(result.overlayFile, 'utf8')
    expect(patch).toContain('@deepseek-ai/dsh-agent-preset')
    expect(patch).toContain('name: dsh-autoreport')
    expect(patch).toContain(join(root, 'dist/src/tools/report-router.js'))
    expect(patch).toContain(join(root, 'dist/src/preset.js'))
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
