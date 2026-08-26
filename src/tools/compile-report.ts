/**
 * REPORT-only report compilation over the shared isolated runner (PLAN.md
 * §2.12). One tool compiles the active LaTeX/Typst source under the caller's
 * role policy; Tectonic is refused unless a verified local bundle cache
 * exists, because no compiler may widen network policy.
 *
 * Every capability is injected: role resolution (same mechanism as the role
 * guard), the shared {@link runIsolated} execution path, pre-filtered file
 * listing for change detection, and artifact persistence. This module owns
 * compilation semantics only — no artifact policy, manifest projection, or
 * host wiring.
 * @module
 */

import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { defineTool, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Config, LatexEngine, ReportLanguage } from '../config.js'
import type { WorkflowSettingsSnapshot } from '../settings.js'

const LOG_TAIL_BYTES = 8_192

/** Fully injected dependencies for one compile_report registration. */
export interface CompileReportDependencies {
  /** Composition defaults (lowest configurable layer). */
  readonly config: Pick<Config, 'defaultReportLanguage' | 'defaultLatexEngine'>
  /**
   * Durable workflow-settings snapshot from the owning `autoreport/workflow`
   * event; when present it outranks `config`, which applies only for logs
   * written before snapshots existed.
   */
  readonly settings?: Pick<WorkflowSettingsSnapshot, 'reportLanguage' | 'latexEngine'>
  /**
   * Resolve the calling agent through the SAME mechanism as the role guard.
   * Returns the REPORT caller's session id plus absolute workspace root, or
   * throws/denies for every other role.
   */
  readonly resolveCallerRole: (exec: Readonly<ToolExecution>) => { sessionId: string; workspaceRoot: string }
  /** The shared isolated runner factored out of report-exec. */
  readonly runner: (request: {
    argv: readonly string[]
    cwd: string
    readableRoots: readonly string[]
    writableRoots: readonly string[]
    externalSignal: AbortSignal
    timeoutMs: number
  }) => Promise<{ exit_code: number | null; stdout: string; stderr: string; timed_out: boolean }>
  /** List files under one absolute directory with artifact filtering applied. */
  readonly listFilesFiltered: (root: string) => readonly string[]
  /** Persist one process-originated artifact snapshot. */
  readonly commitArtifact: (snapshot: {
    readonly path: string
    readonly status: 'created' | 'modified'
    readonly producedBy: 'REPORT'
    readonly origin: 'process'
    readonly recordedAt: number
  }) => void
}

interface CompilationPlan {
  readonly engine: LatexEngine | 'typst'
  readonly entry: string
  readonly argv: readonly string[]
  readonly artifactBasename: string
}

function defaultEntry(language: ReportLanguage): string {
  return language === 'latex' ? 'main.tex' : 'main.typ'
}

function tectonicCacheDir(): string | undefined {
  const fromEnv = process.env['AUTOREPORT_TECTONIC_CACHE'] ?? process.env['TECTONIC_CACHE']
  return fromEnv !== undefined && existsSync(fromEnv) ? fromEnv : undefined
}

function plan(engine: LatexEngine | 'typst', entry: string): CompilationPlan {
  const base = basename(entry, extname(entry))
  switch (engine) {
    case 'latexmk':
      // -cd follows the entry into its directory; nonstop + halt-on-error
      // yields machine-parsable logs without hanging on prompts.
      return { engine, entry, argv: ['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-cd', entry], artifactBasename: `${base}.pdf` }
    case 'tectonic':
      return { engine, entry, argv: ['tectonic', entry], artifactBasename: `${base}.pdf` }
    case 'typst':
      return { engine, entry, argv: ['typst', 'compile', entry, `${base}.pdf`], artifactBasename: `${base}.pdf` }
  }
}

function boundedTimeout(raw: number | undefined): number {
  if (raw === undefined) return 600_000
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 3_600_000) {
    throw new Error('compile_report timeout_ms must be an integer between 1 and 3600000')
  }
  return raw
}

/**
 * Create the REPORT-only `compile_report` tool over fully injected deps.
 * @param deps - configuration, caller resolution, runner, filtered listing,
 *   and artifact persistence.
 * @returns model-facing tool definition.
 */
export function createCompileReportTool(deps: CompileReportDependencies): ToolDefinition {
  return defineTool({
    name: 'compile_report',
    description:
      'Compile Report/<entry> into a PDF with the configured engine under mandatory network denial. '
      + 'REPORT role only.',
    parameters: {
      engine: {
        type: 'string',
        enum: ['latexmk', 'tectonic', 'typst'],
        description: 'Override the compiler once; defaults follow the resolved workflow settings.',
      },
      entry: { type: 'string', description: "Source file under Report/ (default 'main.tex'/'main.typ')." },
      timeout_ms: { type: 'integer', description: 'Compilation deadline in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          engine: { type: 'string', required: true },
          artifact_path: { type: 'string', required: true },
          log_tail: { type: 'string', required: true },
          duration_ms: { type: 'integer', required: true },
          timed_out: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const started = Date.now()
      const caller = deps.resolveCallerRole(exec)

      // Snapshot first; composition config is the fallback ONLY when the
      // workflow event carries no settings snapshot (pre-layering logs).
      const configuredLanguage: ReportLanguage = deps.settings?.reportLanguage ?? deps.config.defaultReportLanguage
      const configuredEngine: LatexEngine = deps.settings?.latexEngine ?? deps.config.defaultLatexEngine
      const effectiveLanguage: ReportLanguage = args.engine === 'typst'
        ? 'typst'
        : args.engine === 'latexmk' || args.engine === 'tectonic'
          ? 'latex'
          : configuredLanguage
      const engine = args.engine ?? (configuredLanguage === 'latex' ? configuredEngine : 'typst')

      if (engine === 'tectonic') {
        if (tectonicCacheDir() === undefined) {
          throw new Error(
            'AutoReport refuses tectonic without a verified local bundle cache: set AUTOREPORT_TECTONIC_CACHE '
            + '(or TECTONIC_CACHE) to an existing bundle/cache directory. Compilation must never widen network policy.',
          )
        }
      }

      const entry = args.entry ?? defaultEntry(effectiveLanguage)
      const compilation = plan(engine, entry)
      const reportDir = `${caller.workspaceRoot}/Report`
      const before = new Set(deps.listFilesFiltered(reportDir))

      const outcome = await deps.runner({
        argv: compilation.argv,
        cwd: reportDir,
        readableRoots: [caller.workspaceRoot],
        writableRoots: [reportDir],
        externalSignal: exec.signal,
        timeoutMs: boundedTimeout(args.timeout_ms),
      })

      const logTail = `${outcome.stdout}\n${outcome.stderr}`.slice(-LOG_TAIL_BYTES)
      const ok = outcome.exit_code === 0
      if (ok) {
        for (const path of deps.listFilesFiltered(reportDir)) {
          if (!before.has(path)) {
            deps.commitArtifact({ path, status: 'created', producedBy: 'REPORT', origin: 'process', recordedAt: Date.now() })
          }
        }
      }
      return {
        ok,
        engine: compilation.engine,
        artifact_path: join('Report', compilation.artifactBasename),
        log_tail: logTail,
        duration_ms: Date.now() - started,
        timed_out: outcome.timed_out,
      }
    },
    presentCall: args => ({
      card: 'terminal',
      title: `compile_report ${String(args['engine'] ?? '')}`.trim(),
    }),
  })
}
