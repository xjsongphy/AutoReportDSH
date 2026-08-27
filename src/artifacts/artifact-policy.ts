/**
 * Artifact filtering and bounded traversal ported from AutoReportCLI's
 * manifest scanner (`autoreport-rs/tools/src/manifest.rs`). The ignore set,
 * depth/entry bounds, and symlink policy are the authoritative AutoReport
 * semantics: compiler intermediates and editor noise never become artifacts,
 * linked paths never cross the workspace boundary, and a pathological tree
 * cannot consume unbounded resources during observation.
 *
 * Pure string/filesystem plane only: this module imports nothing from tools
 * or host wiring (PLAN.md §2.11).
 * @module
 */

import { lstatSync, readdirSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

/** Maximum recursion depth below the scanned root (manifest.rs `MAX_DEPTH`). */
export const MAX_SCAN_DEPTH = 16

/** Maximum total file entries collected across one scan (`MAX_ENTRIES`). */
export const MAX_SCAN_ENTRIES = 50_000

/** Directory names never traversed (manifest.rs `should_ignore_dir`). */
const IGNORED_DIR_NAMES = new Set(['.git', '__pycache__', '.autoreport', '.cache', 'target'])

/** Exact file-name ignores (manifest.rs `should_ignore_file`, first clause). */
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

/** Suffixes ignored wherever they appear on a file name. */
const IGNORED_FILE_SUFFIXES = [
  '~',
  '.tmp',
  '.bak',
  '.swp',
  '.swo',
  '.aux',
  '.log',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.fls',
  '.fdb_latexmk',
  '.synctex.gz',
  '.bbl',
  '.blg',
  '.bcf',
  '.dvi',
  '.ps',
  '.idx',
  '.ilg',
  '.ind',
  '.nav',
  '.snm',
  '.vrb',
] as const

/**
 * Whether one DIRECTORY name is never traversed.
 * @param name - final path segment of a directory.
 * @returns true when walking must skip the whole subtree.
 */
export function shouldIgnoreDir(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name)
}

/**
 * Whether one FILE name is never an artifact.
 * @param name - final path segment of a file.
 * @returns true when the file must be excluded.
 */
export function shouldIgnoreFile(name: string): boolean {
  if (IGNORED_FILE_NAMES.has(name)) return true
  return IGNORED_FILE_SUFFIXES.some(suffix => name.endsWith(suffix))
}

/**
 * Whether one workspace-relative path is excluded anywhere along its segments.
 * String snapshots carry no entry kind, so a name matching the directory deny
 * list is treated as ignorable at any position — conservative relative to the
 * filesystem walk, which only applies directory rules to real directories.
 * @param relPath - workspace-relative POSIX path.
 * @returns true when the path must never become an artifact entry.
 */
export function shouldIgnore(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.length === 0) return true
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]
    if (segment !== undefined && IGNORED_DIR_NAMES.has(segment)) return true
  }
  const last = segments[segments.length - 1]
  if (last === undefined || last === '') return true
  return IGNORED_DIR_NAMES.has(last) || shouldIgnoreFile(last)
}

/** Tunable bounds; defaults reproduce the Rust constants exactly. */
export interface ScanBounds {
  /** Maximum recursion depth below the root. */
  readonly maxDepth?: number
  /** Maximum total collected entries. */
  readonly maxEntries?: number
}

function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split('\\').join('/')
}

function walkBounded(
  root: string,
  dir: string,
  out: string[],
  depth: number,
  bounds: Required<ScanBounds>,
): void {
  if (depth > bounds.maxDepth || out.length >= bounds.maxEntries) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // An unreadable directory contributes nothing; the walk stays best-effort
    // exactly like the Rust reader, which skips failed read_dir calls.
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (out.length >= bounds.maxEntries) return
    const absolute = join(dir, entry.name)
    // Symlinks are skipped without following: a linked directory can cycle
    // and a linked file can point outside the project boundary (manifest.rs
    // walks `symlink_metadata` and continues on every symlink).
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (!IGNORED_DIR_NAMES.has(entry.name)) {
        walkBounded(root, absolute, out, depth + 1, bounds)
      }
      continue
    }
    if (!entry.isFile() || IGNORED_FILE_NAMES.has(entry.name)) continue
    if (IGNORED_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) continue
    out.push(toPosixRelative(root, absolute))
  }
}

/**
 * Collect the artifact-eligible files under one absolute root as sorted
 * workspace-relative POSIX paths. The root itself must be a real (non-symlink)
 * directory; missing, unreadable, or linked roots yield an empty snapshot.
 * @param root - absolute directory to scan.
 * @param bounds - optional bound overrides for tests; defaults are the
 *   authoritative Rust constants ({@link MAX_SCAN_DEPTH}/{@link MAX_SCAN_ENTRIES}).
 * @returns filtered relative paths, sorted ascending.
 */
export function snapshotDir(root: string, bounds: ScanBounds = {}): string[] {
  const resolvedBounds: Required<ScanBounds> = {
    maxDepth: bounds.maxDepth ?? MAX_SCAN_DEPTH,
    maxEntries: bounds.maxEntries ?? MAX_SCAN_ENTRIES,
  }
  let stats
  try {
    stats = lstatSync(root)
  } catch {
    return []
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return []
  const out: string[] = []
  walkBounded(root, root, out, 0, resolvedBounds)
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Presence-based change set between two filtered snapshots: every path that
 * exists in `after` but not in `before` (creation detection). Modification of
 * an unchanged path set needs mtime- or content-aware snapshots and is owned
 * by the executors that observe their own runs.
 * @param before - earlier snapshot.
 * @param after - later snapshot.
 * @returns paths unique to `after`, in `after` order.
 */
export function diffSnapshots(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before)
  return after.filter(path => !seen.has(path))
}

/** Directory key for a root-level artifact in rendered manifests. */
export const ROOT_DIRECTORY_KEY = '.'

/**
 * Workspace-relative directory portion of one artifact path.
 * @param path - workspace-relative POSIX path.
 * @returns its directory (`.` for a root-level file).
 */
export function directoryOf(path: string): string {
  const dir = posix.dirname(path.split('\\').join('/'))
  return dir === '' ? ROOT_DIRECTORY_KEY : dir
}
