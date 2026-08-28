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
    pythonEnvironments: [],
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

    expect(screen.getByRole('combobox', { name: en.reportLanguage }).textContent).toContain(en.languageLatex)
    expect(screen.getByRole('combobox', { name: en.python }).textContent).toContain(en.pythonPick)
    expect(actions.save).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a closed-set pick from the DSH menu without writing until Save', () => {
    const actions = renderCard()

    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    fireEvent.click(screen.getByRole('combobox', { name: en.reportLanguage }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.languageTypst }))

    expect(actions.edit).toHaveBeenCalledWith('defaultReportLanguage', 'typst')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers managed, local, and custom Python rows and stages __managed__', () => {
    const actions = renderCard({
      pythonEnvironments: [{
        label: 'PATH · python3 · Python 3.12',
        executable: '/usr/bin/python3',
        source: 'path',
        version: 'Python 3.12.0',
      }],
    })

    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    fireEvent.click(screen.getByRole('combobox', { name: en.python }))

    expect(screen.getByRole('menuitem', { name: en.pythonManaged })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'PATH · python3 · Python 3.12' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.pythonCustom })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: en.pythonPick })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: en.pythonManaged }))
    expect(actions.edit).toHaveBeenCalledWith('pythonExecutable', '__managed__')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('blocks save while a draft is invalid', () => {
    renderCard({
      dirty: true,
      invalid: true,
      pythonExecutable: field('python3', { invalid: true }),
    })

    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
