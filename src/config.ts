/**
 * Validated deployment configuration for the AutoReportDSH plugin. Every
 * field is changeable from `cordis.yml`; nothing here is hardcoded per
 * deployment (the no-hardcoded-tunables rule). Validation fails loud at load.
 *
 * These fields are plugin DEFAULTS — the lowest configurable layer of the
 * report-workflow settings chain (PLAN.md §2.14), below user settings and
 * explicit workflow overrides. They are not live
 * workflow inputs: workflows snapshot the resolved values at creation.
 *
 * Provider/model execution stays in DSH; {@link Config.specialistModel} only
 * names the route specialists request.
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { AUTO_REPORT_USER_SETTINGS_SCHEMA, type AutoReportUserSettings } from './settings.js'
import { detectPythonEnvironments } from './python-detect.js'
import { detectMineruStatus } from './mineru-status.js'

/** Report source language for materialization and compilation. */
export type ReportLanguage = 'latex' | 'typst'

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
  workspaceLanguages?: AutoReportUserSettings['workspaceLanguages']
  pythonEnvironments?: AutoReportUserSettings['pythonEnvironments']
  mineruStatus?: AutoReportUserSettings['mineruStatus']
  /** Default report source language (schema default `latex`). */
  defaultReportLanguage: ReportLanguage
  /**
   * Experiment workspace root; absent resolves to the calling session cwd at
   * use time, never a build-time constant.
   */
  workspaceRoot: string | undefined
  /** Default fixed model route for every specialist child; absent inherits Main. */
  specialistModel: SpecialistRoute | undefined
  /**
   * Default absolute wait for `send_to_agent({ wait: true })` (default ten
   * minutes). Kept under its original name so existing composition settings
   * remain valid; it is the hard, not no-progress, deadline.
   */
  delegationWaitTimeoutMs: number
  /** Default no-progress wait while a delegated child is idle (default one minute). */
  delegationIdleTimeoutMs: number
  /** Optional absolute Python interpreter path for specialist bash execution. */
  pythonExecutable?: string
}

export const Config: z<Config> = z.object({
  ...Object.fromEntries(Object.entries(AUTO_REPORT_USER_SETTINGS_SCHEMA.dict!).map(([key, field]) => [key, field.volatile()])),
  pythonEnvironments: z.array(z.object({ label: z.string(), executable: z.string(), source: z.string(), version: z.string() })).default(detectPythonEnvironments()).volatile(),
  mineruStatus: z.object({ installed: z.boolean(), tokenConfigured: z.boolean(), tokenSource: z.union(['environment', 'config']) }).default(detectMineruStatus()).volatile(),
  workspaceRoot: z.string(),

}) as unknown as z<Config>

/** Keep volatile configuration references live while exposing domain values. */
export function liveConfig(input: Partial<Config>): Partial<Config> {
  return Object.defineProperties({}, Object.fromEntries(Object.keys(input).map(key => [key, {
    enumerable: true,
    get: () => { const value: unknown = Reflect.get(input, key); return isVolatile(value) ? value.get() : value },
  }]))) as Partial<Config>
}
