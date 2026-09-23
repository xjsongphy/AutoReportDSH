/**
 * The AutoReport card's staged form over the `autoreport` settings namespace.
 *
 * The namespace string is spelled here rather than imported from the Host
 * module: a client bundle must not pull Node settings code.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MineruStatus } from './mineru-status-types.js'
import { projectsByLanguage, type ProjectLanguage, type ProjectSessionRow, type ProjectLists } from './project-lists.js'
import {
  CardForm, enumField, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.js'

/** Namespace of AutoReport's user-owned workflow defaults. */
export const AUTOREPORT_SETTINGS_NAMESPACE = 'autoreport'

/** One Host-detected interpreter the Python picker can offer. */
export interface PythonEnvironmentOption {
  label: string
  executable: string
  source: string
  version: string
}

/** One model route the default-subagent picker can offer, from the Host catalog. */
export interface SpecialistChoice {
  provider: string
  model: string
  /** Display label: provider name joined with the model name. */
  label: string
  /** The route's default reasoning effort, when the catalog advertises one. */
  defaultEffort?: string
}

/** The AutoReport fields this card edits. */
export interface AutoReportCardSettings {
  /** Default report source language. */
  defaultReportLanguage?: ProjectLanguage
  /** Per-workspace language keyed by workspace root; authoritative when present. */
  workspaceLanguages?: Readonly<Record<string, ProjectLanguage>>
  /** Bounded wait for `send_to_agent({ wait: true })`. */
  delegationIdleTimeoutMs?: number
  /** Absolute bound for `send_to_agent({ wait: true })`. */
  delegationWaitTimeoutMs?: number
  /** Optional absolute Python interpreter for subagent bash. */
  pythonExecutable?: string
  /** Default subagent model route; absent or empty inherits the Main route. */
  specialistModel?: { provider: string; model: string; reasoningEffort?: string }
  /** Host-detected interpreters; composition-only, never written by the card. */
  pythonEnvironments?: readonly PythonEnvironmentOption[]
  /** Host-detected MinerU CLI/auth state; composition-only, never written by the card. */
  mineruStatus?: MineruStatus
}

/** What the AutoReport card renders. */
export interface AutoReportCardState extends CardShell {
  /** Default report source language. */
  defaultReportLanguage: CardFieldState
  /** Delegation wait bound. */
  delegationIdleTimeoutMs: CardFieldState
  /** Delegation absolute wait bound. */
  delegationWaitTimeoutMs: CardFieldState
  /** Optional Python interpreter. */
  pythonExecutable: CardFieldState
  /** Detected interpreters from the Host composition layer. */
  pythonEnvironments: readonly PythonEnvironmentOption[]
  /** What a save would leave for the default subagent model. */
  specialistModel: CardFieldState
  /** The picker value the stored or staged route encodes to. */
  specialistCode: string
  /** Catalog-backed options under the leading inherit entry. */
  specialistChoices: readonly SpecialistChoice[]
  /** Catalog request state for the options above. */
  specialistStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Detected MinerU CLI/auth state from the Host composition layer. */
  mineruStatus: MineruStatus
  /** Projects an AutoReport session has conversed in, split by report language. */
  projects: ProjectLists
}

/** The registration-side face the AutoReport card's slot entry injects. */
export interface AutoReportCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAutoreportCard. */
    autoreportCard: SnapshotStore<AutoReportCardState>
  }
  /** Stage the inherit entry or one catalog route for the default subagent model. */
  pickSpecialist: (code: string) => void
  /**
   * Move one project to the other report language. Recorded immediately rather
   * than staged: it acts on the workspace, and the host switches the
   * workspace's templates from the record.
   */
  moveProject: (root: string) => void
}

/** The session listing the project lists are derived from. */
export interface ProjectSessionSource {
  getSnapshot(): { byId: Record<string, ProjectSessionRow> }
  subscribe(listener: () => void): () => void
}

const LANGUAGE_VALUES = ['latex', 'typst'] as const

/** Picker value of the leading inherit entry. */
export const SPECIALIST_INHERIT = 'inherit'

/** Must match Host `MANAGED_PYTHON_SENTINEL` in python-detect.ts. */
const MANAGED_PYTHON = '__managed__'

const DEFAULT_MINERU_STATUS: MineruStatus = {
  installed: false,
  tokenConfigured: false,
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)
}

/** Bridges the `autoreport` scope onto the card's staged form. */
export class AutoReportCardController {
  private readonly form: CardForm<AutoReportCardSettings>
  private readonly store: SnapshotStore<AutoReportCardState>

  /**
   * @param scope - the bound settings scope for the `autoreport` namespace.
   * @param sessions - the Client's session listing, from which the project lists
   *   are derived; project membership follows what actually conversed.
   */
  constructor(
    private readonly scope: SettingsScope<AutoReportCardSettings>,
    private readonly sessions: ProjectSessionSource,
    private readonly loadSpecialistChoices: () => Promise<readonly SpecialistChoice[]> = async () => [],
  ) {
    this.scope = scope
    this.form = new CardForm(scope, [
      enumField('defaultReportLanguage', LANGUAGE_VALUES),
      numberField('delegationIdleTimeoutMs'),
      numberField('delegationWaitTimeoutMs'),
      textField('pythonExecutable'),
      textField('specialistModel.provider'),
      textField('specialistModel.model'),
      textField('specialistModel.reasoningEffort'),
    ])
    this.store = this.form.bind(() => this.projection())
    // A new project appears the moment its first turn commits, without any
    // re-read: the session store already carries the row, and this republishes.
    this.sessions.subscribe(() => { this.store.set(this.projection()) })
    void this.loadChoices()
  }

