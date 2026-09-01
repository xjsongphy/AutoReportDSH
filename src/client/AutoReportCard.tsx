/** The AutoReport plugin configuration card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoReportCardFace } from './controller.js'
import { SelectField, ValueField, PythonField } from './fields.js'
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
      <ValueField
        id="plugin-config-autoreport-idle-timeout"
        label={t('idleTimeoutMs')}
        hint={t('idleTimeoutMsHint')}
        invalidLabel={t('invalidNumber')}
        numeric
        {...shared}
        {...state.delegationIdleTimeoutMs}
        onEdit={(text) => { props.edit('delegationIdleTimeoutMs', text) }}
        onReset={() => { props.resetField('delegationIdleTimeoutMs') }}
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
      <PythonField
        id="plugin-config-autoreport-python"
        label={t('python')}
        hint={t('pythonHint')}
        invalidLabel={t('invalidPython')}
        environments={state.pythonEnvironments}
        managedLabel={t('pythonManaged')}
        pickLabel={t('pythonPick')}
        customLabel={t('pythonCustom')}
        {...shared}
        {...state.pythonExecutable}
        onEdit={(text) => { props.edit('pythonExecutable', text) }}
        onReset={() => { props.resetField('pythonExecutable') }}
      />
    </PluginCard>
  )
}
