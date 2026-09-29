import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  createSkillGateGuard,
  SkillLoadTracker,
  resetSkillGates,
} from '../src/policy/skill-gate.js'
import { reportSkillRequirements, skillNamesForRole } from '../src/skills-preset.js'

afterEach(() => { resetSkillGates() })

const RUNTIME_SKILLS = reportSkillRequirements('latex')

/** Minimal session double: the tracker reads only identity and the durable log. */
function fakeSession(id: string, events: SessionEvent[] = []) {
  return {
    id: SessionId(id),
    header: { cwd: '/tmp/autoreport-skill-gate' },
    snapshotEvents: () => events,
  } as unknown as Session
}

function callEvent(name: string, args: unknown, callId = 'call-1'): SessionEvent {
  return {
    type: 'tool/call',
    seq: 1,
    time: 1,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  } as unknown as SessionEvent
}

function resultEvent(text: string, callId = 'call-1', isError = false): SessionEvent {
  return {
    type: 'tool/result',
    seq: 2,
    time: 2,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        id: `m-${callId}`,
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
        source: { kind: 'tool', callId },
      },
    },
  } as unknown as SessionEvent
}

function skillContent(name: string): string {
  return `<skill_content name="${name}">\n<skill_instructions>\nbody\n</skill_instructions>\n</skill_content>`
}

/** The text a message carries, read the way the model reads it. */
function messageText(message: UserMessage): string {
  return message.content
    .map(block => (block as { text?: string }).text ?? '')
    .join('\n')
}

describe('SkillLoadTracker', () => {
  it('counts a skill as loaded only when the skill tool returned its content', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('s1')
    tracker.observe(session, callEvent('skill', { name: 'experiment-report-writer' }))
    expect(tracker.missing('s1', ['experiment-report-writer'])).toEqual(['experiment-report-writer'])
    tracker.observe(session, resultEvent(skillContent('experiment-report-writer')))
    expect(tracker.missing('s1', ['experiment-report-writer'])).toEqual([])
  })

  it('does not count a failed skill call, nor a mention of the marker in other text', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('s1')
    tracker.observe(session, callEvent('skill', { name: 'experiment-report-writer' }))
    tracker.observe(session, resultEvent('skill "experiment-report-writer" is unknown', 'call-1', true))
    expect(tracker.missing('s1', ['experiment-report-writer'])).toEqual(['experiment-report-writer'])

    // A successful result for a DIFFERENT call cannot launder the marker in.
    tracker.observe(session, callEvent('read', { file_path: '/x' }, 'call-2'))
    tracker.observe(session, resultEvent(skillContent('experiment-report-writer'), 'call-2'))
    expect(tracker.missing('s1', ['experiment-report-writer'])).toEqual(['experiment-report-writer'])
  })

  it('counts a skill-invocation message, which is how a user-explicit load arrives', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('s1')
    tracker.observe(session, {
      type: 'user/message',
      seq: 3,
      time: 3,
      data: createUserMessage({
        content: [{ type: 'text', text: skillContent('experiment-report-writer') }],
        source: { kind: 'skill-invocation', name: 'experiment-report-writer', form: 'instructions' },
      }),
    } as unknown as SessionEvent)
    expect(tracker.missing('s1', ['experiment-report-writer'])).toEqual([])
  })

  it('folds a resumed session log without hiding events seen before seeding', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('s1')
    // A live event arrives before the first guard call...
    tracker.observe(session, callEvent('skill', { name: 'typst' }))
    tracker.observe(session, resultEvent(skillContent('typst')))
    // ...and seeding must still recover an EARLIER load from the log.
    const resumed = fakeSession('s1', [
      callEvent('skill', { name: 'experiment-report-writer' }, 'old-1'),
      resultEvent(skillContent('experiment-report-writer'), 'old-1'),
    ])
    tracker.ensureSeeded(resumed)
    // Nothing the writing gate needs is missing any more.
    expect(tracker.missing('s1', [...RUNTIME_SKILLS.writing, 'typst'])).toEqual([])
  })
})

/** A tool execution-shaped input for the guard. */
function execution(name: string, args: unknown, session: Session): Readonly<ToolExecution> {
  return { name, arguments: args, agent: { session } } as unknown as Readonly<ToolExecution>
}

