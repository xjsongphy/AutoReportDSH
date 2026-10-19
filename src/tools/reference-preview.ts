/** Original-page fallback after a real MinerU extraction attempt. */
import { readdirSync, statSync } from 'node:fs'
import { parse, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { resolvePythonExecutable } from '../python-env.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { assertImageCapableRoute, renderWorkspacePdfPage } from './render-report-page.js'

/** Same sibling directory naming convention as extract_pdf. */
export function referenceExtractionDirectory(pdf: string): string {
  const source = parse(pdf)
  const stem = source.name.replace(/[<>:"\\|?*\u0000-\u001F]/gu, '_').trim() || 'reference'
  return join(source.dir, stem)
}

export function hasMineruAttempt(agent: Agent, path: string, pdf: string): boolean {
  try {
    // Existing extraction output is reusable across sessions; source PDFs stay intact.
    const dir = referenceExtractionDirectory(pdf)
    if (readdirSync(dir).some(name => name.endsWith('.md') && statSync(join(dir, name)).isFile())) return true
  } catch { /* A failed extraction may have produced no markdown. */ }
  const calls = new Set<string>()
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'tool/call' && event.data.name === 'extract_pdf') {
      try {
        const args = JSON.parse(event.data.arguments) as { path?: unknown; page?: unknown }
        if (args.path === path && args.page === undefined) calls.add(event.data.callId)
      } catch { /* Malformed calls are not extraction evidence. */ }
    }
    if (event.type === 'tool/result' && calls.has(event.data.message.toolCallId)) {
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue
        try {
          const result = JSON.parse(block.text) as { status?: string }
          if (['success', 'failed', 'timeout'].includes(result.status ?? '')) return true
        } catch { /* A dispatch error is not an extraction attempt. */ }
      }
    }
  }
  return false
}

// Fixed code, separate argv values: neither the path nor page becomes Python source.
const PAGE_SCRIPT = `import sys
try:
 import pymupdf
except ImportError:
 sys.stderr.write("Missing Python package pymupdf; MAIN can use install_python_package for the selected environment.")
 sys.exit(2)
with pymupdf.open(sys.argv[1]) as doc:
 index=int(sys.argv[2])-1
 if not 0 <= index < len(doc): raise ValueError("page is outside this PDF")
 page=doc[index]
 scale=min(120/72,2000/max(page.rect.width,page.rect.height))
 page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False).save(sys.argv[3])
`

export async function previewReferencePage(
  ctx: Context, agent: Agent, runtime: AutoReportWorkflowRuntime | undefined,
  workspace: string, path: string, pdf: string, page: number, issue: string,
  signal: AbortSignal,
) {
  if (issue.trim().length < 8 || issue.length > 2000) throw new Error('extraction_issue must explain the specific MinerU recognition gap (8–2000 characters)')
  if (!hasMineruAttempt(agent, path, pdf)) throw new Error('Use MinerU extraction first. Page preview is only a fallback for failed or insufficient extraction, not a replacement for extract_pdf.')
  const route = agent.session.requestHeader()?.config
  await assertImageCapableRoute(ctx, { provider: route?.provider ?? agent.options?.provider, model: route?.model ?? agent.options?.model }, signal, path)
  const python = resolvePythonExecutable({ ownsSession: () => true,
    snapshotPythonExecutable: session => runtime?.projectionFor(String(session.id))?.meta?.settings?.pythonExecutable,
  }, agent.session)
  return renderWorkspacePdfPage(ctx, agent, path, page, signal, workspace, {
    source: 'References', output: 'Outline',
    argv: (source, image) => [python, '-c', PAGE_SCRIPT, source, String(page), image],
  })
}
