/** Render a source-development overlay using the RC2 bundle preset declaration. */
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export interface InstallOptions {
  home?: string
  repoRoot?: string
  entry?: string
}

/** Prepare the source overlay and its package link without directory-based presets. */
export function install(options: InstallOptions = {}): { overlayFile: string; entry: string; packageLink: string } {
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dirname, '..'))
  const home = options.home ?? resolveDshHome()
  const entry = options.entry ?? join(repoRoot, 'dist/src/index.js')
  if (!existsSync(entry) || !existsSync(join(repoRoot, 'dist/client.js'))) throw new Error('AutoReportDSH: run pnpm run build first')
  const modules = join(home, 'profiles/node_modules')
  mkdirSync(modules, { recursive: true })
  const packageLink = join(modules, 'dsh-autoreport')
  try {
    if (!lstatSync(packageLink).isSymbolicLink()) throw new Error(`${packageLink} exists and is not a symlink`)
    if (realpathSync(packageLink) !== realpathSync(repoRoot)) { unlinkSync(packageLink); symlinkSync(repoRoot, packageLink) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    symlinkSync(repoRoot, packageLink)
  }
  const overlayFile = join(repoRoot, 'cordis.overlay.generated.yml')
  const overlay = readFileSync(join(repoRoot, 'cordis.template.yml'), 'utf8')
    .replaceAll('__AUTOREPORT_REPORT_ROUTER__', join(repoRoot, 'dist/src/tools/report-router.js'))
    .replaceAll('__AUTOREPORT_PRESET__', join(repoRoot, 'dist/src/preset.js'))
  writeFileSync(overlayFile, overlay)
  return { overlayFile, entry, packageLink }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options: InstallOptions = {}
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i]
    if (value === undefined) throw new Error(`${key} requires a value`)
    if (key === '--home') options.home = value
    else if (key === '--repo-root') options.repoRoot = value
    else if (key === '--entry') options.entry = value
    else throw new Error(`unknown option ${key}`)
  }
  console.log(JSON.stringify(install(options)))
}
