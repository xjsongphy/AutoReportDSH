// @vitest-environment jsdom
/** What the AutoReport settings card shows before a save is written. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { AutoReportCard } from '../../src/client/AutoReportCard.js'
import type { AutoReportCardProps } from '../../src/client/AutoReportCard.js'
import type { AutoReportCardState } from '../../src/client/controller.js'
import type { CardFieldState, CardShell } from '../../src/client/card-form.js'
import { en } from '../../src/client/locales.js'
import { installCardStyles } from '../../src/client/styles.js'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function snapshotStore<T>(value: T) {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  }
}

function bindSnapshotSelector<T>(store: { getSnapshot: () => T; subscribe: (listener: () => void) => () => void }) {
  return function useSel<S>(selector: (value: T) => S): S {
    return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
  }
}

function renderCard(state: Partial<AutoReportCardState> = {}) {
  installCardStyles()
  const store = snapshotStore<AutoReportCardState>({
    ...settled,
    defaultReportLanguage: field('latex'),
    delegationWaitTimeoutMs: field('600000'),
    pythonExecutable: field(''),
    specialistProvider: field(''),
    specialistModel: field(''),
    specialistEffort: field(''),
    ...state,
  })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  const props = {
    ...actions,
    t,
    useAutoreportCard: bindSnapshotSelector(store),
  } as unknown as AutoReportCardProps
  render(<AutoReportCard {...props} />)
  return actions
}

describe('AutoReportCard', () => {
  it('renders nothing while the namespace is unavailable', () => {
    renderCard({ available: false })

    expect(screen.queryByText(en.title)).toBeNull()
  })

  it('names the plugin in the collapsed header', () => {
    renderCard()

    expect(screen.getByText(en.title)).toBeTruthy()
    expect(screen.getByText(en.description)).toBeTruthy()
    expect(screen.queryByLabelText(en.reportLanguage)).toBeNull()
  })

  it('discloses the fields and writes only from Save', () => {
    const actions = renderCard({ dirty: true })

    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))

    expect(screen.getByLabelText(en.reportLanguage)).toHaveProperty('value', 'latex')
    expect(screen.getByLabelText(en.timeoutMs)).toHaveProperty('value', '600000')
    expect(actions.save).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('blocks save while a draft is invalid', () => {
    renderCard({
      dirty: true,
      invalid: true,
      specialistProvider: field('openai-codex', { invalid: true }),
      specialistModel: field('', { invalid: true }),
    })

    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
