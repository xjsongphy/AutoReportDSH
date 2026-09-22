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
    delegationIdleTimeoutMs: field('60000'),
    delegationWaitTimeoutMs: field('600000'),
    pythonExecutable: field(''),
    pythonEnvironments: [],
    mineruStatus: { installed: true, tokenConfigured: true, tokenSource: 'config' },
    projects: { latex: [], typst: [] },
    ...state,
  })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn(), moveProject: vi.fn() }
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

  it('renders the settings directly, with no disclosure layer', () => {
    renderCard()

    // The Plugins page owns the title, the icon, and the crumb; the card is the form.
    expect(screen.queryByText(en.title)).toBeNull()
    expect(screen.queryByText(en.description)).toBeNull()
    expect(screen.getByRole('combobox', { name: en.reportLanguage })).toBeTruthy()
  })

  it('groups the fields under section headings', () => {
    renderCard()

    expect(screen.getByRole('heading', { name: en.sectionReport })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.sectionDelegation })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.sectionEnvironment })).toBeTruthy()
  })

  it('writes only from Save', () => {
    const actions = renderCard({ dirty: true })

    expect(screen.getByRole('combobox', { name: en.reportLanguage }).textContent).toContain(en.languageLatex)
    expect(screen.getByRole('textbox', { name: en.idleTimeoutMs })).toHaveProperty('value', '60000')
    expect(screen.getByRole('textbox', { name: en.timeoutMs })).toHaveProperty('value', '600000')
    expect(screen.getByRole('combobox', { name: en.python }).textContent).toContain(en.pythonPick)
    expect(screen.getByText(en.mineru)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(en.mineruTokenSourceConfig)
    expect(actions.save).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a closed-set pick from the DSH menu without writing until Save', () => {
    const actions = renderCard()

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

    fireEvent.click(screen.getByRole('combobox', { name: en.python }))

    expect(screen.getByRole('menuitem', { name: en.pythonManaged })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'PATH · python3 · Python 3.12' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: en.pythonCustom })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: en.pythonPick })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: en.pythonManaged }))
    expect(actions.edit).toHaveBeenCalledWith('pythonExecutable', '__managed__')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('contributes no card chrome and no divider between fields', () => {
    renderCard()

    // The official pages are borderless: nothing here may reintroduce a card.
    expect(document.querySelector('.ar-card')).toBeNull()
    expect(document.querySelector('.ar-card-body')).toBeNull()
  })

  it('pairs the two delegation waits in one row', () => {
    renderCard()

    const idle = screen.getByRole('textbox', { name: en.idleTimeoutMs })
    const wait = screen.getByRole('textbox', { name: en.timeoutMs })
    expect(idle.closest('.ar-grid')).not.toBeNull()
    expect(wait.closest('.ar-grid')).toBe(idle.closest('.ar-grid'))
  })

  it('moves a project to the other language from its row', () => {
    const actions = renderCard({
      projects: { latex: [{ root: '/exp/a', name: 'Alpha', language: 'latex' }], typst: [] },
    })

    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('/exp/a')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `${en.moveToOther} ${en.languageTypst}` }))

    expect(actions.moveProject).toHaveBeenCalledWith('/exp/a')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('says so when a language has no project yet', () => {
    renderCard()

    expect(screen.getAllByText(en.projectsEmpty)).toHaveLength(2)
  })

  it('blocks save while a draft is invalid', () => {
    renderCard({
      dirty: true,
      invalid: true,
      pythonExecutable: field('python3', { invalid: true }),
    })

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
