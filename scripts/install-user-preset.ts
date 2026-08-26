/**
 * Materialize the AutoReportDSH user preset and render the patch overlay.
 *
 * Copies presets/autoreport-main into the DeepSeek Harness home's writable
 * user preset root (`<home>/.agent-presets/autoreport-main`) so the shipped
 * agent-presets roster discovers it through DSH's ordinary `includeUserRoot`
 * discovery, then renders cordis.overlay.generated.yml from
 * cordis.template.yml with the absolute built plugin entry path.
 *
 * Idempotent: our own files are overwritten in place; foreign files inside an
 * existing preset directory are never removed. Run after `pnpm run build` so
 * dist/src/host.js exists for the overlay.
 *
 * @module autoreportdsh/install-user-preset
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const PRESET_SOURCE_DIR = 'presets/autoreport-main'
const USER_PRESET_ROOT = '.agent-presets'
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

export interface InstallOptions {
  /** Harness home override (test seam); defaults to DSH's own resolution. */
  home?: string
  /** Repository root override (test seam); defaults to this package root. */
  repoRoot?: string
  /** Built host entry override; defaults to `<repoRoot>/dist/src/host.js`. */
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
 * Install the AutoReport Main preset and render the overlay file.
 * @param options - optional home/repoRoot/entry overrides for testing.
 * @returns a report of every written path for callers and tests.
 */
export function install(options: InstallOptions = {}): { presetDir: string; overlayFile: string; entry: string } {
  const repoRoot = options.repoRoot !== undefined ? resolve(options.repoRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const home = options.home !== undefined ? resolve(options.home) : resolveDshHome()
  // rootDir is the repo root, so tsc preserves src/.
  const entry = options.entry !== undefined ? resolve(options.entry) : join(repoRoot, 'dist', 'src', 'host.js')

  if (!isAbsolute(entry) || !existsSync(entry)) {
    throw new Error(`autoreportdsh: built plugin entry not found at ${entry}; run \`pnpm run build\` first`)
  }

  const sourceDir = join(repoRoot, PRESET_SOURCE_DIR)
  if (!existsSync(join(sourceDir, 'agent.cordis.yml'))) {
    throw new Error(`autoreportdsh: preset composition missing at ${join(sourceDir, 'agent.cordis.yml')}`)
  }

  const presetDir = join(home, USER_PRESET_ROOT, 'autoreport-main')
  try {
    mergeCopy(sourceDir, presetDir)
    const compositionTemplate = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')
    const mainPersona = readFileSync(join(repoRoot, MAIN_PERSONA_FILE), 'utf8')
    const composition = compositionTemplate
      .replace('__AUTOREPORT_MAIN_PERSONA__', indentYamlBlock(mainPersona, 6).trimStart())
      .replaceAll('__AUTOREPORT_SEND_TO_AGENT__', pluginEntry(repoRoot, 'tools/send-to-agent.js'))
      .replaceAll('__AUTOREPORT_REPORT_TASK__', pluginEntry(repoRoot, 'tools/report-task.js'))
      .replaceAll('__AUTOREPORT_SKILLS_PRESET__', pluginEntry(repoRoot, 'skills-preset.js'))
    writeFileSync(join(presetDir, 'agent.cordis.yml'), composition)
  } catch (error: unknown) {
    throw new Error(`autoreportdsh: failed to materialize preset under ${presetDir}: ${String(error)}`)
  }

  const templatePath = join(repoRoot, TEMPLATE_FILE)
  let template: string
  try {
    template = readFileSync(templatePath, 'utf8')
  } catch (error: unknown) {
    throw new Error(`autoreportdsh: cannot read overlay template ${templatePath}: ${String(error)}`)
  }

  const overlayFile = join(repoRoot, GENERATED_OVERLAY_FILE)
  const reportRouter = pluginEntry(repoRoot, 'tools/report-router.js')
  writeFileSync(overlayFile, template
    .replaceAll('__AUTOREPORT_ENTRY__', entry)
    .replaceAll('__AUTOREPORT_REPORT_ROUTER__', reportRouter))

  return { presetDir, overlayFile, entry }
}

/** CLI entry: `pnpm install:preset [--home <path>] [--repo-root <path>] [--entry <path>]`. */
function main(argv: readonly string[]): void {
  const options: InstallOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
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
  console.log(`autoreportdsh: overlay rendered at ${result.overlayFile}`)
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
