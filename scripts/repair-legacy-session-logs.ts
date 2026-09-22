/**
 * One-time repair for session logs written before AutoReport kept its records in
 * its own log.
 *
 * Older builds wrote `autoreport/*` records into the **DSH session log**. Those
 * records are outside DSH's event vocabulary, so DSH's persistence reader
 * refuses the whole log unless each record carries the envelope's
 * `ignorable: true` marker. On the harness those builds ran against, the marker
 * was not yet writable, and the plugin instead made its names readable in
 * process by adding them to `KNOWN_SESSION_EVENT_TYPES` at activation. That
 * registration has since been retired — the plugin now writes only its own log —
 * so an old session log that never carried the marker cannot be loaded at all:
 *
 *   session "…" contains event type "autoreport/workflow" (seq 8) unknown to
 *   this harness and not marked ignorable; refusing to interpret the log
 *
 * This script adds the marker to exactly those records, re-encoding with DSH's
 * own framing and serializer so the result is byte-legal for the reader. It is
 * the upstream-sanctioned repair — `known-event-types.ts` calls the persisted
 * marker "the compatibility mechanism" — and it fixes the log for **every**
 * harness build, with or without this plugin, unlike re-registering the
 * vocabulary, which would work only while the plugin happened to be loaded.
 *
 * Nothing else changes: every record is preserved, non-AutoReport records keep
 * their original bytes, and AutoReport's own migration still reads these records
 * out of the host log into its own log on first load.
 *
 * Usage (dry run is the default; `--apply` writes a `.bak` beside each log):
 *
 *   pnpm exec tsx scripts/repair-legacy-session-logs.ts [--home <dsh-home>] [--apply]
 *
 * @module autoreportdsh/repair-legacy-session-logs
 */

import { createRequire } from 'node:module'
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'

/** The JSONL backend's frame codec and header serializer. */
interface JsonlBackend {
  compressZstdFrame: (input: Buffer | string) => Promise<Buffer>
  decompressZstdFrame: (input: Buffer) => Promise<Buffer>
  scanZstdFrames: (buffer: Buffer) => { frames: readonly { start: number; end: number }[], tornStart: number | undefined }
}

/** Zstandard frame magic; anything else is not a compressed log. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * The retired record types this repair is entitled to mark.
 *
 * - `autoreport/*` — AutoReport's own log-only records.
 * - `sandbox/workspace-root` — the per-session writable root the retired
 *   harness patch emitted, superseded by `sandbox/mode` plus the in-process
 *   policy wrap.
 *
 * Both are log-only: DSH has never folded either into a message. Marking them
 * `ignorable` is therefore the honest classification, and it is what makes the
 * log readable. Types outside this set are NOT ours to classify — see
 * {@link foreignHarnessTypes}.
 */
function isOurs(type: string): boolean {
  return type.startsWith('autoreport/') || type === 'sandbox/workspace-root'
}

/**
 * Resolve the sibling harness checkout's JSONL backend.
 *
 * It is not a dependency of this package (only the harness composes it), so it
 * is reached through a package that *is* linked. `docs/dependencies.md` pins
 * that checkout, so this resolves for anyone who can run the test suite.
 * @returns the frame codec bound to the checkout's own implementation.
 */
async function loadJsonlBackend(): Promise<JsonlBackend> {
  const require = createRequire(import.meta.url)
  const linked = dirname(require.resolve('@deepseek-ai/dsh-session-persistence/package.json'))
  const source = join(dirname(linked), 'session-persistence-jsonl', 'src', 'zstd.ts')
  return await import(pathToFileURL(source).href) as JsonlBackend
}

/** One record whose envelope lacks the marker. */
interface PendingRecord {
  /** Zero-based index into the log's body lines. */
  readonly index: number
  readonly type: string
  readonly seq: unknown
}

