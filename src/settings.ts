/**
 * Report-workflow settings layering (PLAN.md §2.14). AutoReport owns ONLY
 * report-policy settings; DSH keeps providers, credentials, Main model
 * selection, compaction, approvals, sandbox/shell, session lifecycle, and UI
 * preferences. Resolution applies one fixed precedence chain per field:
 *
 * ```text
 * explicit workflow override (internal only; no v1 user surface)
 *         ↓
 * project settings        (<dshHome>/autoreport/<workspaceId>/project.json —
 *                          external, never inside the experiment workspace)
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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
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
export const AUTOREPORT_SETTINGS_NAMESPACE = settingsNamespace('autoreport')

export interface AutoReportUserSettings {
  /** Default report source language (schema default `latex`). */
  defaultReportLanguage: ReportLanguage
  /** No-progress timeout while a `wait: true` child is idle (schema default one minute). */
  delegationIdleTimeoutMs: number
  /** Absolute `wait: true` cap (schema default ten minutes; legacy key retained for compatibility). */
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
  specialistModel: SPECIALIST_ROUTE_SCHEMA,
  delegationIdleTimeoutMs: z.number().default(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationIdleTimeoutMs),
  delegationWaitTimeoutMs: z.number().default(WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationWaitTimeoutMs),
  pythonExecutable: z.string(),
  pythonEnvironments: z.array(PYTHON_ENVIRONMENT_SCHEMA).default([]),
  mineruStatus: MINERU_STATUS_SCHEMA,
}) as unknown as z<AutoReportUserSettings>

