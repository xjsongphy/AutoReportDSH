/** Bounded compiler diagnostics with a complete on-disk log. */
import { createReadStream, openSync, closeSync, readSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { ReportLanguage } from '../workspace/init.js'

const DIAGNOSTIC_BUDGET = 12_000
const SCAN_BYTES = 2_000_000

/** Bounded diagnostic view; the original process output remains in a Report log. */
export function summarizeCompileLog(log: string, language: ReportLanguage): { text: string; truncated: boolean } {
  if (log.length <= DIAGNOSTIC_BUDGET) return { text: log, truncated: false }
  const lines = log.split(/\r?\n/u)
  const keep = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (!isDiagnostic(lines[index] ?? '', language)) continue
    for (let nearby = Math.max(0, index - 1); nearby <= Math.min(lines.length - 1, index + 6); nearby += 1) keep.add(nearby)
  }
  if (keep.size === 0) {
    const head = takeWholeLines(lines.slice(0, 35), DIAGNOSTIC_BUDGET / 2)
    const tail = takeWholeLines(lines.slice(-35).reverse(), DIAGNOSTIC_BUDGET / 2).reverse()
    return { text: `${head.join('\n')}\n[… omitted; see full log …]\n${tail.join('\n')}`, truncated: true }
  }
  const selected = [...keep].sort((a, b) => a - b).map(index => lines[index] ?? '')
  const kept = takeWholeLines(selected, DIAGNOSTIC_BUDGET)
  return {
    text: kept.length < selected.length ? `${kept.join('\n')}\n[… more diagnostics in full log …]` : kept.join('\n'),
    truncated: true,
  }
}

function takeWholeLines(lines: readonly string[], budget: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > budget) {
      if (kept.length === 0) kept.push(`${line.slice(0, budget - 40)} [… line continues in full log …]`)
      break
    }
    kept.push(line)
    used += line.length + 1
  }
  return kept
}

function isDiagnostic(line: string, language: ReportLanguage): boolean {
  return language === 'typst'
    ? /^\s*(?:error:|warning:|help:|hint:|┌─|╭─|│|╰─)/u.test(line)
    : /(?:^! |:\d+:|LaTeX (?:Error|Warning)|Package .* (?:Error|Warning)|(?:Fatal error|Emergency stop|Undefined control sequence|Reference .* undefined))/iu.test(line)
}

/** Scan every line even when the complete log is too large to hold in memory. */
async function summarizeLargeLog(path: string, language: ReportLanguage): Promise<{ text: string; truncated: boolean }> {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let previous = ''
  let following = 0
  let found = false
  let selected = ''
  let overflow = false
  for await (const line of reader) {
    if (isDiagnostic(line, language)) {
      if (!found && previous.length > 0 && previous.length < DIAGNOSTIC_BUDGET / 4) selected += `${previous}\n`
      found = true
      following = 6
    }
    if (following > 0) {
      if (selected.length + line.length + 1 <= DIAGNOSTIC_BUDGET) selected += `${line}\n`
      else overflow = true
      following -= 1
    }
    previous = line
  }
  if (!found) {
    const fallback = readDiagnosticSample(path)
    return summarizeCompileLog(fallback.text, language)
  }
  return { text: overflow ? `${selected}[… more diagnostics in full log …]` : selected, truncated: true }
}

function readDiagnosticSample(path: string): { text: string; sampled: boolean } {
  const size = statSync(path).size
  if (size <= 2 * SCAN_BYTES) return { text: readSmallLog(path, size), sampled: false }
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(SCAN_BYTES)
    const tail = Buffer.alloc(SCAN_BYTES)
    const first = readSync(fd, head, 0, head.length, 0)
    const last = readSync(fd, tail, 0, tail.length, size - SCAN_BYTES)
    return { text: `${head.subarray(0, first).toString('utf8')}\n[… middle of full log omitted …]\n${tail.subarray(0, last).toString('utf8')}`, sampled: true }
  } finally {
    closeSync(fd)
  }
}

function readSmallLog(path: string, size: number): string {
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(size)
    return bytes.subarray(0, readSync(fd, bytes, 0, size, 0)).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Produce a bounded model-facing view while retaining the complete log on disk. */
export async function summarizeCompileFile(path: string, language: ReportLanguage): Promise<{ text: string; truncated: boolean }> {
  return statSync(path).size > 2 * SCAN_BYTES
    ? summarizeLargeLog(path, language)
    : summarizeCompileLog(readDiagnosticSample(path).text, language)
}
