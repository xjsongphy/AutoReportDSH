import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  compileCommandLanguage,
  createSkillGateGuard,
  SkillLoadTracker,
  resetSkillGates,
} from '../src/policy/skill-gate.js'
import { reportSkillRequirements, skillNamesForRole } from '../src/skills-preset.js'

afterEach(() => { resetSkillGates() })

const RUNTIME_SKILLS = reportSkillRequirements('latex')

describe('compileCommandLanguage', () => {
  it('recognizes every LaTeX compiler the workspace compile skill names', () => {
    for (const compiler of ['latexmk', 'tectonic', 'xelatex', 'pdflatex', 'lualatex']) {
      expect(compileCommandLanguage(`${compiler} main.tex`)).toBe('latex')
    }
  })

  it('recognizes typst only with its compile subcommand', () => {
    expect(compileCommandLanguage('typst compile Report/main.typ Report/main.pdf')).toBe('typst')
    expect(compileCommandLanguage('typst --version')).toBeUndefined()
    expect(compileCommandLanguage('typst watch Report/main.typ')).toBeUndefined()
  })

  it('finds the compiler behind separators, prefixes, and absolute paths', () => {
    expect(compileCommandLanguage('cd Report && latexmk -xelatex main.tex')).toBe('latex')
    expect(compileCommandLanguage('latexmk main.tex | tee build.log')).toBe('latex')
    expect(compileCommandLanguage('sudo /usr/local/bin/latexmk -pdf main.tex')).toBe('latex')
    expect(compileCommandLanguage('FOO=1 xelatex main.tex')).toBe('latex')
    expect(compileCommandLanguage('xelatex a.tex; latexmk b.tex')).toBe('latex')
  })

  it('does not mistake a mention of a compiler for an invocation', () => {
    expect(compileCommandLanguage('grep -E "latexmk" Report/build.log')).toBeUndefined()
    expect(compileCommandLanguage("echo 'run latexmk to build'")).toBeUndefined()
    expect(compileCommandLanguage('echo extra >> Report/main.tex')).toBeUndefined()
    expect(compileCommandLanguage('cat Report/main.tex')).toBeUndefined()
    expect(compileCommandLanguage('rg latexmk --type md')).toBeUndefined()
  })
})

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
    tracker.observe(session, callEvent('skill', { name: 'latex-compile' }))
    expect(tracker.missing('s1', ['latex-compile'])).toEqual(['latex-compile'])
    tracker.observe(session, resultEvent(skillContent('latex-compile')))
    expect(tracker.missing('s1', ['latex-compile'])).toEqual([])
  })

  it('does not count a failed skill call, nor a mention of the marker in other text', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('s1')
    tracker.observe(session, callEvent('skill', { name: 'latex-compile' }))
    tracker.observe(session, resultEvent('skill "latex-compile" is unknown', 'call-1', true))
    expect(tracker.missing('s1', ['latex-compile'])).toEqual(['latex-compile'])

    // A successful result for a DIFFERENT call cannot launder the marker in.
    tracker.observe(session, callEvent('read', { file_path: '/x' }, 'call-2'))
    tracker.observe(session, resultEvent(skillContent('latex-compile'), 'call-2'))
    expect(tracker.missing('s1', ['latex-compile'])).toEqual(['latex-compile'])
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
    tracker.observe(session, callEvent('skill', { name: 'latex-compile' }))
    tracker.observe(session, resultEvent(skillContent('latex-compile')))
    // ...and seeding must still recover an EARLIER load from the log.
    const resumed = fakeSession('s1', [
      callEvent('skill', { name: 'experiment-report-writer' }, 'old-1'),
      resultEvent(skillContent('experiment-report-writer'), 'old-1'),
    ])
    tracker.ensureSeeded(resumed)
    // Nothing the writing gate needs is missing any more.
    expect(tracker.missing('s1', [...RUNTIME_SKILLS.writing, RUNTIME_SKILLS.compile])).toEqual([])
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

  it('phrases a single missing skill as one', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    // Both writing skills loaded, so only the compile skill is missing.
    for (const name of RUNTIME_SKILLS.writing) tracker.markLoaded('report-1', name)
    const denial = guardFor({ role: 'REPORT', tracker })(
      execution('bash', { command: 'latexmk main.tex' }, session),
    ) ?? ''
    expect(denial).toMatch(/Load it with the `skill` tool/)
    // Exactly the one skill that was missing, not the whole requirement set.
    const named = [...RUNTIME_SKILLS.writing, RUNTIME_SKILLS.compile].filter(name => denial.includes(`\`${name}\``))
    expect(named).toEqual(['latex-compile'])
  })

  it('admits the same write once the writing skills are loaded', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    for (const name of RUNTIME_SKILLS.writing) tracker.markLoaded('report-1', name)
    const guard = guardFor({ role: 'REPORT', tracker })
    expect(guard(execution('write', { file_path: 'Report/main.tex', content: 'x' }, session))).toBeUndefined()
    expect(guard(execution('edit', { file_path: 'Report/main.tex', content: 'x' }, session))).toBeUndefined()
  })

  it('refuses the compiler until the compile skill is loaded, and leaves other bash alone', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-1')
    for (const name of RUNTIME_SKILLS.writing) tracker.markLoaded('report-1', name)
    const guard = guardFor({ role: 'REPORT', tracker })

    const denied = guard(execution('bash', { command: 'cd Report && latexmk -xelatex main.tex' }, session))
    expect(denied).toBeDefined()
    expect(denied).toContain('`latex-compile`')
    // Writing skills alone do not authorize a compile.
    expect(denied).not.toContain('experiment-report-writer')

    // A shell command that only mentions the compiler is not a compilation.
    expect(guard(execution('bash', { command: 'rg latexmk Report/build.log' }, session))).toBeUndefined()

    tracker.markLoaded('report-1', 'latex-compile')
    expect(guard(execution('bash', { command: 'latexmk main.tex' }, session))).toBeUndefined()
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

  it('gates only the active language', () => {
    const tracker = new SkillLoadTracker()
    const session = fakeSession('report-typst')
    for (const name of reportSkillRequirements('typst').writing) tracker.markLoaded('report-typst', name)
    const guard = guardFor({ role: 'REPORT', language: 'typst', tracker })
    // The child's own compiler is gated...
    expect(guard(execution('bash', { command: 'typst compile Report/main.typ' }, session)))
      .toContain('`typst-compile`')
    // ...and a foreign toolchain is not this requirement's business.
    expect(guard(execution('bash', { command: 'latexmk main.tex' }, session))).toBeUndefined()
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
  it('gates the writer for both languages and each language own compiler', () => {
    expect(reportSkillRequirements('latex').writing).toEqual(['experiment-report-writer'])
    expect(reportSkillRequirements('latex').compile).toBe('latex-compile')
    expect(reportSkillRequirements('typst').writing).toEqual(['experiment-report-writer'])
    expect(reportSkillRequirements('typst').compile).toBe('typst-compile')
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
      for (const name of [...required.writing, required.compile, ...required.references]) {
        expect(registered).toContain(name)
      }
    }
  })
})
