/**
 * Validated deployment configuration for the AutoReportDSH plugin. Every
 * field is changeable from `cordis.yml`; nothing here is hardcoded per
 * deployment (the no-hardcoded-tunables rule). Validation fails loud at load.
 *
 * These fields are plugin DEFAULTS — the lowest configurable layer of the
 * report-workflow settings chain (PLAN.md §2.14), below user settings,
 * project settings, and explicit workflow overrides. They are not live
 * workflow inputs: workflows snapshot the resolved values at creation.
 *
 * Provider/model execution stays in DSH; {@link Config.specialistModel} only
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
  /** Adapter-owned reasoning effort; absent leaves the provider default in effect. */
  readonly reasoningEffort?: string
}

/** Plugin configuration schema: DEFAULTS for the workflow settings chain (see module docs). */
export interface Config {
  /** Default report source language (schema default `latex`). */
  defaultReportLanguage: ReportLanguage
  /** Default LaTeX compiler selection (schema default `latexmk`). */
  defaultLatexEngine: LatexEngine
  /**
   * Experiment workspace root; absent resolves to the calling session cwd at
   * use time, never a build-time constant.
   */
  workspaceRoot: string | undefined
  /** Default fixed model route for every specialist child; absent inherits Main. */
  specialistModel: SpecialistRoute | undefined
  /** Default bounded wait for `send_to_agent({ wait: true })` (default ten minutes). */
  executionTimeoutMs: number
}

export const Config: z<Config> = z.object({
  defaultReportLanguage: z.union(['latex', 'typst'] as const).default('latex'),
  defaultLatexEngine: z.union(['latexmk', 'tectonic'] as const).default('latexmk'),
  workspaceRoot: z.string(),
  specialistModel: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
  }),
  executionTimeoutMs: z.number().default(600_000),
}) as unknown as z<Config>
