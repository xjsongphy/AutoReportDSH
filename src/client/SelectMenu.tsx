/**
 * DSH-styled closed-set picker: the General Settings selector pill (Language /
 * Agent preset) opening the MenuDropdown card with a trailing check. Out-of-tree
 * cards cannot value-import ui-primitives, so this copies that chrome with the
 * same `--dsw-*` tokens. The list always portals so a settings-modal scroller
 * cannot clip it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { css } from './styles.js'

/** One option the menu can submit. */
export interface SelectMenuOption {
  /** Stored value written on pick. */
  value: string
  /** Visible label. */
  label: string
}

/** Visual host: settings rows vs the composer tool-row chip. */
export type SelectMenuVariant = 'settings' | 'chip'

/** Unplaced portal list: hidden but laid out so offsetWidth/offsetHeight are real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Capsule trigger plus a portaled menu. The owner supplies the current value
 * and the closed option set; this control never invents a value.
 */
export function SelectMenu(props: {
  /** Associates a visible label with the trigger. */
  id?: string
  /** Accessible name when no visible label is wired through `htmlFor`. */
  ariaLabel?: string
  /** Current stored value. */
  value: string
  /** Allowed values, in display order. */
  options: readonly SelectMenuOption[]
  /** Disables the trigger. */
  disabled?: boolean
  /** Marks the trigger as not a value this field accepts. */
  invalid?: boolean
  /** Settings pill (default) or the compact composer chip. */
  variant?: SelectMenuVariant
  /** Empty-value trigger copy when no option is selected. */
  placeholder?: string
  /** Menu alignment against the trigger (default `end`). */
  align?: 'start' | 'end'
  /** Open below (default) or above the trigger. */
  side?: 'bottom' | 'top'
  /** Stage the picked value. */
  onChange: (value: string) => void
}) {
  const variant = props.variant ?? 'settings'
  const align = props.align ?? 'end'
  const side = props.side ?? 'bottom'
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null)

  useEffect(() => {
    if (props.disabled === true) setOpen(false)
  }, [props.disabled])

  useLayoutEffect(() => {
    if (!open) {
      setFixedPos(null)
      return
    }
    const place = (): void => {
      const r = rootRef.current?.getBoundingClientRect()
      if (r === undefined) return
      const MARGIN = 12
      const vw = window.innerWidth
      const vh = window.innerHeight
      const listEl = listRef.current
      const lw = listEl?.offsetWidth ?? 0
      const lh = listEl?.offsetHeight ?? 0
      let x = align === 'start' ? r.left : r.right - lw
      let y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN)
      setFixedPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, align, side, props.options])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) === true) return
      if (listRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const selected = props.options.find(option => option.value === props.value)
  const triggerLabel = selected?.label
    ?? (props.value.length === 0 ? (props.placeholder ?? '') : props.value)
  const triggerClass = [
    variant === 'chip' ? css.chipTrigger : css.selector,
    props.invalid === true ? css.selectorInvalid : '',
    open ? css.selectorOpen : '',
  ].filter(Boolean).join(' ')
  const menuClass = [
    css.menu,
    variant === 'chip' ? css.menuCompact : '',
  ].filter(Boolean).join(' ')

  const list = open
    ? (
      <div
        ref={listRef}
        className={menuClass}
        style={fixedPos ?? MEASURE_STYLE}
        role="menu"
        onClick={(event) => { event.stopPropagation() }}
      >
        {props.options.map((option) => {
          const isSelected = option.value === props.value
          return (
            <button
              key={option.value}
              type="button"
              role="menuitem"
              className={isSelected ? `${css.menuItem} ${css.menuItemSelected}` : css.menuItem}
              title={option.label}
              onClick={() => {
                setOpen(false)
                if (option.value !== props.value) props.onChange(option.value)
              }}
            >
              <span className={css.menuItemLabel}>{option.label}</span>
              {isSelected ? <CheckIcon /> : null}
            </button>
          )
        })}
      </div>
    )
    : null

  return (
    <span ref={rootRef} className={css.selectRoot}>
      <button
        type="button"
        className={triggerClass}
        role="combobox"
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        disabled={props.disabled === true}
        onClick={() => { setOpen(current => !current) }}
        {...props.id === undefined ? {} : { id: props.id }}
        {...props.ariaLabel === undefined ? {} : { 'aria-label': props.ariaLabel }}
        {...props.invalid === true ? { 'aria-invalid': true } : {}}
      >
        <span className={variant === 'chip' ? css.chipTriggerLabel : css.selectorLabel}>
          {triggerLabel}
        </span>
        <ChevronIcon className={open ? `${css.selectorChevron} ${css.selectorChevronOpen}` : css.selectorChevron} />
      </button>
      {list !== null && typeof document !== 'undefined' ? createPortal(list, document.body) : null}
    </span>
  )
}

function ChevronIcon({ className }: { className: string }) {
  return (
    <svg width={14} height={14} className={className} viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width={16} height={16} className={css.menuCheck} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z"
        fill="currentColor"
      />
    </svg>
  )
}
