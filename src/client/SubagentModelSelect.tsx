/**
 * Composer-bar model picker for AutoReport subagents. DSH hides its own
 * `conversation.input.model` seat on addressed children; this list-slot
 * entry restores the same session.models / selectModel RPCs for AutoReport
 * children so switching the foreground agent to a subagent still offers a
 * model list in the conversation window.
 */

import { useEffect, useId, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SelectMenu } from './SelectMenu.js'
import { css } from './styles.js'

/** One catalog row the picker can submit. */
export interface SubagentModelChoice {
  provider: string
  model: string
  label: string
  defaultEffort?: string
  efforts: readonly { id: string; name: string }[]
}

/** Injected face for the AutoReport subagent model seat. */
export interface SubagentModelInjected {
  /** False for Main and for non-AutoReport children. */
  available: boolean
  /** Load the child's advisory directory. */
  load: () => Promise<{
    current: { provider: string; model: string; reasoningEffort?: string } | null
    choices: readonly SubagentModelChoice[]
  } | undefined>
  /** Submit a complete selection; returns whether the Host accepted it. */
  select: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<boolean>
}

/**
 * Compact provider/model (+ optional effort) picker shown while an AutoReport
 * subagent is the foreground conversation.
 */
export function SubagentModelSelect(
  props: SubagentModelInjected & PropsLocale<'settings.autoreport'>,
) {
  const { t } = props
  const selectId = useId()
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [current, setCurrent] = useState<{ provider: string; model: string; reasoningEffort?: string } | null>(null)
  const [choices, setChoices] = useState<readonly SubagentModelChoice[]>([])

  useEffect(() => {
    if (!props.available) return
    let cancelled = false
    setStatus('loading')
    void props.load().then((directory) => {
      if (cancelled) return
      if (directory === undefined) {
        setStatus('error')
        return
      }
      setCurrent(directory.current)
      setChoices(directory.choices)
      setStatus('ready')
    }, () => {
      if (!cancelled) setStatus('error')
    })
    return () => { cancelled = true }
  }, [props.available, props.load])

  if (!props.available) return null

  const selected = current === null
    ? ''
    : `${current.provider}/${current.model}`
  const currentChoice = choices.find(choice => `${choice.provider}/${choice.model}` === selected)
  const effortValue = current?.reasoningEffort ?? currentChoice?.defaultEffort ?? ''
  const modelOptions = status === 'ready'
    ? [
      ...selected === '' ? [{ value: '', label: t('modelPicker') }] : [],
      ...choices.map(choice => ({
        value: `${choice.provider}/${choice.model}`,
        label: choice.label,
      })),
    ]
    : [{
      value: '',
      label: status === 'error' ? t('modelPickerFailed') : t('modelPickerLoading'),
    }]

  const onModel = async (value: string): Promise<void> => {
    const choice = choices.find(item => `${item.provider}/${item.model}` === value)
    if (choice === undefined) return
    const accepted = await props.select({
      provider: choice.provider,
      model: choice.model,
      ...choice.defaultEffort === undefined ? {} : { reasoningEffort: choice.defaultEffort },
    })
    if (accepted) {
      setCurrent({
        provider: choice.provider,
        model: choice.model,
        ...choice.defaultEffort === undefined ? {} : { reasoningEffort: choice.defaultEffort },
      })
    }
  }

  const onEffort = async (value: string): Promise<void> => {
    if (current === null) return
    const accepted = await props.select({
      provider: current.provider,
      model: current.model,
      ...(value.length === 0 ? {} : { reasoningEffort: value }),
    })
    if (accepted) {
      setCurrent({
        provider: current.provider,
        model: current.model,
        ...(value.length === 0 ? {} : { reasoningEffort: value }),
      })
    }
  }

  return (
    <div className={css.subagentModel}>
      <label className={css.subagentModelLabel} htmlFor={selectId}>{t('modelPicker')}</label>
      <SelectMenu
        id={selectId}
        ariaLabel={t('modelPicker')}
        variant="chip"
        side="top"
        value={selected}
        options={modelOptions}
        disabled={status !== 'ready'}
        onChange={(value) => { void onModel(value) }}
      />
      {currentChoice !== undefined && currentChoice.efforts.length > 0
        ? (
          <SelectMenu
            ariaLabel={t('reasoningEffort')}
            variant="chip"
            side="top"
            value={effortValue}
            options={[
              ...currentChoice.defaultEffort === undefined
                ? [{ value: '', label: t('reasoningEffort') }]
                : [],
              ...currentChoice.efforts.map(effort => ({ value: effort.id, label: effort.name })),
            ]}
            onChange={(value) => { void onEffort(value) }}
          />
        )
        : null}
    </div>
  )
}
