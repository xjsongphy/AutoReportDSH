/**
 * The AutoReport card's staged form over the `autoreport` settings namespace.
 *
 * The namespace string is spelled here rather than imported from the Host
 * module: a client bundle must not pull Node settings code.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { MineruStatus } from './mineru-status-types.js'
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
  defaultReportLanguage?: 'latex' | 'typst'
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
}

/** The registration-side face the AutoReport card's slot entry injects. */
export interface AutoReportCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAutoreportCard. */
    autoreportCard: SnapshotStore<AutoReportCardState>
  }
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
  private readonly scope: SettingsScope<AutoReportCardSettings>
  private readonly form: CardForm<AutoReportCardSettings>
  private readonly store: SnapshotStore<AutoReportCardState>

  /** @param scope - the bound settings scope for the `autoreport` namespace. */
  constructor(scope: SettingsScope<AutoReportCardSettings>) {
    this.scope = scope
    this.form = new CardForm(scope, [
      enumField('defaultReportLanguage', LANGUAGE_VALUES),
      numberField('delegationIdleTimeoutMs'),
      numberField('delegationWaitTimeoutMs'),
      textField('pythonExecutable'),
    ])
    this.store = this.form.bind(() => this.projection())
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
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): AutoReportCardFace {
    return { hooks: { autoreportCard: this.store }, ...this.form.actions() }
  }
}
