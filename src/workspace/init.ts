/**
 * Experiment workspace initialization: directory scaffold plus
 * create-missing-only materialization of bundled report resources.
 *
 * AutoReportCLI creates this layout on startup and never overwrites existing
 * project files; AutoReportDSH preserves both properties. This module is pure
 * filesystem work with no DSH dependencies, so the command, tool, and host
 * wiring layers can compose it freely.
 * @module workspace/init
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Return whether every fixed AutoReport workspace directory exists. */
export function workspaceIsComplete(root: string): boolean {
  return REQUIRED_DIRS.every(dir => isDirectory(join(root, dir)))
}

/** One workspace-relative file a language materialization may install. */
interface ResourceFile {
  /** Workspace-relative destination under `Report/`. */
  readonly destination: string
  /** Path inside bundled `resources/` of the source asset. */
  readonly resourcePath: string
}

/** LaTeX assets installed at the `Report/` root (bundled in this package). */
const LATEX_FILES: readonly ResourceFile[] = Object.freeze([
  { destination: 'Report/main.tex', resourcePath: 'latex/templates/main.tex' },
  { destination: 'Report/mpltx.cls', resourcePath: 'latex/themes/mpltx.cls' },
])

/** Typst assets installed at the `Report/` root. */
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
    if (isDirectory(target)) continue
    if (existsSync(target)) {
      throw new Error(`AutoReport workspace path is not a directory: ${target}`)
    }
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
 * Resolve the bundled `resources/` directory. It is the single source of truth
 * for every AutoReport resource: templates, personas, and skill documents all
 * ship in the repository, so no runtime fetch can change what a session reads.
 * @returns absolute path to the package's `resources/` directory.
 */
export function resourcesRoot(): string {
  return bundledResourcesRoot()
}

/**
 * Resolve one bundled resource file.
 * @param resourcePath - path inside `resources/`.
 * @returns the absolute path, or `undefined` when the package is incomplete.
 */
export function resolveResourceFile(resourcePath: string): string | undefined {
  const bundled = join(bundledResourcesRoot(), resourcePath)
  return existsSync(bundled) ? bundled : undefined
}

/**
 * Copy every bundled resource for `language` into `root`, skipping files that
 * already exist. Never overwrites: an existing user report file wins over the
 * template, matching AutoReportCLI's create-missing-only rule.
 * @param root - absolute experiment workspace root.
 * @param language - report engine selecting the resource set.
 * @returns result record separating writes from skips.
 */
export function materializeResources(
  root: string,
  language: ReportLanguage,
): { written: string[], skipped: string[] } {
  const written: string[] = []
  const skipped: string[] = []
  for (const file of language === 'latex' ? LATEX_FILES : TYPST_FILES) {
    const target = join(root, file.destination)
    if (existsSync(target)) {
      skipped.push(file.destination)
      continue
    }
    const source = resolveResourceFile(file.resourcePath)
    if (source === undefined) {
      throw new Error(`AutoReport bundled resource ${file.resourcePath} is missing`)
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
 * @returns combined action manifest for callers that surface a summary.
 */
export function ensureInitialized(
  root: string,
  language: ReportLanguage,
): InitializationResult {
  const createdDirs = workspaceIsComplete(root) ? [] : ensureWorkspaceDirs(root)
  const { written, skipped } = materializeResources(root, language)
  return { createdDirs, writtenFiles: written, skippedFiles: skipped }
}

/** Files one language switch removed, installed, and left alone. */
export interface LanguageSwitchResult {
  /** Workspace-relative template files removed because they were unmodified. */
  readonly deleted: string[]
  /** Workspace-relative template files installed for the new language. */
  readonly written: string[]
  /** Files left alone: already present, or modified by the user. */
  readonly kept: string[]
}

/**
 * Move a workspace from one report language to the other.
 *
 * Two independent rules, by design: a source template is deleted only when it
 * is byte-identical to the bundled resource — any difference is the user's and
 * is kept — and a target template is copied only when the target is absent, so
 * an existing file is never overwritten. Only the two known resource sets are
 * touched, which is why the switch never scans the workspace, and a repeated
 * call writes and deletes nothing. A missing workspace directory skips the file
 * work entirely: the language is still recorded, the files just cannot follow.
 * @param root - absolute experiment workspace root.
 * @param from - language the workspace is leaving.
 * @param to - language the workspace is entering.
 * @returns what was deleted, written, and kept.
 */
export function switchReportLanguage(
  root: string,
  from: ReportLanguage,
  to: ReportLanguage,
): LanguageSwitchResult {
  const deleted: string[] = []
  const written: string[] = []
  const kept: string[] = []
  if (!isDirectory(root)) return { deleted, written, kept }
  for (const file of from === 'latex' ? LATEX_FILES : TYPST_FILES) {
    const target = join(root, file.destination)
    if (!existsSync(target)) continue
    const source = resolveResourceFile(file.resourcePath)
    const unmodified = source !== undefined && readFileSync(target).equals(readFileSync(source))
    if (!unmodified) {
      kept.push(file.destination)
      continue
    }
    unlinkSync(target)
    deleted.push(file.destination)
  }
  for (const file of to === 'latex' ? LATEX_FILES : TYPST_FILES) {
    const target = join(root, file.destination)
    if (existsSync(target)) {
      kept.push(file.destination)
      continue
    }
    const source = resolveResourceFile(file.resourcePath)
    if (source === undefined) {
      throw new Error(`AutoReport bundled resource ${file.resourcePath} is missing`)
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    written.push(file.destination)
  }
  return { deleted, written, kept }
}
