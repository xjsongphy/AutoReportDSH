/** Main-only PDF extraction without a general shell. */
import { extname, join, parse, relative, sep } from 'node:path'
import { statSync, realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import { assertWorkspaceRoot, ensureOwnedDirectory, existingWorkspacePath } from '../workspace/path.js'
import { genericCall } from './presentation.js'
import type AutoReportWorkflowRuntime from '../runtime.js'

/** CLI-side extraction timeout in seconds, matching the Python reference's default. */
export const MINERU_TIMEOUT_SECONDS = 300
/** Wrapper deadline: the CLI's own --timeout fires first so its error lands in diagnostics. */
export const EXTRACT_TIMEOUT_MS = (MINERU_TIMEOUT_SECONDS + 30) * 1000

export function installReferenceExtractTool(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'extract_pdf',
    description: 'When read cannot parse a needed References/ PDF, extract it into readable files under Outline/.cache/mineru/. Pass the workspace-relative PDF path; after success, read the produced markdown. Report missing credentials or extraction failure as a blocker without inventing PDF content.',
    parameters: { path: { type: 'string', required: true, description: 'PDF path relative to the experiment workspace, e.g. References/handout.pdf.' } },
    timeoutMs: EXTRACT_TIMEOUT_MS + 10_000,
    presentCall: args => genericCall('Extract reference PDF', args.path),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent as Agent | undefined
      const runtime = ctx.get('autoreportWorkflow') as AutoReportWorkflowRuntime | undefined
      const workspace = runtime?.config.workspaceRoot ?? agent?.session?.header.cwd
      if (workspace === undefined || agent === undefined) throw new Error('extract_pdf requires a workspace-bound MAIN session')
      const source = existingWorkspacePath(workspace, args.path)
      assertWorkspaceRoot(source, 'References')
      if (extname(source.absolute).toLowerCase() !== '.pdf' || !statSync(source.absolute).isFile()) {
        throw new Error('extract_pdf expects a PDF file under References/')
      }
      const stem = parse(source.absolute).name.replace(/[<>:"\\|?*\u0000-\u001F]/gu, '_').trim() || 'reference'
      const output = ensureOwnedDirectory(workspace, 'Outline', ['.cache', 'mineru', stem])
      const sandbox = ctx.get('sandbox')
      const subprocess = ctx.get('subprocess')
      if (sandbox === undefined || subprocess === undefined) throw new Error('extract_pdf needs DSH sandbox and subprocess services')
      const confined = await sandbox.confine(
        ['mineru-open-api', 'extract', source.absolute, '--timeout', String(MINERU_TIMEOUT_SECONDS), '-o', output],
        { mode: 'workspace-write', workspaceRoot: realpathSync(join(workspace, 'Outline')), sessionId: agent.session.id as SessionId },
        exec.signal,
      )
      if (confined.enforcement !== 'full') throw new Error('extract_pdf requires full DSH file-sandbox enforcement')
      const deadline = AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
      const signal = AbortSignal.any([exec.signal, deadline])
      const process = subprocess.spawn({
        argv: confined.argv,
        cwd: realpathSync(workspace),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32_000 }, stderr: { maxBytes: 32_000 } },
        graceMs: 5_000,
        signal,
      })
      const outcome = await process.done
      const diagnostics = [process.collected.stdout?.readFrom(0).text, process.collected.stderr?.readFrom(0).text]
        .filter(Boolean).join('\n').slice(0, 32_000)
      return {
        status: deadline.aborted ? 'timeout' : outcome.exitCode === 0 ? 'success' : 'failed',
        exitCode: outcome.exitCode,
        outputDir: relative(realpathSync(workspace), output).split(sep).join('/'),
        diagnostics,
      }
    },
  }))
}
