/** The AutoReport plugin configuration card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoReportCardFace } from './controller.js'
import { SelectField, ValueField } from './fields.js'
import { PluginCard } from './PluginCard.js'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

/** Props the renderer binds for the AutoReport card. */
export type AutoReportCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.autoreport'>
  & InjectFace<AutoReportCardFace>

/**
 * Render the AutoReport card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function AutoReportCard(props: AutoReportCardProps) {
  const { t } = props
  const state = props.useAutoreportCard(snapshot => snapshot)
  const disabled = !state.writable
  const shared = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled,
  }
  return (
    <PluginCard t={t} state={state} onSave={props.save} onDiscard={props.discard}>
      <SelectField
        id="plugin-config-autoreport-language"
        label={t('reportLanguage')}
        hint={t('reportLanguageHint')}
        invalidLabel={t('invalidChoice')}
        options={[
          { value: 'latex', label: t('languageLatex') },
          { value: 'typst', label: t('languageTypst') },
        ]}
        {...shared}
        {...state.defaultReportLanguage}
        onEdit={(text) => { props.edit('defaultReportLanguage', text) }}
        onReset={() => { props.resetField('defaultReportLanguage') }}
      />
      <SelectField
        id="plugin-config-autoreport-engine"
        label={t('latexEngine')}
        hint={t('latexEngineHint')}
        invalidLabel={t('invalidChoice')}
        options={[
          { value: 'latexmk', label: t('engineLatexmk') },
          { value: 'tectonic', label: t('engineTectonic') },
        ]}
        {...shared}
        {...state.defaultLatexEngine}
        onEdit={(text) => { props.edit('defaultLatexEngine', text) }}
        onReset={() => { props.resetField('defaultLatexEngine') }}
      />
      <ValueField
        id="plugin-config-autoreport-timeout"
        label={t('timeoutMs')}
        hint={t('timeoutMsHint')}
        invalidLabel={t('invalidNumber')}
        numeric
        {...shared}
        {...state.delegationWaitTimeoutMs}
        onEdit={(text) => { props.edit('delegationWaitTimeoutMs', text) }}
        onReset={() => { props.resetField('delegationWaitTimeoutMs') }}
      />
      <ValueField
        id="plugin-config-autoreport-python"
        label={t('python')}
        hint={t('pythonHint')}
        invalidLabel={t('pythonHint')}
        {...shared}
        {...state.pythonExecutable}
        onEdit={(text) => { props.edit('pythonExecutable', text) }}
        onReset={() => { props.resetField('pythonExecutable') }}
      />
      <ValueField
        id="plugin-config-autoreport-provider"
        label={t('specialistProvider')}
        hint={t('specialistProviderHint')}
        invalidLabel={t('invalidRoute')}
        {...shared}
        {...state.specialistProvider}
        onEdit={(text) => { props.edit('specialistModel.provider', text) }}
        onReset={() => { props.resetField('specialistModel.provider') }}
      />
      <ValueField
        id="plugin-config-autoreport-model"
        label={t('specialistModel')}
        hint={t('specialistModelHint')}
        invalidLabel={t('invalidRoute')}
        {...shared}
        {...state.specialistModel}
        onEdit={(text) => { props.edit('specialistModel.model', text) }}
        onReset={() => { props.resetField('specialistModel.model') }}
      />
      <ValueField
        id="plugin-config-autoreport-effort"
        label={t('specialistEffort')}
        hint={t('specialistEffortHint')}
        invalidLabel={t('invalidRoute')}
        {...shared}
        {...state.specialistEffort}
        onEdit={(text) => { props.edit('specialistModel.reasoningEffort', text) }}
        onReset={() => { props.resetField('specialistModel.reasoningEffort') }}
      />
    </PluginCard>
  )
}
