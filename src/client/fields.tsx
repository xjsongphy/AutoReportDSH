/**
 * Hand-written controls for the AutoReport settings card. Nothing here writes:
 * a control reports what the user typed, and the card's save is the single
 * point where a draft becomes a document mutation.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { SelectMenu } from './SelectMenu.js'
import { css } from './styles.js'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the title. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

function FieldHead(props: FieldProps) {
  return (
    <>
      <div className={css.fieldHead}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </>
  )
}

function FieldChrome(props: FieldProps & {
  children: ReactNode
  /** Title and hint on the left, control on the right (General Settings rows). */
  split?: boolean
  /** Extra controls under the row (typed Python path). */
  footer?: ReactNode
}) {
  const copy = <FieldHead {...props} />
  return (
    <div className={css.field}>
      {props.split === true
        ? (
          <div className={css.fieldSplit}>
            <div className={css.fieldText}>{copy}</div>
            {props.children}
          </div>
        )
        : (
          <>
            {copy}
            {props.children}
          </>
        )}
      {props.footer}
    </div>
  )
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <FieldChrome {...props}>
      <input
        id={props.id}
        className={props.invalid ? `${css.input} ${css.inputInvalid}` : css.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
    </FieldChrome>
  )
}

/** One option in a closed-set field. */
export interface SelectOption {
  /** Stored value written on save. */
  value: string
  /** Visible label. */
  label: string
}

/**
 * A staged closed-set field. The control never invents a value: it only
 * offers the options the card declared.
 * @param props - the field's copy, its staged text, and the allowed options.
 * @returns the labelled control.
 */
export function SelectField(props: FieldProps & {
  /** Allowed stored values, in display order. */
  options: readonly SelectOption[]
}) {
  return (
    <FieldChrome {...props} split>
      <SelectMenu
        id={props.id}
        value={props.text}
        options={props.options}
        disabled={props.disabled}
        invalid={props.invalid}
        onChange={props.onEdit}
      />
    </FieldChrome>
  )
}

const CUSTOM_PYTHON = '__custom__'
/** Must match Host `MANAGED_PYTHON_SENTINEL` in python-detect.ts. */
const MANAGED_PYTHON = '__managed__'

/**
 * Python environment picker: AutoReport-managed, detected local rows, and
 * a typed absolute path. Picking managed writes `__managed__`; the Host
 * creates `$DSH_HOME/autoreport/venv` on save if it is missing.
 */
export function PythonField(props: FieldProps & {
  /** Host-detected interpreters, in display order (managed first when published). */
  environments: readonly { executable: string; label: string; source?: string }[]
  /** Copy for the AutoReport-managed row when the Host has not published one. */
  managedLabel: string
  /** Empty-trigger copy before the user picks. */
  pickLabel: string
  /** Copy for the typed-path row. */
  customLabel: string
}) {
  const managedFromHost = props.environments.find(option => option.source === 'managed')
  const local = props.environments.filter(option => option.source !== 'managed')
  const detected = props.environments.some(option => option.executable === props.text)
    || props.text === MANAGED_PYTHON
  const [forceCustom, setForceCustom] = useState(false)
  const isCustomValue = props.text !== '' && props.text !== MANAGED_PYTHON && !props.environments.some(option => option.executable === props.text)
  const showCustom = forceCustom || isCustomValue
  const mode = showCustom ? CUSTOM_PYTHON : (props.text === MANAGED_PYTHON ? MANAGED_PYTHON : props.text)
  const options: SelectOption[] = [
    { value: MANAGED_PYTHON, label: managedFromHost?.label ?? props.managedLabel },
    ...local.map(option => ({ value: option.executable, label: option.label })),
    { value: CUSTOM_PYTHON, label: props.customLabel },
  ]
  return (
    <FieldChrome
      {...props}
      split
      footer={showCustom
        ? (
          <input
            className={props.invalid ? `${css.input} ${css.inputInvalid}` : css.input}
            type="text"
            value={props.text}
            placeholder="/usr/bin/python3"
            disabled={props.disabled}
            {...props.invalid ? { 'aria-invalid': true } : {}}
            onChange={(event) => { props.onEdit(event.target.value) }}
          />
        )
        : null}
    >
      <SelectMenu
        id={props.id}
        value={mode}
        options={options}
        placeholder={props.pickLabel}
        disabled={props.disabled}
        invalid={props.invalid}
        onChange={(next) => {
          if (next === CUSTOM_PYTHON) {
            setForceCustom(true)
            if (detected) props.onEdit('')
            return
          }
          setForceCustom(false)
          props.onEdit(next)
        }}
      />
    </FieldChrome>
  )
}