  /** Catalog-backed picker options and their request state. */
  private choices: readonly SpecialistChoice[] = []
  private choicesStatus: AutoReportCardState['specialistStatus'] = 'idle'

  /** Fetch the catalog-backed picker options once per card mount. */
  private async loadChoices(): Promise<void> {
    this.choicesStatus = 'loading'
    this.store.set(this.projection())
    try {
      this.choices = await this.loadSpecialistChoices()
      this.choicesStatus = 'ready'
    } catch (error) {
      this.choices = []
      this.choicesStatus = 'error'
      console.warn('[dsh-autoreport] model catalog load failed', error)
    }
    this.store.set(this.projection())
  }

  private environments(): readonly PythonEnvironmentOption[] {
    const value = this.scope.getSnapshot().value
    const fromValue = value?.pythonEnvironments
    if (fromValue !== undefined && fromValue.length > 0) return fromValue
    const base = this.scope.getSnapshot().base
    if (base !== undefined && typeof base === 'object' && base !== null && 'pythonEnvironments' in base) {
      const listed = (base as AutoReportCardSettings).pythonEnvironments
      if (listed !== undefined) return listed
    }
    return []
  }

  private mineruStatus(): MineruStatus {
    const snapshot = this.scope.getSnapshot()
    const fromValue = snapshot.value?.mineruStatus
    if (fromValue !== undefined) return fromValue
    const base = snapshot.base
    if (base !== undefined && typeof base === 'object' && base !== null && 'mineruStatus' in base) {
      const status = (base as AutoReportCardSettings).mineruStatus
      if (status !== undefined) return status
    }
    return DEFAULT_MINERU_STATUS
  }

  private projection(): AutoReportCardState {
    const python = this.form.field('pythonExecutable')
    const environments = this.environments()
    const mineruStatus = this.mineruStatus()
    const pythonText = python.text.trim()
    const detected = environments.some(option => option.executable === pythonText)
    const pythonInvalid = python.invalid
      || (pythonText.length > 0
        && pythonText !== MANAGED_PYTHON
        && !detected
        && !isAbsolutePath(pythonText))
    const shell = this.form.shell()
    return {
      ...shell,
      invalid: shell.invalid || pythonInvalid,
      defaultReportLanguage: this.form.field('defaultReportLanguage'),
      delegationIdleTimeoutMs: this.form.field('delegationIdleTimeoutMs'),
      delegationWaitTimeoutMs: this.form.field('delegationWaitTimeoutMs'),
      pythonExecutable: { ...python, invalid: pythonInvalid },
      pythonEnvironments: environments,
      mineruStatus,
      specialistModel: this.form.field('specialistModel.provider'),
      specialistCode: this.specialistCode(),
      specialistChoices: this.choices,
      specialistStatus: this.choicesStatus,
      projects: this.projects(),
    }
  }

  /** The two language lists, derived from the live session rows. */
  private projects(): ProjectLists {
    const value = this.scope.getSnapshot().value
    return projectsByLanguage(
      this.sessions.getSnapshot().byId,
      value?.workspaceLanguages,
      value?.defaultReportLanguage ?? 'latex',
    )
  }

  /**
   * Move one project to the other report language.
   *
   * The map is written through a path op so the browser never restates the
   * settings document it did not read in full. The host turns that record into
   * the workspace's template switch.
   * @param root - absolute workspace root, which is the map's key.
   */
  private moveProject(root: string): void {
    const value = this.scope.getSnapshot().value
    const current = value?.workspaceLanguages?.[root] ?? value?.defaultReportLanguage ?? 'latex'
    const next: ProjectLanguage = current === 'latex' ? 'typst' : 'latex'
    void this.scope.mutate([{ op: 'set', path: ['workspaceLanguages', root], value: next }])
  }

  /**
   * Encode the stored or staged route as the picker's value: the leading
   * inherit entry, or one provider/model route from the catalog options.
   */
  private specialistCode(): string {
    const provider = this.form.field('specialistModel.provider').text
    const model = this.form.field('specialistModel.model').text
    if (provider.length === 0 || model.length === 0) return SPECIALIST_INHERIT
    return provider + '/' + model
  }

  /**
   * Stage the picker's pick. Inherit clears the whole parent object; a route
   * stages its provider and model (plus the catalog's default effort) as one
   * parent write on save.
   */
  private pickSpecialist(code: string): void {
    if (code === SPECIALIST_INHERIT) {
      // Stage the empty route: planNested collapses an all-empty parent to
      // unset on save, which the Host reads as "follow the Main model".
      const actions = this.form.actions()
      actions.edit('specialistModel.provider', '')
      actions.edit('specialistModel.model', '')
      actions.edit('specialistModel.reasoningEffort', '')
      return
    }
    const choice = this.choices.find(item => item.provider + '/' + item.model === code)
    if (choice === undefined) return
    const actions = this.form.actions()
    actions.edit('specialistModel.provider', choice.provider)
    actions.edit('specialistModel.model', choice.model)
    actions.edit('specialistModel.reasoningEffort', choice.defaultEffort ?? '')
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the project control.
   */
  inject(): AutoReportCardFace {
    return {
      hooks: { autoreportCard: this.store },
      ...this.form.actions(),
      pickSpecialist: code => { this.pickSpecialist(code) },
      moveProject: root => { this.moveProject(root) },
    }
  }
}
