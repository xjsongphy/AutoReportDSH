/**
 * Report-workflow settings layering (PLAN.md §2.14). AutoReport owns ONLY
 * report-policy settings; DSH keeps providers, credentials, Main model
 * selection, compaction, approvals, sandbox/shell, session lifecycle, and UI
 * preferences. Resolution applies one fixed precedence chain per field:
 *
 * ```text
 * explicit workflow override (internal only; no v1 user surface)
 *         ↓
 * AutoReport user settings (DSH settings namespace 'autoreport')
 *         ↓
 * Cordis composition Config (plugin defaults)
 *         ↓
 * schema defaults
 * ```
 *
 * {@link resolveWorkflowSettings} freezes the resulting
 * {@link WorkflowSettingsSnapshot}, which is committed once per workflow on
 * the durable `autoreport/workflow` event; execution reads the snapshot, so
 * later settings changes never mutate an in-flight report.
 *
 * The user layer arrives through DSH's settings service (namespace
 * `'autoreport'`, registered by the workflow runtime with
 * `installSettingsSection`). Callers may still supply plain data for pure
 * resolution tests and one-off integrations.
 * @module
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Config, ReportLanguage, SpecialistRoute } from './config.js'
import {
  ensureManagedPython,
  invalidCustomPythonPath,
  isManagedPythonSetting,
  type PythonCandidate,
} from './python-detect.js'
import type { MineruStatus } from './client/mineru-status-types.js'

/** Schema-default workflow policy applied below every other layer. */
export const WORKFLOW_SETTINGS_SCHEMA_DEFAULTS: Readonly<{
  reportLanguage: ReportLanguage
  delegationIdleTimeoutMs: number
  delegationWaitTimeoutMs: number
}> = Object.freeze({
  reportLanguage: 'latex',
  delegationIdleTimeoutMs: 60_000,
  delegationWaitTimeoutMs: 600_000,
})

/** Registered DSH namespace for AutoReport's user-level workflow defaults. */
export const AUTOREPORT_SETTINGS_NAMESPACE = 'autoreport' as SettingsNamespace

export interface AutoReportUserSettings {
  /** Default report source language (schema default `latex`). */
  defaultReportLanguage: ReportLanguage
  /** Per-workspace report language keyed by the absolute workspace root. */
  workspaceLanguages: Readonly<Record<string, ReportLanguage>>
  /** No-progress timeout while a `wait: true` child is idle (schema default one minute). */
  delegationIdleTimeoutMs: number
  /** Absolute `wait: true` cap (schema default ten minutes). */
  delegationWaitTimeoutMs: number
  /** Optional specialist route; absent inherits the Main route. */
  specialistModel?: SpecialistRoute
  /** Optional Python: `__managed__`, an absolute interpreter, or unset (PATH python3). */
  pythonExecutable?: string
  /**
   * Host-detected interpreters offered by the settings card. Composition-only:
   * the card never writes this field.
   */
  pythonEnvironments?: readonly PythonEnvironmentOption[]
  /** Host-detected MinerU CLI/auth state; composition-only, never written by the card. */
  mineruStatus?: MineruStatus
}

/** One detected interpreter published on the composition settings layer. */
export interface PythonEnvironmentOption {
  readonly label: string
  readonly executable: string
  readonly source: string
  readonly version: string
}

/**
 * Route schema shared by every layer's document validation. Fields stay
 * optional AT DOCUMENT LEVEL because schemastery materializes an absent
 * nested object as `{}` and would otherwise reject every section without a
 * route; {@link routeField} enforces complete routes at resolution time.
 */
const SPECIALIST_ROUTE_SCHEMA = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

/** Schemastery schema resolving the `'autoreport'` user-settings namespace standalone. */
const PYTHON_ENVIRONMENT_SCHEMA = z.object({
  label: z.string(),
  executable: z.string(),
  source: z.string(),
  version: z.string(),
})

const MINERU_STATUS_SCHEMA = z.object({
  installed: z.boolean().default(false),
  tokenConfigured: z.boolean().default(false),
  tokenSource: z.union(['environment', 'config']),
})

