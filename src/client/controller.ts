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
  ) {
    this.scope = scope
    this.form = new CardForm(scope, [
      enumField('defaultReportLanguage', LANGUAGE_VALUES),
      numberField('delegationIdleTimeoutMs'),
      numberField('delegationWaitTimeoutMs'),
      textField('pythonExecutable'),
    ])
    this.store = this.form.bind(() => this.projection())
    // A new project appears the moment its first turn commits, without any
    // re-read: the session store already carries the row, and this republishes.
    this.sessions.subscribe(() => { this.store.set(this.projection()) })
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
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the project control.
   */
  inject(): AutoReportCardFace {
    return {
      hooks: { autoreportCard: this.store },
      ...this.form.actions(),
      moveProject: root => { this.moveProject(root) },
    }
  }
}