/** A decoded log and what it needs. */
interface LogFinding {
  readonly headerLine: string
  readonly bodyLines: readonly string[]
  /** Records this repair may mark: ours, unmarked. */
  readonly pending: readonly PendingRecord[]
  /** Our records already carrying the marker. */
  readonly alreadyMarked: number
  /**
   * Unmarked records outside this harness's vocabulary that are NOT ours —
   * retired harness event types such as the removed delta codec's
   * `assistant/chunk`. Marking those would silently drop content DSH needs to
   * reconstruct the conversation, which is exactly what the refusal exists to
   * prevent, so such a log is left alone and reported instead.
   */
  readonly foreignHarnessTypes: readonly string[]
}

/** Split a decoded log into its header line and body lines. */
function splitLog(text: string): { headerLine: string, bodyLines: string[] } {
  const lines = text.split('\n')
  // A well-formed log ends with a newline, which split turns into a final ''.
  if (lines.at(-1) === '') lines.pop()
  const [headerLine = '', ...bodyLines] = lines
  return { headerLine, bodyLines }
}

/** Inspect one decoded log without changing it. */
function inspect(text: string): LogFinding {
  const { headerLine, bodyLines } = splitLog(text)
  const pending: PendingRecord[] = []
  const foreign = new Set<string>()
  let alreadyMarked = 0
  for (const [index, line] of bodyLines.entries()) {
    if (!line.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as { type?: unknown, seq?: unknown, ignorable?: unknown }
    if (typeof record.type !== 'string') continue
    if (KNOWN_SESSION_EVENT_TYPES.has(record.type)) continue
    if (record.ignorable === true) {
      if (isOurs(record.type)) alreadyMarked += 1
      continue
    }
    if (isOurs(record.type)) pending.push({ index, type: record.type, seq: record.seq })
    else foreign.add(record.type)
  }
  return { headerLine, bodyLines, pending, alreadyMarked, foreignHarnessTypes: [...foreign].sort() }
}

/** Add the marker to one record's envelope, leaving every other byte as written. */
function withMarker(line: string): string {
  return `{"ignorable":true,${line.slice(1)}`
}

/** Decode every Zstandard frame of one log and concatenate the plaintext. */
async function decodeLog(bytes: Buffer, backend: JsonlBackend): Promise<string> {
  const { frames } = backend.scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('no Zstandard frames')
  const parts: Buffer[] = []
  for (const frame of frames) parts.push(await backend.decompressZstdFrame(bytes.subarray(frame.start, frame.end)))
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Re-encode one log in DSH's own framing: the header as its own frame, then one
 * frame holding the records. The reader requires the first frame to carry the
 * header independently and every frame to end on a record boundary; a fresh
 * materialization is exactly this shape.
 */
async function encodeLog(headerLine: string, bodyLines: readonly string[], backend: JsonlBackend): Promise<Buffer> {
  const headerFrame = await backend.compressZstdFrame(`${headerLine}\n`)
  const bodyFrame = await backend.compressZstdFrame(`${bodyLines.join('\n')}\n`)
  return Buffer.concat([headerFrame, bodyFrame])
}

/**
 * Validate decoded text the way the reader will, including the vocabulary
 * refusal this repair exists to clear.
 */
function verify(text: string): void {
  const { headerLine, bodyLines } = splitLog(text)
  const meta = JSON.parse(headerLine) as unknown
  const events = bodyLines.filter(line => line.length > 0).map(line => JSON.parse(line) as unknown)
  validateStoredEvents(meta as never, events as never, undefined)
}

/** Every session log below one root. */
function sessionLogs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^session(\.[^.]+)*\.jsonl(\.zstd)?$/u.test(entry.name)) found.push(path)
    }
  }
  walk(root)
  return found.sort()
}

