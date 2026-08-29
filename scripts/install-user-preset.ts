/**
 * Materialize the AutoReportDSH user preset and render the patch overlay.
 *
 * Copies presets/autoreport into the DeepSeek Harness home's writable
 * user preset root (`<home>/.agent-presets/autoreport`) so the shipped
 * agent-presets roster discovers it through DSH's ordinary `includeUserRoot`
 * discovery, then renders cordis.overlay.generated.yml from
 * cordis.template.yml with the package-name host row (`autoreportdsh`) and
 * the absolute built report-router path. Also symlinks this package under
 * `<home>/profiles/node_modules/autoreportdsh` so Node and the client-module
 * scan can resolve `exports["./client"]`.
 *
 * A leftover `<home>/.agent-presets/autoreport-main` from the preset-id
 * rename is retired after the new directory is written: foreign files that
 * the new install does not already own are copied across, then the old
 * directory is removed so the roster does not list two AutoReport presets.
 *
 * Idempotent: our own files are overwritten in place; foreign files inside an
 * existing preset directory are never removed. Run after `pnpm run build` so
 * dist/src/index.js and dist/client.js exist.
 *
 * @module autoreportdsh/install-user-preset
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const PRESET_SOURCE_DIR = 'presets/autoreport'
const USER_PRESET_ROOT = '.agent-presets'
const PRESET_DIR_NAME = 'autoreport'
/** Retired directory name from before the preset id rename. */
const LEGACY_PRESET_DIR_NAME = 'autoreport-main'
const TEMPLATE_FILE = 'cordis.template.yml'
const GENERATED_OVERLAY_FILE = 'cordis.overlay.generated.yml'
const MAIN_PERSONA_FILE = 'resources/personas/main_agent.md'

function pluginEntry(repoRoot: string, modulePath: string): string {
  return join(repoRoot, 'dist', 'src', ...modulePath.split('/'))
}

function indentYamlBlock(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces)
  return value.trimEnd().split('\n').map(line => `${indent}${line}`).join('\n')
}

/**
 * Point `$DSH_HOME/profiles/node_modules/autoreportdsh` at this package so
 * Loader and the client-module scan resolve it by name.
 * @param home - harness home.
 * @param repoRoot - this package's root.
 * @returns the symlink path.
 */
function linkPackage(home: string, repoRoot: string): string {
  const modules = join(home, 'profiles', 'node_modules')
  mkdirSync(modules, { recursive: true })
  const link = join(modules, 'autoreportdsh')
  const target = resolve(repoRoot)
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`autoreportdsh: ${link} exists and is not a symlink`)
    }
    if (realpathSync(link) === realpathSync(target)) return link
    unlinkSync(link)
  }
  symlinkSync(target, link)
  return link
}

export interface InstallOptions {
  /** Harness home override (test seam); defaults to DSH's own resolution. */
  home?: string
  /** Repository root override (test seam); defaults to this package root. */
  repoRoot?: string
  /** Built host entry that must exist; defaults to `<repoRoot>/dist/src/index.js`. */
  entry?: string
}

/**
 * Copy one directory tree over another without deleting foreign files.
 * Existing files at copied paths are overwritten; unrelated entries in the
 * destination survive, which keeps a user-modified sibling preset intact.
 */
function mergeCopy(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry)
    const targetPath = join(targetDir, entry)
    if (statSync(sourcePath).isDirectory()) {
      mergeCopy(sourcePath, targetPath)
    } else {
      cpSync(sourcePath, targetPath)
    }
  }
}

/**
 * Copy files from a leftover `autoreport-main` install that the new
 * directory does not already own, then delete the old directory so the roster
 * does not list two AutoReport presets.
 */
function retireLegacyPreset(home: string, presetDir: string): string | undefined {
  const legacyDir = join(home, USER_PRESET_ROOT, LEGACY_PRESET_DIR_NAME)
  if (!existsSync(legacyDir)) return undefined
  mergeMissing(legacyDir, presetDir)
  rmSync(legacyDir, { recursive: true, force: true })
  return legacyDir
}

/** Copy source files that do not already exist at the destination. */
function mergeMissing(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry)
    const targetPath = join(targetDir, entry)
    if (statSync(sourcePath).isDirectory()) {
      mergeMissing(sourcePath, targetPath)
    } else if (!existsSync(targetPath)) {
      cpSync(sourcePath, targetPath)
    }
  }
}

/**
 * Install the AutoReport Main preset and render the overlay file.
 * @param options - optional home/repoRoot/entry overrides for testing.
 * @returns a report of every written path for callers and tests.
 */
