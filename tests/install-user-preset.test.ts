import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { install } from '../scripts/install-user-preset.js'
const root = join(import.meta.dirname, '..')
const homes: string[] = []
const home = () => { const value = mkdtempSync(join(tmpdir(), 'autoreport-overlay-')); homes.push(value); return value }
afterEach(() => { for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true }) })
describe('RC2 source overlay', () => {
  it('declares the native preset and links the built plugin', () => {
    const target = home(), result = install({ home: target, repoRoot: root })
    const overlay = readFileSync(result.overlayFile, 'utf8')
    expect(overlay).toContain('@deepseek-ai/dsh-agent-preset')
    expect(overlay).toContain('id: autoreport')
    expect(overlay).toContain(join(root, 'dist/src/preset.js'))
    expect(overlay).not.toContain('__AUTOREPORT_')
    expect(overlay).toContain('includeDefaultRoots: false')
    expect(overlay).not.toContain('dsh-tool-subagent')
    expect(existsSync(result.packageLink)).toBe(true)
    expect(existsSync(join(target, '.agent-presets'))).toBe(false)
  })
  it('rerenders the overlay without deleting user files', () => {
    const target = home(), foreign = join(target, 'notes.md')
    writeFileSync(foreign, 'keep')
    install({ home: target, repoRoot: root })
    install({ home: target, repoRoot: root })
    expect(readFileSync(foreign, 'utf8')).toBe('keep')
  })
  it('rejects a missing build', () => {
    expect(() => install({ home: home(), repoRoot: root, entry: '/missing-entry.js' })).toThrow(/run pnpm run build/)
  })
  it('does not replace a foreign package directory', () => {
    const target = home()
    mkdirSync(join(target, 'profiles/node_modules/dsh-autoreport'), { recursive: true })
    expect(() => install({ home: target, repoRoot: root })).toThrow(/not a symlink/)
  })
})
