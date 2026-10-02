import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTRACT_TIMEOUT_MS, MINERU_TIMEOUT_SECONDS, installReferenceExtractTool } from '../src/tools/extract-pdf.js'

type Tool = { execute: (args: unknown, exec: unknown) => Promise<unknown> }

interface SpawnOutcome {
  exitCode: number
  stdout?: string
  stderr?: string
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-reference-'))
  mkdirSync(join(root, 'References'))
  mkdirSync(join(root, 'Outline'))
  return root
}

/** Build a plugin context whose sandbox and subprocess are test doubles. */
function makeCtx(options: {
  workspace: string
  argv?: (args: readonly string[]) => void
  spawn?: () => SpawnOutcome
  enforcement?: string
  /** Override the service surface; an empty object removes both services. */
  services?: { sandbox?: unknown; subprocess?: unknown }
}) {
  const sandbox = {
    confine: (args: readonly string[]) => {
      options.argv?.(args)
      return { argv: args, enforcement: options.enforcement ?? 'full' }
    },
  }
  const subprocess = {
    spawn: () => {
      const { exitCode, stdout, stderr } = options.spawn?.() ?? { exitCode: 0, stdout: 'done', stderr: '' }
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout ?? '' }) },
          stderr: { readFrom: () => ({ text: stderr ?? '' }) },
        },
      }
    },
  }
  return {
    tools: { register: (definition: unknown) => {
      registeredTool = definition as Tool
      return () => {}
    } },
    get: (name: string) => name === 'sandbox' ? (options.services ? options.services.sandbox : sandbox)
      : name === 'subprocess' ? (options.services ? options.services.subprocess : subprocess)
      : undefined,
  }
}

let registeredTool: Tool | undefined

function install(ctx: unknown): Tool {
  registeredTool = undefined
  installReferenceExtractTool(ctx as never)
  if (registeredTool === undefined) throw new Error('tool was not registered')
  return registeredTool
}

function run(tool: Tool, workspace: string, path = 'References/handout.pdf', withAgent = true): Promise<unknown> {
  return tool.execute({ path }, {
    ...(withAgent ? { agent: { session: { id: 'main', header: { cwd: workspace } } } } : {}),
    signal: new AbortController().signal,
  })
}

describe('extract_pdf', () => {
  it('passes a References PDF and an Outline output directory as fixed argv', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'handout.pdf'), '%PDF')
    let argv: readonly string[] = []
    const tool = install(makeCtx({
      workspace,
      argv: args => { argv = args },
    }))
    const result = await run(tool, workspace) as { status: string; outputDir: string }
    expect(result).toMatchObject({ status: 'success', outputDir: 'Outline/.cache/mineru/handout' })
    expect(argv.slice(0, 2)).toEqual(['mineru-open-api', 'extract'])
    expect(argv.at(-2)).toBe('-o')
    expect(argv.at(-1)).toBe(realpathSync(join(workspace, 'Outline', '.cache', 'mineru', 'handout')))
  })

  it('passes the configured CLI timeout through to mineru before the -o flag', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'handout.pdf'), '%PDF')
    let argv: readonly string[] = []
    const tool = install(makeCtx({
      workspace,
      argv: args => { argv = args },
    }))
    await run(tool, workspace)
    const timeoutIndex = argv.indexOf('--timeout')
    expect(timeoutIndex).toBeGreaterThan(-1)
    expect(argv[timeoutIndex + 1]).toBe('300')
    expect(timeoutIndex).toBeLessThan(argv.indexOf('-o'))
  })

  it('keeps CJK characters in the cache output directory name', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', '教材讲义.pdf'), '%PDF')
    const tool = install(makeCtx({ workspace }))
    const result = await run(tool, workspace, 'References/教材讲义.pdf') as { status: string; outputDir: string }
    expect(result).toMatchObject({ status: 'success', outputDir: 'Outline/.cache/mineru/教材讲义' })
  })

  it('rejects a missing file like the reference suite expects', async () => {
    const workspace = makeWorkspace()
    const tool = install(makeCtx({ workspace }))
    await expect(run(tool, workspace, 'References/nonexistent.pdf')).rejects.toThrow(/ENOENT|nonexistent\.pdf/u)
  })

  it('rejects non-PDF inputs', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'notes.txt'), 'text')
    const tool = install(makeCtx({ workspace }))
    await expect(run(tool, workspace, 'References/notes.txt')).rejects.toThrow('expects a PDF file under References/')
  })

  it('rejects sources outside the References root', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'handout.pdf'), '%PDF')
    const tool = install(makeCtx({ workspace }))
    await expect(run(tool, workspace, 'handout.pdf')).rejects.toThrow('path must be inside References/')
  })

  it('reports missing sandbox and subprocess services as an error', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'handout.pdf'), '%PDF')
    const tool = install(makeCtx({ workspace, services: {} }))
    await expect(run(tool, workspace)).rejects.toThrow('needs DSH sandbox and subprocess services')
  })

  it('requires a workspace-bound MAIN session', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'handout.pdf'), '%PDF')
    const tool = install(makeCtx({ workspace }))
    await expect(run(tool, workspace, 'References/handout.pdf', false)).rejects.toThrow('requires a workspace-bound MAIN session')
  })

  it('requires full DSH file-sandbox enforcement', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'handout.pdf'), '%PDF')
    const tool = install(makeCtx({ workspace, enforcement: 'none' }))
    await expect(run(tool, workspace)).rejects.toThrow('requires full DSH file-sandbox enforcement')
  })

  it('reports CLI failures with the real error instead of a bare timeout', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'handout.pdf'), '%PDF')
    const tool = install(makeCtx({
      workspace,
      spawn: () => ({
        exitCode: 1,
        stdout: 'Thinking... handout.pdf\n',
        stderr: 'Error: timeout waiting for batch abc\n',
      }),
    }))
    const result = await run(tool, workspace) as { status: string; diagnostics: string }
    expect(result.status).toBe('failed')
    expect(result.diagnostics).toContain('Error: timeout waiting for batch abc')
  })

  it('surfaces auth failures from the CLI as tool errors', async () => {
    const workspace = makeWorkspace()
    writeFileSync(join(workspace, 'References', 'auth.pdf'), '%PDF')
    const tool = install(makeCtx({
      workspace,
      spawn: () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 401, body: {"detail":"user authenticate failed"}',
      }),
    }))
    const result = await run(tool, workspace, 'References/auth.pdf') as { status: string; diagnostics: string }
    expect(result.status).toBe('failed')
    expect(result.diagnostics).toContain('user authenticate failed')
  })

  it('surfaces a real CLI error before the wrapper deadline when the server stalls', async () => {
    // Wrapper deadline must sit at CLI timeout + 30s (Python-reference parity),
    // so mineru's own `--timeout` error lands in diagnostics instead of a bare kill.
    expect(EXTRACT_TIMEOUT_MS).toBe((MINERU_TIMEOUT_SECONDS + 30) * 1000)
    expect(MINERU_TIMEOUT_SECONDS).toBe(300)
  })
})
