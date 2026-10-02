/** Render one compiled report page for DSH's PNG-only read_image tool. */
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertWorkspaceRoot, ensureOwnedDirectory, existingWorkspacePath } from '../workspace/path.js'
import { genericCall } from './presentation.js'

const RENDER_TIMEOUT_MS = 60_000

/** Shape of the `llm` service this tool needs; the runtime owns the real type. */
interface RouteLlm {
  resolveModelInfo?: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<{ inputModalities?: readonly string[] }>
}

/**
 * Refuse to render for a route that cannot inspect the result.
 *
 * The same gate DSH's `read_image` enforces, applied to this tool: a rendered
 * page is useful only when the exact calling route can look at it, so an
 * unknown or text-only capability refuses before any filesystem work instead
 * of after it. The tool stays registered for every model — the refusal is what
 * tells a text-only model to switch.
 * @param ctx - the plugin context used to resolve the `llm` service.
 * @param route - the calling agent's resolved provider/model.
 * @param signal - the execution's abort signal.
 * @param requestedPath - the raw, not-yet-resolved path named in refusals.
 */
async function assertImageCapableRoute(
  ctx: Context,
  route: { provider?: string | undefined; model?: string | undefined } | undefined,
  signal: AbortSignal | undefined,
  requestedPath: string,
): Promise<void> {
  const llm = ctx.get('llm') as RouteLlm | undefined
  if (route?.provider === undefined || route.model === undefined || llm?.resolveModelInfo === undefined) {
    throw new Error(`cannot render "${requestedPath}" as a page preview: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(route.provider, route.model, signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot render "${requestedPath}" as a page preview: model "${route.model}" does not declare image input;`
      + ' switch to an image-capable model to inspect rendered pages',
    )
  }
}

export async function renderReportPage(
  ctx: Context,
  agent: Agent,
  input: string,
  page: number,
  signal: AbortSignal,
  workspaceRootOverride?: string,
): Promise<{ status: 'success' | 'failed' | 'timeout'; page: number; image: string | null; diagnostics: string }> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new Error('page must be an integer from 1 to 10000')
  const workspace = workspaceRootOverride ?? agent.session?.header.cwd
  if (workspace === undefined) throw new Error('render_report_page requires a workspace-bound REPORT session')
  const pdf = existingWorkspacePath(workspace, input)
  assertWorkspaceRoot(pdf, 'Report')
  if (extname(pdf.absolute).toLowerCase() !== '.pdf' || !statSync(pdf.absolute).isFile()) {
    throw new Error('render_report_page expects a Report/ PDF file')
  }
  const previewDir = ensureOwnedDirectory(workspace, 'Report', ['.cache', 'preview'])
  const prefix = join(previewDir, randomUUID())
  const image = `${prefix}.png`
  const sandbox = ctx.get('sandbox')
  const subprocess = ctx.get('subprocess')
  if (sandbox === undefined || subprocess === undefined) throw new Error('render_report_page needs DSH sandbox and subprocess services')
  const deadline = AbortSignal.timeout(RENDER_TIMEOUT_MS)
  const combinedSignal = AbortSignal.any([signal, deadline])
  const confined = await sandbox.confine(
    ['pdftoppm', '-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', '120', pdf.absolute, prefix],
    { mode: 'workspace-write', workspaceRoot: ensureOwnedDirectory(workspace, 'Report', []), sessionId: agent.session.id as SessionId },
    combinedSignal,
  )
  if (confined.enforcement !== 'full') throw new Error('render_report_page requires full DSH file-sandbox enforcement')
  const handle = subprocess.spawn({
    argv: confined.argv,
    cwd: workspace,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 16_384 } },
    graceMs: 5_000,
    signal: combinedSignal,
  })
  const outcome = await handle.done
  const status = deadline.aborted ? 'timeout' : outcome.exitCode === 0 && existsSync(image) ? 'success' : 'failed'
  const diagnostics = [handle.collected.stdout?.readFrom(0).text, handle.collected.stderr?.readFrom(0).text]
    .filter(Boolean).join('\n').slice(0, 16_384)
  return {
    status,
    page,
    image: status === 'success' ? relative(realpathSync(workspace), image).split(sep).join('/') : null,
    diagnostics: diagnostics || (status === 'failed' ? 'PDF page renderer did not produce a PNG' : ''),
  }
}

/** A narrow Report-only page-rendering capability for visual inspection. */
export function installRenderReportPageTool(ctx: Context, workspaceRootOverride?: string): () => void {
  return ctx.tools.register(defineTool({
    name: 'render_report_page',
    description: 'Render one page of a Report/ PDF as a PNG under Report/.cache/preview/. Pass a workspace-relative PDF path and 1-based page number, then use read_image on the returned image path. Requires pdftoppm and an image-capable model for visual inspection.',
    parameters: {
      path: { type: 'string', required: true, description: 'PDF path relative to the experiment workspace, e.g. Report/main.pdf.' },
      page: { type: 'number', required: true, description: '1-based page number to inspect.' },
    },
    timeoutMs: RENDER_TIMEOUT_MS + 10_000,
    presentCall: args => genericCall('Render report page', `${args.path} page ${args.page}`),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['success', 'failed', 'timeout'], required: true },
          page: { type: 'integer', required: true },
          image: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          diagnostics: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent as Agent | undefined
      if (agent === undefined) throw new Error('render_report_page requires a REPORT agent')
      const routed = agent.session?.requestHeader()?.config
      await assertImageCapableRoute(
        ctx,
        { provider: routed?.provider ?? agent.options?.provider, model: routed?.model ?? agent.options?.model },
        exec.signal,
        args.path,
      )
      return renderReportPage(ctx, agent, args.path, args.page, exec.signal, workspaceRootOverride)
    },
  }))
}