/** Convert composition defaults into the base layer for DSH user settings. */
export function autoReportUserSettingsBase(
  config: Config,
  environments: readonly PythonCandidate[] = [],
  mineruStatus?: MineruStatus,
): AutoReportUserSettings {
  return {
    defaultReportLanguage: config.defaultReportLanguage,
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
 * Per-workspace policy persisted OUTSIDE the experiment workspace at
 * `<dshHome>/autoreport/<workspaceId>/project.json`. Every field is optional:
 * absence defers to lower layers.
 */
export interface AutoReportProjectSettings {
  /** Authoritative report language for this workspace once set. */
  reportLanguage?: ReportLanguage
  /** Workspace no-progress timeout while a delegated child is idle. */
  delegationIdleTimeoutMs?: number
  /** Workspace absolute delegation-wait cap. */
  delegationWaitTimeoutMs?: number
  /** Workspace specialist route; absent inherits lower layers. */
  specialistModel?: SpecialistRoute
  /** Workspace Python interpreter override. */
  pythonExecutable?: string
}

/** Schemastery schema validating the external project-settings document. */
export const AUTO_REPORT_PROJECT_SETTINGS_SCHEMA: z<AutoReportProjectSettings> = z.object({
  reportLanguage: z.union(['latex', 'typst'] as const),
  specialistModel: SPECIALIST_ROUTE_SCHEMA,
  delegationIdleTimeoutMs: z.number(),
  delegationWaitTimeoutMs: z.number(),
  pythonExecutable: z.string(),
}) as unknown as z<AutoReportProjectSettings>

/**
 * Schemastery materializes nested object fields as `{}` even when the input
 * omits them. An empty route object means ABSENT everywhere it can enter:
 * document storage compacts it away and {@link routeField} reads it as no
 * configuration, so the artifact never becomes a phantom route.
 */
function isEmptyRoute(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

/** Strip undefined entries and empty-route artifacts from one validated section. */
function compactSection<S extends Record<string, unknown>>(section: S): S {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(section)) {
    if (value === undefined || (key === 'specialistModel' && isEmptyRoute(value))) continue
    if (key === 'pythonEnvironments') continue
    kept[key] = value
  }
  return kept as S
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
  /** Loaded project settings; sparse patches are fine. */
  readonly project?: Partial<AutoReportProjectSettings> | undefined
  /** Plugin composition defaults ({@link Config} minus `workspaceRoot`). */
  readonly composition?: Partial<WorkflowCompositionDefaults> | undefined
  /** Explicit workflow inputs; beats everything. */
  readonly override?: Partial<WorkflowSettingsOverride> | undefined
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
 * @param layers - user/project/composition/override inputs, all optional.
 * @returns deep-frozen {@link WorkflowSettingsSnapshot}.
 */
export function resolveWorkflowSettings(layers: WorkflowSettingsLayers): WorkflowSettingsSnapshot {
  const { user, project, composition, override } = layers
  const reportLanguage = enumField(
    'reportLanguage',
    firstDefined(override?.reportLanguage, project?.reportLanguage, user?.defaultReportLanguage, composition?.defaultReportLanguage),
    REPORT_LANGUAGES,
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.reportLanguage
  const delegationIdleTimeoutMs = positiveIntegerField(
    'delegationIdleTimeoutMs',
    firstDefined(
      override?.delegationIdleTimeoutMs,
      project?.delegationIdleTimeoutMs,
      user?.delegationIdleTimeoutMs,
      composition?.delegationIdleTimeoutMs,
    ),
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationIdleTimeoutMs
  const delegationWaitTimeoutMs = positiveIntegerField(
    'delegationWaitTimeoutMs',
    firstDefined(
      override?.delegationWaitTimeoutMs,
      project?.delegationWaitTimeoutMs,
      user?.delegationWaitTimeoutMs,
      composition?.delegationWaitTimeoutMs,
    ),
  ) ?? WORKFLOW_SETTINGS_SCHEMA_DEFAULTS.delegationWaitTimeoutMs
  const pythonExecutable = materializePythonExecutable(
    firstDefined(
      override?.pythonExecutable,
      project?.pythonExecutable,
      user?.pythonExecutable,
      composition?.pythonExecutable,
    ),
    layers.dshHome,
    layers.pythonEnv,
  )
  const specialistModel = firstDefined(
    routeField('override.specialistModel', override?.specialistModel),
    routeField('project.specialistModel', project?.specialistModel),
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

/** Workspace-id alphabet; ids are hash digests, never filesystem paths. */
const WORKSPACE_ID_PATTERN = /^[a-z0-9]{16}$/u

/**
 * Derive the stable per-workspace settings key from the ABSOLUTE experiment
 * workspace root: sha256 over the resolved path, first 16 hex chars. Same
 * workspace location ⇒ same id across sessions and processes, and the id
 * never leaks a path fragment nor lives inside the workspace itself.
 * @param workspaceRoot - absolute experiment workspace root.
 * @returns the 16-char workspace id.
 */
export function workspaceIdForRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot)
  if (resolved.length === 0) throw new Error('autoreport workspace id requires a non-empty workspace root')
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16)
}

/**
 * Absolute path of one workspace's external project settings document.
 * @param settingsHome - harness home override; absent resolves `$DSH_HOME`/`~/.dsh`.
 * @param workspaceId - id from {@link workspaceIdForRoot}.
 * @returns `<home>/autoreport/<workspaceId>/project.json`.
 */
export function projectSettingsPath(settingsHome: string | undefined, workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`autoreport workspace id must match ${String(WORKSPACE_ID_PATTERN)}: ${workspaceId}`)
  }
  return join(settingsHome === undefined ? resolveDshHome() : settingsHome, 'autoreport', workspaceId, 'project.json')
}

/**
 * Load one workspace's project settings. A missing file is the empty patch
 * ({}); malformed JSON or a non-object document fails loud with the path.
 * @param settingsHome - harness home override; absent resolves the DSH home.
 * @param workspaceId - id from {@link workspaceIdForRoot}.
 * @returns the stored patch, validated; `{}` when nothing was stored yet.
 */
export function loadProjectSettings(settingsHome: string | undefined, workspaceId: string): AutoReportProjectSettings {
  const file = projectSettingsPath(settingsHome, workspaceId)
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error: unknown) {
    throw new Error(`autoreport project settings ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`autoreport project settings ${file} must contain one JSON object`)
  }
  return compactSection(AUTO_REPORT_PROJECT_SETTINGS_SCHEMA(parsed) as Record<string, unknown>) as AutoReportProjectSettings
}

/**
 * Atomically persist one workspace's project settings: validate, write a
 * unique temporary file in the destination directory, then rename over the
 * target so readers observe either the old or the new document, never a torn
 * write.
 * @param settingsHome - harness home override; absent resolves the DSH home.
 * @param workspaceId - id from {@link workspaceIdForRoot}.
 * @param settings - complete next patch; invalid fields fail loud.
 */
export function saveProjectSettings(
  settingsHome: string | undefined,
  workspaceId: string,
  settings: AutoReportProjectSettings,
): void {
  const validated = AUTO_REPORT_PROJECT_SETTINGS_SCHEMA(settings) as Record<string, unknown>
  const file = projectSettingsPath(settingsHome, workspaceId)
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.project.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(compactSection(validated), null, 2)}\n`)
    renameSync(temporary, file)
  } catch (error: unknown) {
    try {
      unlinkSync(temporary)
    } catch {
      // The rename target is authoritative; a stuck temporary file must not
      // mask the original write failure.
    }
    throw error
  }
}
