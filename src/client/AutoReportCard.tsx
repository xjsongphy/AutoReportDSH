/**
 * The AutoReport plugin configuration page.
 *
 * It renders into the bundle's own page in the Plugins page's Official group,
 * which asks for `view: 'page'` only and draws the title, the icon, and the
 * crumb itself. The card therefore owns the form: section headings, the
 * controls, and one save row. The official page style is borderless and
 * divider-free, so the card contributes no chrome of its own.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoReportCardFace } from './controller.js'
import { MineruStatusField, SelectField, ValueField, PythonField } from './fields.js'
import { ProjectLists } from './ProjectLists.js'
import { css } from './styles.js'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

/** Props the renderer binds for the AutoReport card. */
export type AutoReportCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.autoreport'>
  & InjectFace<AutoReportCardFace>

/**
 * Render the AutoReport configuration page.
 * @param props - locale copy and the form state.
 * @returns the form, or nothing while the namespace is not served.
 */
export function AutoReportCard(props: AutoReportCardProps) {
  const { t } = props
  const state = props.useAutoreportCard(snapshot => snapshot)
  if (!state.available) return null
  const shared = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled: !state.writable,
  }
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div className={css.page}>
      {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('sectionReport')}</h3>
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
        <ProjectLists
          t={t}
          projects={state.projects}
          disabled={!state.writable}
          onMove={props.moveProject}
        />
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('sectionDelegation')}</h3>
        <div className={css.grid}>
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
        </div>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('sectionEnvironment')}</h3>
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
        <MineruStatusField
          label={t('mineru')}
          hint={t('mineruHint')}
          commandLabel={t('mineruCommand')}
          installedLabel={t('mineruInstalled')}
          notInstalledLabel={t('mineruNotInstalled')}
          tokenLabel={t('mineruToken')}
          tokenConfiguredLabel={t('mineruTokenConfigured')}
          tokenMissingLabel={t('mineruTokenMissing')}
          tokenSource={state.mineruStatus.tokenSource === 'environment'
            ? t('mineruTokenSourceEnvironment')
            : state.mineruStatus.tokenSource === 'config'
              ? t('mineruTokenSourceConfig')
              : undefined}
          status={state.mineruStatus}
        />
      </section>

      <div className={css.actions}>
        {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
        <button
          type="button"
          className={css.discard}
          disabled={!state.dirty || state.saving}
          onClick={props.discard}
        >
          {t('discard')}
        </button>
        <button
          type="button"
          className={css.save}
          disabled={blocked}
          onClick={props.save}
        >
          {t(state.saving ? 'saving' : 'save')}
        </button>
      </div>
    </div>
  )
}