/** Parse `--home <dir>` / `--apply`; unknown flags fail loud. */
function parseArgs(argv: readonly string[]): { home: string, apply: boolean } {
  let home = resolveDshHome()
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--home') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--home requires a directory')
      home = resolve(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument ${String(arg)}`)
  }
  return { home, apply }
}

/**
 * Replace one log with its repaired encoding: back up the original, write the
 * new bytes to a sibling, verify that sibling by decoding and validating it, and
 * only then swap it into place.
 */
async function repairLog(path: string, original: Buffer, finding: LogFinding, backend: JsonlBackend): Promise<string> {
  if (!statSync(path).isFile()) throw new Error(`refusing to repair a non-file: ${path}`)
  const repaired = finding.bodyLines.map((line, index) =>
    finding.pending.some(record => record.index === index) ? withMarker(line) : line)
  verify([finding.headerLine, ...repaired, ''].join('\n'))
  const encoded = await encodeLog(finding.headerLine, repaired, backend)
  const staged = `${path}.repairing`
  writeFileSync(staged, encoded)
  try {
    const roundTripped = await decodeLog(readFileSync(staged), backend)
    verify(roundTripped)
    const backup = `${path}.bak`
    if (statSync(backup, { throwIfNoEntry: false }) !== undefined) throw new Error(`backup already exists: ${backup}`)
    writeFileSync(backup, original, { flag: 'wx' })
    renameSync(staged, path)
    return backup
  } catch (error: unknown) {
    rmSync(staged, { force: true })
    throw error
  }
}

async function main(): Promise<void> {
  const { home, apply } = parseArgs(process.argv.slice(2))
  const root = join(home, 'sessions')
  console.log('AutoReport legacy session-log repair')
  console.log(`  home: ${home}`)
  console.log(`  root: ${root}`)
  console.log(`  mode: ${apply ? 'APPLY (writes a .bak beside each repaired log)' : 'dry run'}`)
  console.log('')

  const backend = await loadJsonlBackend()
  let scanned = 0
  let loadable = 0
  let affected = 0
  let records = 0
  let unrepairable = 0

  for (const path of sessionLogs(root)) {
    scanned += 1
    const bytes = readFileSync(path)
    if (!bytes.subarray(0, 4).equals(ZSTD_MAGIC)) continue
    let text: string
    try {
      text = await decodeLog(bytes, backend)
    } catch (error: unknown) {
      console.log(`SKIP  ${path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const finding = inspect(text)
    if (finding.pending.length === 0 && finding.foreignHarnessTypes.length === 0) {
      loadable += 1
      if (finding.alreadyMarked > 0) console.log(`ok    ${finding.alreadyMarked} record(s) already marked`)
      continue
    }

    if (finding.foreignHarnessTypes.length > 0) {
      // Repairing our records would not make this log loadable, and marking the
      // retired harness types is not this repair's call: those records carry
      // content DSH needs, so `ignorable` on them could silently reconstruct a
      // wrong conversation. Report and leave the file byte-identical.
      unrepairable += 1
      console.log(`BLOCKED  retired harness event type(s) present, not ours to mark:`)
      console.log(`      ${finding.foreignHarnessTypes.join(', ')}`)
      console.log(`      ${path}`)
      continue
    }

    affected += 1
    records += finding.pending.length
    const summary = new Map<string, number>()
    for (const record of finding.pending) summary.set(record.type, (summary.get(record.type) ?? 0) + 1)
    console.log(`FIX   ${finding.pending.length} record(s) unmarked, all log-only:`)
    console.log(`      ${[...summary].map(([type, count]) => `${type} ×${count}`).join(', ')}`)
    console.log(`      ${path}`)
    if (!apply) continue
    const backup = await repairLog(path, bytes, finding, backend)
    console.log(`      repaired; original kept at ${backup}`)
  }

  console.log('')
  console.log(`logs scanned: ${scanned}`)
  console.log(`logs already loadable on this harness: ${loadable}`)
  console.log(`logs repairable by this script (blocked only by our log-only records): ${affected}`)
  console.log(`records needing the marker: ${records}`)
  console.log(`logs this script will NOT touch (retired harness types): ${unrepairable}`)
  if (!apply && records > 0) console.log('\nre-run with --apply to write the repair')
}

await main()