function guardFor(options: {
  role?: 'REPORT' | 'THEORY' | 'MAIN' | undefined
  language?: 'latex' | 'typst'
  tracker?: SkillLoadTracker
}) {
  return createSkillGateGuard({
    roleOf: () => options.role,
    languageOf: () => options.language ?? 'latex',
    ...(options.tracker === undefined ? {} : { tracker: options.tracker }),
  })
}

describe('createSkillGateGuard', () => {
  it('refuses a REPORT write while the writing skill is unloaded, and names it', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    const guard = guardFor({ role: 'REPORT', tracker })
    const denial = guard(execution('write', { file_path: 'Report/main.tex', content: 'x' }, session))
    expect(denial).toBeDefined()
    expect(denial).toContain('`experiment-report-writer`')
    expect(denial).toContain('write')
    // The active language's rules are prompt prose, not a skill: nothing to load.
    expect(denial).not.toContain('report-language')
    expect(guard(execution('compile_report', { path: 'Report/main.tex' }, session))).toBeUndefined()
  })

  it('tells the model how to recover, and that the call was otherwise fine', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    const denial = guardFor({ role: 'REPORT', tracker })(
      execution('edit', { file_path: 'Report/main.tex', content: 'x' }, session),
    ) ?? ''
    // The remedy is the model's own tool call: the harness injects nothing.
    expect(denial).toContain('`skill`')
    expect(denial).toMatch(/one call per name/)
    expect(denial).toMatch(/retry this exact call unchanged/i)
    expect(denial).toMatch(/nothing else about this call was wrong/i)
  })

  it('admits the same write once the writing skills are loaded', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    for (const name of RUNTIME_SKILLS.writing) tracker.markLoaded('report-1', name)
    const guard = guardFor({ role: 'REPORT', tracker })
    expect(guard(execution('write', { file_path: 'Report/main.tex', content: 'x' }, session))).toBeUndefined()
    expect(guard(execution('edit', { file_path: 'Report/main.tex', content: 'x' }, session))).toBeUndefined()
  })

  it('leaves reads, other roles, and stock sessions untouched', () => {
    const session = fakeSession('s')
    expect(guardFor({ role: 'REPORT' })(execution('str_replace_editor', { command: 'view', path: 'Report/a.tex' }, session)))
      .toBeUndefined()
    expect(guardFor({ role: 'THEORY' })(execution('write', { file_path: 'Theory/a.md' }, session))).toBeUndefined()
    expect(guardFor({ role: 'MAIN' })(execution('write', { file_path: 'Outline/a.md' }, session))).toBeUndefined()
    expect(guardFor({ role: undefined })(execution('write', { file_path: 'Report/a.tex' }, session))).toBeUndefined()
    // No agent at all: nothing to attribute the call to.
    expect(guardFor({ role: 'REPORT' })({ name: 'write', arguments: { file_path: 'x' } } as never)).toBeUndefined()
  })

  it('clears the refusal only when the session records the model loading the skill', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    const guard = guardFor({ role: 'REPORT', tracker })
    const write = execution('write', { file_path: 'Report/main.tex', content: 'x' }, session)

    expect(guard(write)).toBeDefined()
    tracker.observe(session, callEvent('skill', { name: 'experiment-report-writer' }, 'c1'))
    tracker.observe(session, resultEvent(skillContent('experiment-report-writer'), 'c1'))
    expect(guard(write)).toBeUndefined()
  })
})

describe('reportSkillRequirements', () => {
  it('gates writing skills and keeps Typst references optional', () => {
    expect(reportSkillRequirements('latex').writing).toEqual(['experiment-report-writer'])
    expect(reportSkillRequirements('typst').writing).toEqual(['experiment-report-writer'])
    // The typst reference index is registered but gates nothing.
    expect(reportSkillRequirements('typst').references).toEqual(['typst'])
    expect(reportSkillRequirements('latex').references).toEqual([])
  })

  it('gates only skills the REPORT role is actually given', () => {
    // A gate may never require a skill the child was never given, or it would
    // refuse forever with no remedy the model could reach.
    for (const language of ['latex', 'typst'] as const) {
      const registered = skillNamesForRole('REPORT', language)
      const required = reportSkillRequirements(language)
      for (const name of [...required.writing, ...required.references]) {
        expect(registered).toContain(name)
      }
    }
  })
})
