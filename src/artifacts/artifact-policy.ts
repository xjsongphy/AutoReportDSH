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

/** Size and modification time collected during one directory walk. */
export interface FileSnapshot {
  readonly size: number
  readonly mtimeMs: number
}

/** Workspace-relative POSIX path → file metadata for one scan. */
export type DirSnapshot = ReadonlyMap<string, FileSnapshot>

/** One artifact-eligible path that appeared or changed between two scans. */
export interface SnapshotChange {
  readonly path: string
  readonly kind: 'created' | 'modified'
}

function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split('\\').join('/')
}

function walkBounded(
  root: string,
  dir: string,
  out: Map<string, FileSnapshot>,
  depth: number,
  bounds: Required<ScanBounds>,
): void {
  if (depth > bounds.maxDepth || out.size >= bounds.maxEntries) return
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
    if (out.size >= bounds.maxEntries) return
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
    let stats
    try {
      stats = lstatSync(absolute)
    } catch {
      continue
    }
    out.set(toPosixRelative(root, absolute), { size: stats.size, mtimeMs: stats.mtimeMs })
  }
}

/**
 * Collect the artifact-eligible files under one absolute root as sorted
 * workspace-relative POSIX paths. The root itself must be a real (non-symlink)
 * directory; missing, unreadable, or linked roots yield an empty snapshot.
 * @param root - absolute directory to scan.
 * @param bounds - optional bound overrides for tests; defaults are the
 *   authoritative Rust constants ({@link MAX_SCAN_DEPTH}/{@link MAX_SCAN_ENTRIES}).
 * @returns filtered relative paths mapped to size/mtime metadata.
 */
export function snapshotDir(root: string, bounds: ScanBounds = {}): DirSnapshot {
  const resolvedBounds: Required<ScanBounds> = {
    maxDepth: bounds.maxDepth ?? MAX_SCAN_DEPTH,
    maxEntries: bounds.maxEntries ?? MAX_SCAN_ENTRIES,
  }
  let stats
  try {
    stats = lstatSync(root)
  } catch {
    return new Map()
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return new Map()
  const out = new Map<string, FileSnapshot>()
  walkBounded(root, root, out, 0, resolvedBounds)
  const sorted = new Map<string, FileSnapshot>()
  for (const path of [...out.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const meta = out.get(path)
    if (meta !== undefined) sorted.set(path, meta)
  }
  return sorted
}

/**
 * Change set between two metadata snapshots. New paths are `created`; paths
 * present in both snapshots with a different size or mtime are `modified`.
 * Deletions (present in `before` but absent in `after`) are ignored.
 * @param before - earlier snapshot.
 * @param after - later snapshot.
 * @returns changes in ascending path order.
 */
export function diffSnapshots(before: DirSnapshot, after: DirSnapshot): SnapshotChange[] {
  const changes: SnapshotChange[] = []
  for (const path of [...after.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const afterMeta = after.get(path)
    if (afterMeta === undefined) continue
    const beforeMeta = before.get(path)
    if (beforeMeta === undefined) {
      changes.push({ path, kind: 'created' })
    } else if (beforeMeta.size !== afterMeta.size || beforeMeta.mtimeMs !== afterMeta.mtimeMs) {
      changes.push({ path, kind: 'modified' })
    }
  }
  return changes
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
