import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeCompileFile, summarizeCompileLog } from '../src/tools/compile-diagnostics.js'

describe('compiler diagnostics', () => {
  it('returns a short Typst diagnostic without losing its source span', () => {
    const message = 'error: unknown variable\n  ┌─ Report/main.typ:12:5\n  │\n12│ #bad\n  │  ^^^\n'
    expect(summarizeCompileLog(message, 'typst')).toEqual({ text: message, truncated: false })
  })

  it('selects an early LaTeX error from long routine output', () => {
    const log = `opening packages\n./main.tex:7: Undefined control sequence.\nl.7 \\bad\n${'routine output\n'.repeat(2_000)}`
    const summary = summarizeCompileLog(log, 'latex')
    expect(summary.text).toContain('./main.tex:7: Undefined control sequence.')
    expect(summary.text).toContain('l.7 \\bad')
    expect(summary.truncated).toBe(true)
  })

  it('finds an error in the middle of a log too large to load at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-log-'))
    const path = join(root, 'compile.log')
    writeFileSync(path, `${'routine output\n'.repeat(150_000)}\nerror: figure missing\n  ┌─ Report/main.typ:22:3\n${'routine output\n'.repeat(150_000)}`)
    const summary = await summarizeCompileFile(path, 'typst')
    expect(summary.text).toContain('error: figure missing')
    expect(summary.text).toContain('Report/main.typ:22:3')
    expect(summary.truncated).toBe(true)
  })
})