export function install(options: InstallOptions = {}): {
  presetDir: string
  overlayFile: string
  entry: string
  packageLink: string
  retiredLegacyPresetDir?: string
} {
  const repoRoot = options.repoRoot !== undefined ? resolve(options.repoRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const home = options.home !== undefined ? resolve(options.home) : resolveDshHome()
  // rootDir is the repo root, so tsc preserves src/. Package main is index.js.
  const entry = options.entry !== undefined ? resolve(options.entry) : join(repoRoot, 'dist', 'src', 'index.js')
  const clientBundle = join(repoRoot, 'dist', 'client.js')

  if (!isAbsolute(entry) || !existsSync(entry)) {
    throw new Error(`autoreportdsh: built plugin entry not found at ${entry}; run \`pnpm run build\` first`)
  }
  if (options.entry === undefined && !existsSync(clientBundle)) {
    throw new Error(`autoreportdsh: client bundle not found at ${clientBundle}; run \`pnpm run build\` first`)
  }

  const sourceDir = join(repoRoot, PRESET_SOURCE_DIR)
  if (!existsSync(join(sourceDir, 'agent.cordis.yml'))) {
    throw new Error(`autoreportdsh: preset composition missing at ${join(sourceDir, 'agent.cordis.yml')}`)
  }

  const presetDir = join(home, USER_PRESET_ROOT, PRESET_DIR_NAME)
  try {
    mergeCopy(sourceDir, presetDir)
    const compositionTemplate = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')
    const mainPersona = readFileSync(join(repoRoot, MAIN_PERSONA_FILE), 'utf8')
    const composition = compositionTemplate
      .replace('__AUTOREPORT_MAIN_PERSONA__', indentYamlBlock(mainPersona, 6).trimStart())
      .replaceAll('__AUTOREPORT_PRESET__', pluginEntry(repoRoot, 'preset.js'))
    writeFileSync(join(presetDir, 'agent.cordis.yml'), composition)
  } catch (error: unknown) {
    throw new Error(`autoreportdsh: failed to materialize preset under ${presetDir}: ${String(error)}`)
  }
  const retiredLegacyPresetDir = retireLegacyPreset(home, presetDir)

  const templatePath = join(repoRoot, TEMPLATE_FILE)
  let template: string
  try {
    template = readFileSync(templatePath, 'utf8')
  } catch (error: unknown) {
    throw new Error(`autoreportdsh: cannot read overlay template ${templatePath}: ${String(error)}`)
  }

  const overlayFile = join(repoRoot, GENERATED_OVERLAY_FILE)
  const reportRouter = pluginEntry(repoRoot, 'tools/report-router.js')
  writeFileSync(overlayFile, template.replaceAll('__AUTOREPORT_REPORT_ROUTER__', reportRouter))
  const packageLink = linkPackage(home, repoRoot)

  return {
    presetDir,
    overlayFile,
    entry,
    packageLink,
    ...(retiredLegacyPresetDir === undefined ? {} : { retiredLegacyPresetDir }),
  }
}

/** CLI entry: `pnpm install:preset [--home <path>] [--repo-root <path>] [--entry <path>]`. */
function main(argv: readonly string[]): void {
  const options: InstallOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // pnpm forwards this conventional script-argument delimiter to Node.
    if (arg === '--') continue
    if (arg === '--home') {
      const value = argv[++i]
      if (value === undefined) throw new Error('autoreportdsh: --home requires a value')
      options.home = value
    } else if (arg === '--repo-root') {
      const value = argv[++i]
      if (value === undefined) throw new Error('autoreportdsh: --repo-root requires a value')
      options.repoRoot = value
    } else if (arg === '--entry') {
      const value = argv[++i]
      if (value === undefined) throw new Error('autoreportdsh: --entry requires a value')
      options.entry = value
    } else throw new Error(`autoreportdsh: unknown argument ${String(arg)}`)
  }
  const result = install(options)
  console.log(`autoreportdsh: preset installed at ${result.presetDir}`)
  if (result.retiredLegacyPresetDir !== undefined) {
    console.log(`autoreportdsh: retired leftover preset at ${result.retiredLegacyPresetDir}`)
  }
  console.log(`autoreportdsh: overlay rendered at ${result.overlayFile}`)
  console.log(`autoreportdsh: package linked at ${result.packageLink}`)
  console.log('autoreportdsh: boot with `pnpm dsh web --patch ./cordis.overlay.generated.yml`')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error: unknown) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  }
}
