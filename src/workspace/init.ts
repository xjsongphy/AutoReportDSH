/**
 * Experiment workspace initialization: directory scaffold plus
 * create-missing-only materialization of bundled and synced report resources.
 *
 * AutoReportCLI creates this layout on startup and never overwrites existing
 * project files; AutoReportDSH preserves both properties. This module is pure
 * filesystem work with no DSH dependencies, so the command, tool, and host
 * wiring layers can compose it freely.
 * @module workspace/init
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Report engine whose resource set `materializeResources` installs. */
export type ReportLanguage = 'latex' | 'typst'

/** Directory layout AutoReportCLI's loader requires (`REQUIRED_DIRS`). */
export const REQUIRED_DIRS: readonly string[] = Object.freeze([
  'Data',
  'Data/Processed',
  'References',
  'Theory',
  'Plots',
  'Plots/Fig',
  'Plots/Scripts',
  'Report',
  'Outline',
])

/** One workspace-relative file a language materialization may install. */
interface ResourceFile {
  /** Workspace-relative destination under `Report/`. */
  readonly destination: string
  /** Path inside bundled or overlay `resources/` of the source asset. */
  readonly resourcePath: string
}

/** LaTeX assets installed at the `Report/` root (bundled in this package). */
const LATEX_FILES: readonly ResourceFile[] = Object.freeze([
  { destination: 'Report/main.tex', resourcePath: 'latex/templates/main.tex' },
  { destination: 'Report/mpltx.cls', resourcePath: 'latex/themes/mpltx.cls' },
])

/** Typst assets installed at the `Report/` root (synced into the overlay). */
const TYPST_FILES: readonly ResourceFile[] = Object.freeze([
  { destination: 'Report/main.typ', resourcePath: 'typst/templates/main.typ' },
  { destination: 'Report/mplts.typ', resourcePath: 'typst/themes/mplts.typ' },
  { destination: 'Report/american-physics-society.csl', resourcePath: 'typst/templates/american-physics-society.csl' },
  { destination: 'Report/bibli.bib', resourcePath: 'typst/templates/bibli.bib' },
])

/** Result of one idempotent initialization pass over a workspace root. */
export interface InitializationResult {
  /** Workspace-relative directories created by this pass (parents first). */
  readonly createdDirs: string[]
  /** Workspace-relative files written by this pass (were missing). */
  readonly writtenFiles: string[]
  /** Workspace-relative files already present and left untouched. */
  readonly skippedFiles: string[]
}

/**
 * Create every required experiment directory below `root`. Existing
 * directories are left untouched, so repeated calls converge to the same
 * layout without side effects.
 * @param root - absolute experiment workspace root.
 * @returns workspace-relative paths of directories this call created.
 */
export function ensureWorkspaceDirs(root: string): string[] {
  const created: string[] = []
  for (const dir of REQUIRED_DIRS) {
    const target = join(root, dir)
    if (existsSync(target)) continue
    mkdirSync(target, { recursive: true })
    created.push(dir)
  }
  return created
}

/**
 * Resolve the bundled `resources/` directory relative to this module so the
 * path works identically from source (`src/workspace/`) and from compiled
 * output (`dist/src/workspace/`).
 * @returns absolute path to the package's `resources/` directory.
 */
export function bundledResourcesRoot(): string {
  // src/workspace/init.ts → package root is two levels up; dist/src/workspace/
  // keeps the same depth because tsc preserves the `src/` segment.
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../resources')
}

/**
 * Resolve the bundled `resources/` directory. Synced remotes live in the
 * global overlay (`$DSH_HOME/autoreport/resources`), not here.
 * @returns absolute path to the package's `resources/` directory.
 */
export function resourcesRoot(): string {
  return bundledResourcesRoot()
}

/**
 * Resolve one resource file: overlay copy wins when present, otherwise the
 * package-bundled file. Missing from both returns `undefined`.
 * @param resourcePath - path inside `resources/`.
 * @param overlayRoot - `$dshHome/autoreport/resources`, when configured.
 */
export function resolveResourceFile(resourcePath: string, overlayRoot?: string): string | undefined {
  if (overlayRoot !== undefined) {
    const overlay = join(overlayRoot, resourcePath)
    if (existsSync(overlay)) return overlay
  }
  const bundled = join(bundledResourcesRoot(), resourcePath)
  return existsSync(bundled) ? bundled : undefined
}

/**
 * Copy every bundled/synced resource for `language` into `root`, skipping
 * files that already exist. Never overwrites: an existing user report file
 * wins over the template, matching AutoReportCLI's create-missing-only rule.
 * @param root - absolute experiment workspace root.
 * @param language - report engine selecting the resource set.
 * @param overlayRoot - global synced overlay; required for Typst templates.
 * @returns result record separating writes from skips.
 */
export function materializeResources(
  root: string,
  language: ReportLanguage,
  overlayRoot?: string,
): { written: string[], skipped: string[] } {
  const written: string[] = []
  const skipped: string[] = []
  for (const file of language === 'latex' ? LATEX_FILES : TYPST_FILES) {
    const target = join(root, file.destination)
    if (existsSync(target)) {
      skipped.push(file.destination)
      continue
    }
    const source = resolveResourceFile(file.resourcePath, overlayRoot)
    if (source === undefined) {
      throw new Error(
        `AutoReport resource ${file.resourcePath} is missing`
        + ` (overlay ${overlayRoot ?? 'unset'}; run plugin sync into $DSH_HOME/autoreport/resources)`,
      )
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    written.push(file.destination)
  }
  return { written, skipped }
}

/**
 * Run one full idempotent initialization pass: create missing directories,
 * then materialize missing resources for `language`.
 * @param root - absolute experiment workspace root.
 * @param language - report engine selecting the resource set.
 * @param overlayRoot - global synced overlay for Typst (and any overlay skills).
 * @returns combined action manifest for callers that surface a summary.
 */
export function ensureInitialized(
  root: string,
  language: ReportLanguage,
  overlayRoot?: string,
): InitializationResult {
  const createdDirs = ensureWorkspaceDirs(root)
  const { written, skipped } = materializeResources(root, language, overlayRoot)
  return { createdDirs, writtenFiles: written, skippedFiles: skipped }
}