/** Schemastery schema resolving the `'autoreport'` user-settings namespace standalone. */
export const AUTO_REPORT_USER_SETTINGS_SCHEMA: z<AutoReportUserSettings> = z.object({
  defaultReportLanguage: z.union(['latex', 'typst'] as const).default(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.reportLanguage),
  workspaceLanguages: z.dict(z.union(['latex', 'typst'] as const)).default({}),
  specialistModel: SPECIALIST_ROUTE_SCHEMA,
  delegationIdleTimeoutMs: z.number().default(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationIdleTimeoutMs),
  delegationWaitTimeoutMs: z.number().default(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationWaitTimeoutMs),
  pythonExecutable: z.string(),
  pythonEnvironments: z.array(PYTHON_ENVIRONMENT_SCHEMA).default([]),
  mineruStatus: MINERU_STATUS_SCHEMA,
}) as unknown as z<AutoReportUserSettings>

/**
 * Resolve the child `agentOptions` from the durable settings snapshot,
 * falling back to composition defaults ONLY when no snapshot is on the
 * workflow event. `{ inheritMain: true }` passes no route so DSH gives the
 * child the Main selection. DSH's `AgentOptions` surface carries provider and
 * model only, which seeds the child descriptor; the global AutoReport child
 * setup router applies the complete snapshot selection (including reasoning
 * effort) through DSH's scoped `installModelSelection()` seam before the child
 * is published.
 *
 * Both child-creation paths resolve their route HERE. The resident path once
 * read the live user settings instead, and the section schema materializes an
 * absent `specialistModel` as `{}`: that empty object is truthy, so it went on
 * as `{ provider: undefined, model: undefined }`, and DSH spreads a requested
 * route AFTER the inherited one — the explicit undefineds wiped Main's route
 * and every resident child died on its first step with `has no provider/model`.
 * @param snapshot - frozen workflow settings, or undefined before one exists.
 * @param fallbackRoute - composition default route.
 * @returns the route to request, or undefined to inherit Main.
 */
export function childAgentOptions(
  snapshot: WorkflowSettingsSnapshot | undefined,
  fallbackRoute: Config['specialistModel'],
): { provider: string; model: string } | undefined {
  const selection = snapshot?.specialistModel
  if (selection !== undefined) {
    return selection.inheritMain ? undefined : { provider: selection.provider, model: selection.model }
  }
  return fallbackRoute === undefined ? undefined : { provider: fallbackRoute.provider, model: fallbackRoute.model }
}

/** Convert composition defaults into the base layer for DSH user settings. */
export function autoReportUserSettingsBase(
  config: Config,
  environments: readonly PythonCandidate[] = [],
  mineruStatus?: MineruStatus,
): AutoReportUserSettings {
  return {
    defaultReportLanguage: config.defaultReportLanguage,
    workspaceLanguages: {},
    delegationIdleTimeoutMs: config.delegationIdleTimeoutMs,
    delegationWaitTimeoutMs: config.delegationWaitTimeoutMs,
    ...(config.specialistModel === undefined ? {} : { specialistModel: config.specialistModel }),
    ...(config.pythonExecutable === undefined ? {} : { pythonExecutable: config.pythonExecutable }),
    pythonEnvironments: environments.map(asEnvironmentOption),
    ...(mineruStatus === undefined ? {} : { mineruStatus }),
  }
}

