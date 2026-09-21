import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VERIFIED_DSH_VERSION, describeDshVersionSupport, readRunningDshVersion } from '../src/dsh-version.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake dsh install: <root>/lib/bin.js above <root>/package.json. */
function fakeDshInstall(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-dshver-'))
  tempDirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  mkdirSync(join(root, 'lib'), { recursive: true })
  const bin = join(root, 'lib', 'bin.js')
  writeFileSync(bin, '// launcher stub\n')
  return bin
}

describe('dsh version notice', () => {
  it('reads the running CLI version from the launcher anchor', () => {
    expect(readRunningDshVersion(fakeDshInstall('9.9.9-test'))).toBe('9.9.9-test')
  })

  it('accepts a directory anchor and resolves undefined without a dsh manifest', () => {
    const bin = fakeDshInstall('0.0.0')
    expect(readRunningDshVersion(join(bin, '..'))).toBe('0.0.0')
    const bare = mkdtempSync(join(tmpdir(), 'autoreport-dshver-'))
    tempDirs.push(bare)
    expect(readRunningDshVersion(bare)).toBeUndefined()
    expect(readRunningDshVersion(undefined)).toBeUndefined()
  })

  it('stops climbing at the first dsh manifest and skips foreign ones', () => {
    const outer = mkdtempSync(join(tmpdir(), 'autoreport-dshver-'))
    tempDirs.push(outer)
    // A foreign manifest ABOVE the dsh package must not win; the walk reports
    // the nearest @deepseek-ai/dsh manifest and ignores unrelated ones.
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'some-other-tool', version: '1.0.0' }))
    const dshRoot = join(outer, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(dshRoot, 'lib'), { recursive: true })
    writeFileSync(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '7.7.7' }))
    writeFileSync(join(dshRoot, 'lib', 'bin.js'), '// stub\n')
    expect(readRunningDshVersion(join(dshRoot, 'lib', 'bin.js'))).toBe('7.7.7')
  })

  it('reports the verified pair exactly', () => {
    const exact = describeDshVersionSupport(VERIFIED_DSH_VERSION)
    expect(exact.verified).toBe(true)
    expect(exact.message).toContain(VERIFIED_DSH_VERSION)
  })

  it('warns — but does not gate — on any other running build', () => {
    for (const running of ['0.1.6-alpha.1', '0.1.7-beta.0', '9.9.9']) {
      const other = describeDshVersionSupport(running)
      expect(other.verified).toBe(false)
      expect(other.message).toContain(`running dsh ${running}`)
      expect(other.message).toContain(VERIFIED_DSH_VERSION)
      expect(other.message).not.toMatch(/refus|block|abort/i)
    }
  })

  it('reports an undetectable version instead of guessing', () => {
    const unknown = describeDshVersionSupport(undefined)
    expect(unknown.verified).toBe(false)
    expect(unknown.message).toContain(VERIFIED_DSH_VERSION)
  })
})
