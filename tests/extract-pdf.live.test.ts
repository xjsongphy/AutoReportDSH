/** Live PDF extraction against the real mineru-open-api service using tests/template.pdf.
 *  Opt-in: run with AUTOREPORT_LIVE_TEST=1 (requires mineru-open-api installed and authenticated).
 *  The sandbox/subprocess services are test doubles that forward to real processes, so the
 *  tool's full execute() path — validation, confine, spawn, result mapping — runs for real. */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installReferenceExtractTool } from '../src/tools/extract-pdf.js'

const TEMPLATE_PDF = join(process.cwd(), 'tests', 'template.pdf')
const skipReason = process.env.AUTOREPORT_LIVE_TEST !== '1'
  ? 'AUTOREPORT_LIVE_TEST=1 is not set'
  : !existsSync(TEMPLATE_PDF)
    ? 'tests/template.pdf is missing'
    : undefined

describe.skipIf(skipReason !== undefined)(`live extract_pdf${skipReason === undefined ? '' : ` (${skipReason})`}`, () => {
  let workspace: string | undefined

  afterEach(() => {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
    workspace = undefined
  })

  it('extracts tests/template.pdf through the tool and cleans up afterwards', { timeout: 340_000 }, async () => {
    workspace = mkdtempSync(join(tmpdir(), 'autoreport-extract-live-'))
    mkdirSync(join(workspace, 'References'))
    mkdirSync(join(workspace, 'Outline'))
    copyFileSync(TEMPLATE_PDF, join(workspace, 'References', 'template.pdf'))

    const realSubprocess = {
      spawn: ({ argv, signal }: { argv: readonly string[]; signal: AbortSignal }) => {
        const child = spawn(argv[0]!, argv.slice(1), { signal, stdio: ['ignore', 'pipe', 'pipe'] })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout?.on('data', chunk => stdout.push(chunk as Buffer))
        child.stderr?.on('data', chunk => stderr.push(chunk as Buffer))
        return {
          done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
            child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
          }),
          collected: {
            stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8') }) },
            stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8') }) },
          },
        }
      },
    }
    const tool = installReferenceExtractToolInTest({
      sandbox: { confine: async (args: readonly string[]) => ({ argv: args, enforcement: 'full' }) },
      subprocess: realSubprocess,
    })

    const result = await tool.execute({ path: 'References/template.pdf' }, {
      agent: { session: { id: 'main', header: { cwd: workspace } } },
      signal: new AbortController().signal,
    }) as { status: string; outputDir: string; diagnostics: string }

    expect(result.status, `diagnostics: ${result.diagnostics}`).toBe('success')
    const markdown = join(workspace, result.outputDir, 'template.md')
    expect(existsSync(markdown), `expected markdown at ${markdown}\ndiagnostics: ${result.diagnostics}`).toBe(true)
    expect(result.outputDir).toBe('Outline/.cache/mineru/template')
  })
})

/** Register the tool against a minimal context exposing only the given services. */
function installReferenceExtractToolInTest(services: Record<string, unknown>): {
  execute: (args: unknown, exec: unknown) => Promise<unknown>
} {
  let tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
  installReferenceExtractTool({
    tools: { register: (definition: typeof tool) => { tool = definition; return () => {} } },
    get: (name: string) => services[name],
  } as never)
  if (tool === undefined) throw new Error('tool was not registered')
  return tool
}
