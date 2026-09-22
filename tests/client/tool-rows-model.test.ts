/**
 * The pure view model behind the AutoReport tool rows: what a collapsed row
 * says, and what state it wears, derived only from the durable call slice.
 */

import { describe, expect, it } from 'vitest'
import { toolRowEn, toolRowZh } from '../../src/client/locales.js'
import {
  callArgs,
  flattenResult,
  parseArgs,
  sendToAgentSummary,
  toolRowFacts,
  workflowTaskSummary,
  type ToolRowLocaleKey,
} from '../../src/client/tool-rows-model.js'

const en: (key: ToolRowLocaleKey) => string = key => toolRowEn[key]
const zh: (key: ToolRowLocaleKey) => string = key => toolRowZh[key]

/** A running call: only the streamed argument JSON exists yet. */
function running(args: unknown) {
  return { callId: 'call-1', argsRaw: typeof args === 'string' ? args : JSON.stringify(args) } as never
}

/** A settled call: result blocks plus the arguments the call carried. */
function settled(args: unknown, content: readonly unknown[], rest: Record<string, unknown> = {}) {
  const argsRaw = typeof args === 'string' ? args : JSON.stringify(args)
  return { callId: 'call-1', kind: 'settled', content, call: { argsRaw }, ...rest } as never
}

const text = (value: string) => ({ type: 'text', text: value })

describe('parseArgs', () => {
  it('reads the streamed argument object', () => {
    expect(parseArgs('{"action":"read"}')).toEqual({ action: 'read' })
  })

  it('returns undefined for the truncated JSON prefix of a streaming call', () => {
    expect(parseArgs('{"role":"THEORY","prompt":"写')).toBeUndefined()
  })

  it('returns undefined for JSON that is not an object', () => {
    expect(parseArgs('"THEORY"')).toBeUndefined()
    expect(parseArgs('null')).toBeUndefined()
  })

  it('returns undefined for empty arguments', () => {
    expect(parseArgs('')).toBeUndefined()
  })
})

