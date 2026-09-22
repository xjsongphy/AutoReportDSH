// @vitest-environment jsdom
/** What AutoReport's two dedicated tool rows show, collapsed and expanded. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { toolRowEn, toolRowZh, type ToolRowLocaleKey } from '../../src/client/locales.js'
import { SendToAgentRow, WorkflowTaskRow } from '../../src/client/tool-rows.js'
import { css } from '../../src/client/styles.js'

afterEach(cleanup)

const en: (key: ToolRowLocaleKey) => string = key => toolRowEn[key]
const zh: (key: ToolRowLocaleKey) => string = key => toolRowZh[key]

/** A running call: only the streamed argument JSON exists yet. */
function running(args: unknown) {
  return { callId: 'call-1', argsRaw: JSON.stringify(args) }
}

/** A settled call: result blocks plus the arguments the call carried. */
function settled(args: unknown, content: readonly unknown[], rest: Record<string, unknown> = {}) {
  return { callId: 'call-1', kind: 'settled', content, call: { argsRaw: JSON.stringify(args) }, ...rest }
}

const text = (value: string) => ({ type: 'text', text: value })

/** Owner props the slot supplies, minus the two fields under test. */
function props(block: unknown, t = en, rest: Record<string, unknown> = {}) {
  return { callId: 'call-1', toolName: 'tool', block, openFile: () => {}, loadImage: () => {}, t, ...rest } as never
}

/** The collapsed row's disclosure target. */
function row(): HTMLElement {
  const found = document.querySelector('[data-disclosure-row]')
  if (found === null) throw new Error('no disclosure row rendered')
  return found as HTMLElement
}

