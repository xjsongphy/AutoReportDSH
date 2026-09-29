/** A Report-only compiler over fixed argv and the role's DSH process sandbox. */
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import { existingWorkspacePath, assertWorkspaceRoot, ensureOwnedDirectory } from '../workspace/path.js'
import type { ReportLanguage } from '../workspace/init.js'
import { genericCall } from './presentation.js'
import { summarizeCompileFile } from './compile-diagnostics.js'

const COMPILE_TIMEOUT_MS = 180_000
async function copyOutput(source: Readable | undefined, destination: ReturnType<typeof createWriteStream>): Promise<void> {
  if (source === undefined) return
  for await (const chunk of source) {
    if (!destination.write(chunk)) await once(destination, 'drain')
  }
}

export interface CompileReportResult {
  readonly status: 'success' | 'failed' | 'timeout' | 'infrastructure_error'
  readonly exitCode: number | null
  readonly language: ReportLanguage
  readonly pdf: string | null
  readonly log: string | null
  readonly diagnostics: string
  readonly truncated: boolean
}

/** Execute one compile request. Caller supplies the frozen report language. */
export async function compileReport(
  ctx: Context,
  agent: Agent,
  language: ReportLanguage,
  input: string,
  signal: AbortSignal,
  workspaceRootOverride?: string,
): Promise<CompileReportResult> {
  const workspace = workspaceRootOverride ?? agent.session?.header.cwd
  if (workspace === undefined) throw new Error('compile_report requires a workspace-bound REPORT session')
  const entry = existingWorkspacePath(workspace, input)
  assertWorkspaceRoot(entry, 'Report')
  const expected = language === 'latex' ? '.tex' : '.typ'
  if (extname(entry.absolute) !== expected) throw new Error(`the active ${language} report needs a ${expected} entry file`)
  if (language === 'latex' && !/^[\p{L}\p{N}._/ -]+$/u.test(entry.relative)) {
    throw new Error('LaTeX entry path contains a character latexmk cannot safely pass to XeLaTeX')
  }
  if (!statSync(entry.absolute).isFile()) throw new Error('report entry must be a regular file')

  const reportRoot = realpathSync(resolve(workspace, 'Report'))
  const buildRoot = ensureOwnedDirectory(workspace, 'Report', ['.build'])
  const log = join(buildRoot, `${randomUUID()}.log`)
  const pdf = join(dirname(entry.absolute), `${basename(entry.absolute, expected)}.pdf`)
  if (existsSync(pdf) && (lstatSync(pdf).isSymbolicLink() || !statSync(pdf).isFile())) throw new Error('PDF output must be a regular file inside Report/')
  // Typst always writes its requested output; latexmk may validly report an
  // existing PDF as up-to-date without changing its timestamp.
  const previousPdfTime = existsSync(pdf) ? statSync(pdf, { bigint: true }).mtimeNs : -1n
  const argv = language === 'typst'
    ? ['typst', 'compile', entry.absolute, pdf, '--root', realpathSync(workspace)]
    : ['latexmk', '-norc', '-pdfxe', '-pdfxelatex=xelatex -no-shell-escape %O %S', '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', basename(entry.absolute)]
  const cwd = language === 'latex' ? dirname(entry.absolute) : realpathSync(workspace)
  const sandbox = ctx.get('sandbox')
  const subprocess = ctx.get('subprocess')
  if (sandbox === undefined || subprocess === undefined) throw new Error('compile_report needs DSH sandbox and subprocess services')
  const confined = await sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: reportRoot, sessionId: agent.session.id as SessionId }, signal)
  if (confined.enforcement !== 'full') throw new Error('compile_report requires full DSH file-sandbox enforcement')
  const deadline = AbortSignal.timeout(COMPILE_TIMEOUT_MS)
  const combinedSignal = AbortSignal.any([signal, deadline])
  const stream = createWriteStream(log, { flags: 'wx' })
  let exitCode: number | null = null
  let status: CompileReportResult['status'] = 'infrastructure_error'
  let failure = ''
  try {
    const process = subprocess.spawn({
      argv: confined.argv,
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5_000,
      signal: combinedSignal,
    })
    const [outcome] = await Promise.all([
      process.done,
      copyOutput(process.stdout, stream),
      copyOutput(process.stderr, stream),
    ])
    exitCode = outcome.exitCode
    status = deadline.aborted ? 'timeout' : outcome.exitCode === 0 ? 'success' : 'failed'
  } catch (error: unknown) {
    failure = error instanceof Error ? error.message : String(error)
    status = deadline.aborted ? 'timeout' : 'infrastructure_error'
  } finally {
    stream.end()
    await finished(stream)
  }
  if (status === 'success' && (!existsSync(pdf)
    || (language === 'typst' && statSync(pdf, { bigint: true }).mtimeNs <= previousPdfTime))) {
    status = 'failed'
    failure = 'compiler exited successfully but did not produce a PDF for this build'
  }
  const summary = await summarizeCompileFile(log, language)
  const lines = summary.text.split(/\r?\n/u)
  const failedExitCode = exitCode
  const runnerFailure = failedExitCode === null || failedExitCode === 0 ? undefined : confined.runnerFailureRules?.flatMap(rule => {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(failedExitCode)) return []
    return lines.filter(line =>
      !(rule.informationalLines ?? []).some(info => info.toLowerCase() === line.trim().toLowerCase())
      && rule.fatalSignatures.some(signature => line.toLowerCase().includes(signature.toLowerCase())))
  })[0]
  if (runnerFailure !== undefined) {
    status = 'infrastructure_error'
    failure = `DSH sandbox runner failed: ${runnerFailure}`
  }
  if (status === 'failed' && failure.length === 0 && summary.text.length === 0) {
    failure = `compiler exited with code ${exitCode ?? 'unknown'} without diagnostics`
  }
  const diagnostic = [failure, summary.text].filter(Boolean).join('\n')
  const root = realpathSync(workspace)
  return {
    status,
    exitCode,
    language,
    pdf: status === 'success' ? relative(root, pdf).split(sep).join('/') : null,
    log: relative(root, log).split(sep).join('/'),
    diagnostics: diagnostic,
    truncated: summary.truncated,
  }
}

/** Report-scoped model tool; registration itself is its capability boundary. */
export function installCompileReportTool(ctx: Context, language: ReportLanguage, workspaceRootOverride?: string): () => void {
  return ctx.tools.register(defineTool({
    name: 'compile_report',
    description: 'Compile a Report/ LaTeX or Typst entry file to PDF. Pass a workspace-relative path. Returns diagnostics and a path to the complete log; read that log if more context is needed.',
    parameters: { path: { type: 'string', required: true, description: 'Report entry file relative to the experiment workspace, e.g. Report/main.tex.' } },
    timeoutMs: COMPILE_TIMEOUT_MS + 10_000,
    presentCall: args => genericCall('Compile report', args.path),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['success', 'failed', 'timeout', 'infrastructure_error'], required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          language: { type: 'string', enum: ['latex', 'typst'], required: true },
          pdf: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          log: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          diagnostics: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent as Agent | undefined
      if (agent === undefined) throw new Error('compile_report requires a REPORT agent')
      return compileReport(ctx, agent, language, args.path, exec.signal, workspaceRootOverride)
    },
  }))
}