/** Reject a typed interpreter that is not a detected row and not a runnable Python. */
export function validatePythonExecutableSetting(
  value: AutoReportUserSettings,
  dshHome?: string,
  env?: NodeJS.ProcessEnv,
): void {
  const executable = value.pythonExecutable
  if (executable === undefined || executable.trim().length === 0) return
  if (isManagedPythonSetting(executable)) {
    try {
      ensureManagedPython({
        dshHome: dshHome ?? resolveDshHome(),
        ...(env === undefined ? {} : { env }),
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`AutoReport settings pythonExecutable: ${message}`)
    }
    return
  }
  const detected = new Set((value.pythonEnvironments ?? []).map(option => option.executable))
  if (detected.has(executable)) return
  const reason = invalidCustomPythonPath(executable)
  if (reason !== undefined) throw new Error(`AutoReport settings pythonExecutable: ${reason}`)
}

function asEnvironmentOption(candidate: PythonCandidate): PythonEnvironmentOption {
  return {
    label: `${candidate.label} · ${candidate.version}`,
    executable: candidate.executable,
    source: candidate.source,
    version: candidate.version,
  }
}

/**
 * Schemastery materializes nested object fields as `{}` even when the input
 * omits them. An empty route object means ABSENT everywhere it can enter:
 * settings schemas may materialize it and {@link routeField} reads it as no
 * configuration, so the artifact never becomes a phantom route.
 */
function isEmptyRoute(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

/** Composition-layer fields that act as plugin DEFAULTS (see {@link Config}). */
export type WorkflowCompositionDefaults = Pick<
  Config,
  'defaultReportLanguage' | 'specialistModel' | 'delegationIdleTimeoutMs' | 'delegationWaitTimeoutMs' | 'pythonExecutable'
>

/** Explicit per-workflow inputs; highest layer, owned by the creating turn. */
export interface WorkflowSettingsOverride {
  reportLanguage?: ReportLanguage
  delegationIdleTimeoutMs?: number
  delegationWaitTimeoutMs?: number
  pythonExecutable?: string
  /**
   * Concrete `{ provider, model, reasoningEffort? }` route shorthand or the
   * explicit `{ inheritMain: true }` selection recorded verbatim.
   */
  specialistModel?: SpecialistRoute | SpecialistModelSelection
}

/**
 * Resolved specialist-model binding recorded in snapshots: either a concrete
 * DSH route or an EXPLICIT inherit-from-Main marker, so recovery can tell
 * "user chose Main" apart from "nothing was configured".
 */
export type SpecialistModelSelection =
  | { readonly inheritMain: true }
  | {
    readonly inheritMain: false
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }

/** Immutable effective policy committed once on `autoreport/workflow`. */
export interface WorkflowSettingsSnapshot {
  /** Resolved report source language. */
  readonly reportLanguage: ReportLanguage
  /** Concrete specialist route or explicit Main inheritance. */
  readonly specialistModel: SpecialistModelSelection
  /** No-progress wait applied while a delegated child is idle. */
  readonly delegationIdleTimeoutMs: number
  /** Absolute cap applied to delegation waits. */
  readonly delegationWaitTimeoutMs: number
  /** Resolved Python interpreter when configured at any layer. */
  readonly pythonExecutable?: string
}

/** Input layers for {@link resolveWorkflowSettings}; every layer may be absent. */
export interface WorkflowSettingsLayers {
  /** User namespace section (`'autoreport'`); sparse patches are fine. */
  readonly user?: Partial<AutoReportUserSettings> | undefined
  /** Plugin composition defaults ({@link Config} minus `workspaceRoot`). */
  readonly composition?: Partial<WorkflowCompositionDefaults> | undefined
  /** Explicit workflow inputs; beats everything. */
  readonly override?: Partial<WorkflowSettingsOverride> | undefined
  /** Absolute workspace root this resolution is for; absent skips the per-workspace layer. */
  readonly workspaceRoot?: string
  /** DSH home used to materialize `__managed__`; absent uses {@link resolveDshHome}. */
  readonly dshHome?: string
  /** Env overlay for managed-venv creation (tests isolate PATH). */
  readonly pythonEnv?: NodeJS.ProcessEnv
}

/** Recursively freeze a resolved snapshot so handed-out values stay immutable. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  return Object.freeze(value)
}

function enumField<T extends string>(name: string, value: T | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`AutoReport settings ${name} must be one of ${allowed.join('|')}`)
  }
  return value
}

function positiveIntegerField(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`AutoReport settings ${name} must be a positive integer`)
  }
  return value
}

function routeField(
  name: string,
  candidate: SpecialistRoute | SpecialistModelSelection | undefined,
): SpecialistModelSelection | undefined {
  if (candidate === undefined) return undefined
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(`AutoReport settings ${name} must be an object`)
  }
  if (isEmptyRoute(candidate)) return undefined
  const hasProvider = 'provider' in candidate || 'model' in candidate
  if (!hasProvider) {
    if ((candidate as SpecialistModelSelection).inheritMain === true) {
      return deepFreeze({ inheritMain: true })
    }
    throw new Error(`AutoReport settings ${name} requires a provider/model route or { inheritMain: true }`)
  }
  const route = candidate as SpecialistRoute
  if (typeof route.provider !== 'string' || route.provider.length === 0 || typeof route.model !== 'string' || route.model.length === 0) {
    throw new Error(`AutoReport settings ${name} requires non-empty provider and model strings`)
  }
  return deepFreeze({
    inheritMain: false,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  })
}

const REPORT_LANGUAGES: readonly ReportLanguage[] = ['latex', 'typst']

/** Stable opaque workspace key used by the separate workflow-log store. */
export function workspaceIdForRoot(workspaceRoot: string): string {
  const root = resolve(workspaceRoot)
  if (root.length === 0) throw new Error('autoreport workspace id requires a non-empty workspace root')
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

function firstDefined<T>(...values: readonly T[]): T | undefined {
  return values.find(value => value !== undefined)
}

/**
 * Map `__managed__` to a real interpreter, creating `$dshHome/autoreport/venv`
 * when that sentinel is selected. Absolute paths pass through.
 */
function materializePythonExecutable(
  raw: string | undefined,
  dshHome: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  if (!isManagedPythonSetting(raw)) return raw
  return ensureManagedPython({
    dshHome: dshHome ?? resolveDshHome(),
    ...(env === undefined ? {} : { env }),
  })
}

/**
 * Resolve the full precedence chain into one immutable snapshot. Fields are
 * independent: a higher layer that omits a field defers to lower layers for
 * that field only.
 * @param layers - user/composition/override inputs, all optional.
 * @returns deep-frozen {@link WorkflowSettingsSnapshot}.
 */
export function resolveWorkflowSettings(layers: WorkflowSettingsLayers): WorkflowSettingsSnapshot {
  const { user, composition, override } = layers
  // The per-workspace layer is skipped when the caller has no root: a
  // resolution that cannot name its workspace cannot consult the map, and
  // silently matching a different workspace's entry would be worse than
  // falling through.
  const workspaceLanguage = layers.workspaceRoot === undefined
    ? undefined
    : enumField(
        'workspaceLanguage',
        user?.workspaceLanguages?.[resolve(layers.workspaceRoot)],
        REPORT_LANGUAGES,
      )
  const reportLanguage = enumField(
    'reportLanguage',
    firstDefined(
      override?.reportLanguage,
      workspaceLanguage,
      user?.defaultReportLanguage,
      composition?.defaultReportLanguage,
    ),
    REPORT_LANGUAGES,
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.reportLanguage
  const delegationIdleTimeoutMs = positiveIntegerField(
    'delegationIdleTimeoutMs',
    firstDefined(
      override?.delegationIdleTimeoutMs,
      user?.delegationIdleTimeoutMs,
      composition?.delegationIdleTimeoutMs,
    ),
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationIdleTimeoutMs
  const delegationWaitTimeoutMs = positiveIntegerField(
    'delegationWaitTimeoutMs',
    firstDefined(
      override?.delegationWaitTimeoutMs,
      user?.delegationWaitTimeoutMs,
      composition?.delegationWaitTimeoutMs,
    ),
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationWaitTimeoutMs
  const pythonExecutable = materializePythonExecutable(
    firstDefined(
      override?.pythonExecutable,
      user?.pythonExecutable,
      composition?.pythonExecutable,
    ),
    layers.dshHome,
    layers.pythonEnv,
  )
  const specialistModel = firstDefined(
    routeField('override.specialistModel', override?.specialistModel),
    routeField('user.specialistModel', user?.specialistModel),
    routeField('composition.specialistModel', composition?.specialistModel),
  ) ?? deepFreeze({ inheritMain: true }) satisfies SpecialistModelSelection
  return deepFreeze({
    reportLanguage,
    specialistModel,
    delegationIdleTimeoutMs,
    delegationWaitTimeoutMs,
    ...(pythonExecutable === undefined ? {} : { pythonExecutable }),
  })
}
