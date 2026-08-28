// @vitest-environment jsdom
/** DSH-styled closed-set picker: pill trigger, portaled menu, trailing check. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectMenu } from '../../src/client/SelectMenu.js'
import { installCardStyles } from '../../src/client/styles.js'

afterEach(cleanup)

function renderMenu(value = 'latex') {
  installCardStyles()
  const onChange = vi.fn()
  render(
    <SelectMenu
      id="report-language"
      value={value}
      options={[
        { value: 'latex', label: 'LaTeX' },
        { value: 'typst', label: 'Typst' },
      ]}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('SelectMenu', () => {
  it('names the current option on the pill and opens a checked menu', () => {
    renderMenu()

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('LaTeX')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)

    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(screen.getByRole('menuitem', { name: 'LaTeX' }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Typst' }).querySelector('svg')).toBeNull()
  })

  it('reports a pick and closes without reporting the current row', () => {
    const onChange = renderMenu()

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'LaTeX' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Typst' }))
    expect(onChange).toHaveBeenCalledWith('typst')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape without changing the value', () => {
    const onChange = renderMenu()

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
