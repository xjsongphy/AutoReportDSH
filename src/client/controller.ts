/**
 * The AutoReport card's staged form over the `autoreport` settings namespace.
 *
 * The namespace string is spelled here rather than imported from the Host
 * module: a client bundle must not pull Node settings code.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, enumField, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.js'

/** Namespace of AutoReport's user-owned workflow defaults. */
export const AUTOREPORT_SETTINGS_NAMESPACE = 'autoreport'

/** The AutoReport fields this card edits. */
export interface AutoReportCardSettings {
  /** Default report source language. */
  defaultReportLanguage?: 'latex' | 'typst'
  /** Default LaTeX compiler. */
  defaultLatexEngine?: 'latexmk' | 'tectonic'
  /** Bounded wait for `send_to_agent({ wait: true })`. */
  delegationWaitTimeoutMs?: number
  /** Optional absolute Python interpreter for specialist bash. */
  pythonExecutable?: string
  /** Optional specialist route; absence inherits Main. */
  specialistModel?: {
    provider?: string
    model?: string
    reasoningEffort?: string
  }
}

/** What the AutoReport card renders. */
export interface AutoReportCardState extends CardShell {
  /** Default report source language. */
  defaultReportLanguage: CardFieldState
  /** Default LaTeX compiler. */
  defaultLatexEngine: CardFieldState
  /** Delegation wait bound. */
  delegationWaitTimeoutMs: CardFieldState
  /** Optional Python interpreter. */
  pythonExecutable: CardFieldState
  /** Specialist provider id. */
  specialistProvider: CardFieldState
  /** Specialist model id. */
  specialistModel: CardFieldState
  /** Optional specialist reasoning effort. */
  specialistEffort: CardFieldState
}

/** The registration-side face the AutoReport card's slot entry injects. */
export interface AutoReportCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAutoreportCard. */
    autoreportCard: SnapshotStore<AutoReportCardState>
  }
}

const LANGUAGE_VALUES = ['latex', 'typst'] as const
const ENGINE_VALUES = ['latexmk', 'tectonic'] as const

/** A specialist route is either absent or a complete provider+model pair. */
function routeIncomplete(provider: string, model: string, effort: string): boolean {
  const hasProvider = provider.trim().length > 0
  const hasModel = model.trim().length > 0
  const hasEffort = effort.trim().length > 0
  if (!hasProvider && !hasModel) return hasEffort
  return !hasProvider || !hasModel
}

/** Bridges the `autoreport` scope onto the card's staged form. */
export class AutoReportCardController {
  private readonly form: CardForm<AutoReportCardSettings>
  private readonly store: SnapshotStore<AutoReportCardState>

  /** @param scope - the bound settings scope for the `autoreport` namespace. */
  constructor(scope: SettingsScope<AutoReportCardSettings>) {
    this.form = new CardForm(scope, [
      enumField('defaultReportLanguage', LANGUAGE_VALUES),
      enumField('defaultLatexEngine', ENGINE_VALUES),
      numberField('delegationWaitTimeoutMs'),
      textField('pythonExecutable'),
      textField('specialistModel.provider'),
      textField('specialistModel.model'),
      textField('specialistModel.reasoningEffort'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): AutoReportCardState {
    const provider = this.form.field('specialistModel.provider')
    const model = this.form.field('specialistModel.model')
    const effort = this.form.field('specialistModel.reasoningEffort')
    const incomplete = routeIncomplete(provider.text, model.text, effort.text)
    return {
      ...this.form.shell(),
      defaultReportLanguage: this.form.field('defaultReportLanguage'),
      defaultLatexEngine: this.form.field('defaultLatexEngine'),
      delegationWaitTimeoutMs: this.form.field('delegationWaitTimeoutMs'),
      pythonExecutable: this.form.field('pythonExecutable'),
      specialistProvider: { ...provider, invalid: provider.invalid || incomplete },
      specialistModel: { ...model, invalid: model.invalid || incomplete },
      specialistEffort: { ...effort, invalid: effort.invalid || incomplete },
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