describe('SendToAgentRow', () => {
  it('names the role and the subject while the delegation runs', () => {
    const args = { role: 'DATA_ANALYSIS', prompt: 'p', subject: 'fit the RLC curve' }
    render(<SendToAgentRow {...props(running(args))} />)

    expect(screen.getByText('Delegate to subagent')).toBeDefined()
    expect(screen.getByText('DATA_ANALYSIS · fit the RLC curve')).toBeDefined()
  })

  it('marks a delegation that continues an existing task', () => {
    const args = { role: 'REPORT', prompt: 'p', subject: 's', task_id: 'task-2' }
    render(<SendToAgentRow {...props(running(args))} />)

    expect(screen.getByText('REPORT · resend task-2')).toBeDefined()
  })

  it('wears the failure state and shows the first output line', () => {
    const output = 'timed out waiting for task-2\nno workflow report within 600000ms'
    render(<SendToAgentRow {...props(settled({ role: 'REPORT', prompt: 'p' }, [text(output)], { isError: true }))} />)

    expect(screen.getByText('timed out waiting for task-2')).toBeDefined()
    expect(document.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('wears the interrupted state, not the failure state, when stopped', () => {
    const error = { name: 'Interrupted', code: 'interrupted' }
    render(<SendToAgentRow {...props(settled({ role: 'REPORT', prompt: 'p' }, [], { isError: true, error }))} />)

    expect(document.querySelector('[data-state="warning"]')).not.toBeNull()
  })

  it('keeps the summary, not the icon, as the collapsed content when the call succeeded', () => {
    render(<SendToAgentRow {...props(settled({ role: 'THEORY', prompt: 'derive it' }, [text('updated')]))} />)

    expect(screen.getByText('THEORY · derive it')).toBeDefined()
    expect(document.querySelector('[data-state="error"]')).toBeNull()
  })

  it('reveals the arguments and the result on expansion', () => {
    const output = 'updated\nsecond line'
    render(<SendToAgentRow {...props(settled({ role: 'THEORY', prompt: 'derive it' }, [text(output)]))} />)

    fireEvent.click(row())

    expect(screen.getByText('IN')).toBeDefined()
    expect(screen.getByText('OUT')).toBeDefined()
    expect(screen.getByText(/"role": "THEORY"/)).toBeDefined()
    expect(screen.getByText(/second line/)).toBeDefined()
  })

  it('expands a running call into its streamed arguments but no result', () => {
    render(<SendToAgentRow {...props(running({ role: 'THEORY', prompt: 'derive it' }))} />)

    fireEvent.click(row())

    expect(screen.getByText(/"role": "THEORY"/)).toBeDefined()
    expect(screen.queryByText('OUT')).toBeNull()
  })

  it('offers the trajectory inspector only when the host supplies one', () => {
    let inspected = 0
    render(<SendToAgentRow {...props(settled({ role: 'THEORY', prompt: 'derive it' }, [text('updated')]), en, { inspect: () => { inspected += 1 } })} />)

    fireEvent.click(row())
    fireEvent.click(screen.getByText('Inspect'))

    expect(inspected).toBe(1)
  })

  it('offers no inspector when the host supplies none', () => {
    render(<SendToAgentRow {...props(settled({ role: 'THEORY', prompt: 'derive it' }, [text('updated')]))} />)

    fireEvent.click(row())

    expect(screen.queryByText('Inspect')).toBeNull()
  })

  it('falls back to the bare role when the arguments are not readable yet', () => {
    render(<SendToAgentRow {...props({ callId: 'call-1', argsRaw: '{"role":"THEORY","pro' })} />)

    expect(screen.getByText('Delegate to subagent')).toBeDefined()
  })

  it('announces the lifecycle the dot carries by colour alone', () => {
    const output = 'timed out waiting for task-2'
    render(<SendToAgentRow {...props(settled({ role: 'REPORT', prompt: 'p' }, [text(output)], { isError: true }))} />)

    expect(screen.getByText('Failed')).toBeDefined()
  })

  it('speaks the shell locale', () => {
    render(<SendToAgentRow {...props(running({ role: 'THEORY', prompt: 'derive it' }), zh)} />)

    expect(screen.getByText('委派子代理')).toBeDefined()
  })
})

describe('WorkflowTaskRow', () => {
  it('counts the checklist an update carries, before the call settles', () => {
    const steps = [{ description: 'a', done: true }, { description: 'b', done: true }, { description: 'c' }]
    render(<WorkflowTaskRow {...props(running({ action: 'update', task_id: 'task-2', steps }))} />)

    expect(screen.getByText('Report task board')).toBeDefined()
    expect(screen.getByText('Update task-2 · 2/3 done')).toBeDefined()
  })

  it('counts the whole board once the read settles', () => {
    const output = JSON.stringify({ tasks: [{ task_id: 'task-1' }, { task_id: 'task-2' }] })
    render(<WorkflowTaskRow {...props(settled({ action: 'read' }, [text(output)]))} />)

    expect(screen.getByText('2 tasks')).toBeDefined()
  })

  it('names the transition for a cancelled task', () => {
    render(<WorkflowTaskRow {...props(running({ action: 'cancel', task_id: 'task-3' }))} />)

    expect(screen.getByText('Cancel task-3')).toBeDefined()
  })
})

describe('row chrome', () => {
  it('separates the row label from its summary', () => {
    render(<SendToAgentRow {...props(running({ role: 'THEORY', prompt: 'derive it' }))} />)

    expect(document.querySelector(`.${css.toolSep}`)).not.toBeNull()
  })

  it('drops the separator together with a summary it has nothing to say in', () => {
    render(<WorkflowTaskRow {...props(running({ action: 'read' }))} />)

    expect(screen.getByText('Report task board')).toBeDefined()
    expect(document.querySelector(`.${css.toolSep}`)).toBeNull()
  })

  it('keeps the summary visible while expanded', () => {
    render(<SendToAgentRow {...props(running({ role: 'THEORY', prompt: 'derive it' }))} />)

    fireEvent.click(row())

    expect(screen.getByText('THEORY · derive it')).toBeDefined()
  })

  it('marks the row running so the running fade can key off it', () => {
    render(<SendToAgentRow {...props(running({ role: 'THEORY', prompt: 'derive it' }))} />)

    expect(document.querySelector('[data-ar-state="running"]')).not.toBeNull()
  })

  it('leaves the leading icon alone while running: the fade is the running cue', () => {
    render(<SendToAgentRow {...props(running({ role: 'THEORY', prompt: 'derive it' }))} />)

    expect(document.querySelector('[data-state]')).toBeNull()
  })

  it('marks a failed row as an error for the same hook', () => {
    const error = { name: 'TimeoutError', code: 'timeout' }
    render(<SendToAgentRow {...props(settled({ role: 'REPORT', prompt: 'p' }, [], { isError: true, error }))} />)

    expect(document.querySelector('[data-ar-state="error"]')).not.toBeNull()
  })
})
