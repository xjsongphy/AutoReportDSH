/**
 * Validated deployment configuration for the AutoReportDSH plugin. Every
 * field is changeable from `cordis.yml`; nothing here is hardcoded per
 * deployment (the no-hardcoded-tunables rule). Validation fails loud at load.
 *
 * Provider/model execution stays in DSH; {@link Config.specialistRoute} only
 * names the route specialists request.
 * @module
 */

import z from '@deepseek-ai/schemastery'

/** Report source language for materialization and compilation. */
export type ReportLanguage = 'latex' | 'typst'

/** LaTeX engine used by `compile_report`. Tectonic requires a verified local cache. */
export type LatexEngine = 'latexmk' | 'tectonic'

/** Optional specialist model route; DSH owns credentials and execution. */
export interface SpecialistRoute {
  /** DSH provider id the specialist requests. */
  readonly provider: string
  /** Model id interpreted by the selected provider adapter. */
  readonly model: string
}

/** Plugin configuration schema (see module docs). */
export interface Config {
  /** Report source language (default `latex`). */
  reportLanguage: ReportLanguage
  /** LaTeX compiler selection (default `latexmk`). */
  latexEngine: LatexEngine
  /**
   * Python interpreter passed to report execution; absent uses the ambient
   * `PATH` resolution inside the isolated process.
   */
  pythonEnv: string | undefined
  /**
   * Experiment workspace root; absent resolves to the calling session cwd at
   * use time, never a build-time constant.
   */
  workspaceRoot: string | undefined
  /** Optional fixed model route for every specialist child. */
  specialistRoute: SpecialistRoute | undefined
  /** Bounded wait for `send_to_agent({ wait: true })` (default ten minutes). */
  executionTimeoutMs: number
}

export const Config: z<Config> = z.object({
  reportLanguage: z.union(['latex', 'typst'] as const).default('latex'),
  latexEngine: z.union(['latexmk', 'tectonic'] as const).default('latexmk'),
  pythonEnv: z.string(),
  workspaceRoot: z.string(),
  specialistRoute: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  executionTimeoutMs: z.number().default(600_000),
}) as unknown as z<Config>