describe('toolRowFacts', () => {
  it('is running while the call has no result node', () => {
    expect(toolRowFacts(running({ role: 'THEORY' })).state).toBe('running')
  })

  it('is ok once a settled call carries no error', () => {
    expect(toolRowFacts(settled({}, [text('done')])).state).toBe('ok')
  })

  it('is error when the settled result is an error', () => {
    const facts = toolRowFacts(settled({}, [text('task-2 cannot be cancelled From completed')], { isError: true }))
    expect(facts.state).toBe('error')
    expect(facts.errorSummary).toBe('task-2 cannot be cancelled From completed')
  })

  it('is stopped, not error, when the call was interrupted', () => {
    const facts = toolRowFacts(settled({}, [], { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))
    expect(facts.state).toBe('stopped')
  })

  it('flattens an error with no content into its name and code', () => {
    const facts = toolRowFacts(settled({}, [], { isError: true, error: { name: 'TimeoutError', code: 'timeout' } }))
    expect(facts.output).toBe('TimeoutError: timeout')
  })

  it('leaves errorSummary empty outside the error state', () => {
    expect(toolRowFacts(settled({}, [text('updated')])).errorSummary).toBeNull()
  })
})

describe('callArgs', () => {
  it('reads the arguments a running call has streamed so far', () => {
    expect(callArgs(running({ action: 'read' }))).toBe('{"action":"read"}')
  })

  it('reads the arguments a settled call kept', () => {
    expect(callArgs(settled({ action: 'read' }, [text('ok')]))).toBe('{"action":"read"}')
  })

  it('is empty when the settled call carries no arguments', () => {
    expect(callArgs({ callId: 'call-1', kind: 'settled', content: [] } as never)).toBe('')
  })
})

describe('flattenResult', () => {
  it('joins text blocks and pretty-prints the rest', () => {
    expect(flattenResult(settled({}, [text('a'), { type: 'image', url: 'u' }])))
      .toBe('a\n{\n  "type": "image",\n  "url": "u"\n}')
  })

  it('is null for a running call', () => {
    expect(flattenResult(running({}))).toBeNull()
  })
})

describe('sendToAgentSummary', () => {
  it('names the role and the subject', () => {
    expect(sendToAgentSummary(JSON.stringify({ role: 'DATA_ANALYSIS', prompt: 'whatever', subject: 'fit the RLC curve' }), en))
      .toBe('DATA_ANALYSIS · fit the RLC curve')
  })

  it('falls back to the prompt first line when no subject was given', () => {
    expect(sendToAgentSummary(JSON.stringify({ role: 'THEORY', prompt: 'derive the transfer function\nsecond line' }), en))
      .toBe('THEORY · derive the transfer function')
  })

  it('names the task instead of the subject when redispatching', () => {
    expect(sendToAgentSummary(JSON.stringify({ role: 'REPORT', prompt: 'p', subject: 's', task_id: 'task-2' }), en))
      .toBe('REPORT · resend task-2')
  })

  it('is the bare role when neither subject nor prompt is usable', () => {
    expect(sendToAgentSummary(JSON.stringify({ role: 'PLOTTING' }), en)).toBe('PLOTTING')
  })

  it('is empty for arguments it cannot read', () => {
    expect(sendToAgentSummary('{"role":"THEORY","pro', en)).toBeUndefined()
    expect(sendToAgentSummary(JSON.stringify({ prompt: 'no role' }), en)).toBeUndefined()
  })
})

describe('workflowTaskSummary', () => {
  it('counts the whole board once the read settles', () => {
    const output = JSON.stringify({ tasks: [{ task_id: 'task-1' }, { task_id: 'task-2' }, { task_id: 'task-3' }] })
    expect(workflowTaskSummary(JSON.stringify({ action: 'read' }), output, en)).toBe('3 tasks')
  })

  it('has no summary at all before the read settles or when the board is unreadable', () => {
    expect(workflowTaskSummary(JSON.stringify({ action: 'read' }), null, en)).toBeUndefined()
    expect(workflowTaskSummary(JSON.stringify({ action: 'read' }), 'not json', en)).toBeUndefined()
    expect(workflowTaskSummary(JSON.stringify({ action: 'read' }), JSON.stringify({ tasks: 'nope' }), en)).toBeUndefined()
  })

  it('names the task and its status for a single-task read', () => {
    const output = JSON.stringify({ task: { task_id: 'task-2', status: 'in_progress' } })
    expect(workflowTaskSummary(JSON.stringify({ action: 'read', task_id: 'task-2' }), output, en))
      .toBe('Read task-2 · in_progress')
    expect(workflowTaskSummary(JSON.stringify({ action: 'read', task_id: 'task-2' }), null, en)).toBe('Read task-2')
  })

  it('counts the replacement checklist an update carries', () => {
    const steps = [{ description: 'a', done: true }, { description: 'b', done: true }, { description: 'c' }]
    expect(workflowTaskSummary(JSON.stringify({ action: 'update', task_id: 'task-2', steps }), null, en))
      .toBe('Update task-2 · 2/3 done')
  })

  it('drops the count when the checklist is missing or malformed', () => {
    expect(workflowTaskSummary(JSON.stringify({ action: 'update', task_id: 'task-2' }), null, en)).toBe('Update task-2')
    expect(workflowTaskSummary(JSON.stringify({ action: 'update', task_id: 'task-2', steps: 'nope' }), null, en))
      .toBe('Update task-2')
  })

  it('names the transition for cancel and reopen', () => {
    expect(workflowTaskSummary(JSON.stringify({ action: 'cancel', task_id: 'task-3' }), null, en)).toBe('Cancel task-3')
    expect(workflowTaskSummary(JSON.stringify({ action: 'reopen', task_id: 'task-4' }), null, en)).toBe('Reopen task-4')
  })

  it('is empty for an unknown action or unreadable arguments', () => {
    expect(workflowTaskSummary(JSON.stringify({ action: 'explode' }), null, en)).toBeUndefined()
    expect(workflowTaskSummary('{"action":"upd', null, en)).toBeUndefined()
  })

  it('speaks the shell locale', () => {
    const steps = [{ description: 'a', done: true }, { description: 'b', done: true }, { description: 'c' }]
    expect(workflowTaskSummary(JSON.stringify({ action: 'update', task_id: 'task-2', steps }), null, zh))
      .toBe('更新 task-2 · 2/3 勾选')
    expect(workflowTaskSummary(JSON.stringify({ action: 'read' }), JSON.stringify({ tasks: [] }), zh)).toBe('0 个任务')
  })
})
