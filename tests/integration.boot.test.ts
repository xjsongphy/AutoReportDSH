/** Exercise source overlays and RC2 profile configuration in isolated Harness homes. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

it('boots the RC2 bundle and persists live configuration across restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'autoreport-rc2-profile-'))
  try {
    const profile = join(home, 'profiles/web')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    symlinkSync(root, join(profile, 'node_modules/dsh-autoreport'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'autoreport-rc2-test-profile', private: true,
      dependencies: { 'dsh-autoreport': `link:${root}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-autoreport'] } },
    }))
    const harness = resolve(root, '../deepseek-harness-0.2.0-rc.2')
    const code = `
      import assert from 'node:assert/strict';
      import { runProfile } from ${JSON.stringify(pathToFileURL(join(harness, 'apps/cli/lib/profile-boot.js')).href)};
      import { createLaunchEnvironmentSnapshot } from ${JSON.stringify(pathToFileURL(join(harness, 'packages/util/launch-environment/lib/index.js')).href)};
      const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: Object.fromEntries(Object.entries(process.env).filter(([,value]) => value !== undefined)) }]);
      const options = { environment, profile: 'web', patchFiles: [], args: ['--port', '0', '--no-open'] };
      const first = await runProfile(options);
      try {
        const ctx = first.ctx, settings = ctx.get('settings'), runtime = ctx.get('autoreportWorkflow');
        assert((await ctx.get('agentPresets').list()).some(row => row.id === 'autoreport' && !row.error));
        const descriptor = settings.describe().find(row => row.ns === 'autoreport-host');
        assert(descriptor && descriptor.autoGenerate === false);
        await assert.rejects(settings.update('autoreport-host', { pythonExecutable: 'relative-python' }, descriptor.revision), /pythonExecutable/);
        await settings.update('autoreport-host', { defaultReportLanguage: 'typst' }, descriptor.revision);
        assert.equal(runtime.currentUserSettings().defaultReportLanguage, 'typst');
        const original = Symbol.for('cordis.original');
        assert.equal(ctx.get('autoreportWorkflow')[original], runtime[original]);
        await assert.rejects(settings.update('autoreport-host', { defaultReportLanguage: 'latex' }, descriptor.revision), /changed since/);
      } finally { await first.shutdown.shutdown(0); }
      const second = await runProfile(options);
      try { assert.equal(second.ctx.get('autoreportWorkflow').currentUserSettings().defaultReportLanguage, 'typst'); }
      finally { await second.shutdown.shutdown(0); }
      console.log('RC2_CONFIGURATION_OK');
    `
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 90_000,
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('RC2_CONFIGURATION_OK')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 95_000)
