/**
 * Report-skill gates: hold a REPORT child to the skills that govern what it is
 * about to do, and refuse — with a message the model can act on — when it has
 * not loaded them.
 *
 * Registering a skill only publishes a catalog line; the body arrives when the
 * model loads it. A REPORT child can therefore write report prose, or run the
 * compiler, before ever reading the instructions that govern either. The gate
 * refuses that call through `ctx.tools.guard()` and names the exact skills to
 * load. **The model loads them itself with DSH's `skill` tool** — the harness
 * injects nothing on its behalf, so the transcript records a real tool call by
 * the agent that actually needed the instructions, and no fabricated model
 * action ever enters the durable log.
 *
 * The gate therefore reads the session's own stream to know what is loaded: a
 * `skill` call that returned the rendered `<skill_content>` block, or a
 * `skill-invocation`-sourced message. A failed call, a denial, or a mere
 * mention of a marker in unrelated text never counts.
 *
 * The file-mutation gate covers every tool {@link MUTATION_TOOL_NAMES} names
 * (the same set the role guard authorizes against), because any mutation a
 * REPORT child can make lands in `Report/`; a `str_replace_editor` view is a
 * read and stays ungated.
 *
 * A refused child is never stuck: it keeps `read`, non-compiler `bash`,
 * `manifest`, and `report_workflow(blocked)`, so it can report the blockage.
 * Only AutoReport-bound REPORT sessions are gated — MAIN, every other role, and
 * every stock DSH session pass through untouched.
 *
 * @module autoreportdsh/skill-gate
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { AutoReportRole } from '../roles.js'
import {
  reportSkillRequirements,
  type ReportSkillLanguage,
  type ReportSkillRequirements,
} from '../skills-preset.js'
import { MUTATION_TOOL_NAMES } from './tool-guard.js'

/** Shell tools whose command text is inspected for a compiler invocation. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** Compilers for the LaTeX report language, as the workspace compile skill names them. */
const LATEX_COMPILERS: readonly string[] = ['latexmk', 'tectonic', 'xelatex', 'pdflatex', 'lualatex']

/**
 * Wrappers that lead a command without changing which program runs. A gate that
 * ignored them would let `sudo latexmk` past the compile requirement.
 */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', 'setsid', 'stdbuf',
])

/** Shell separators that each begin an independent command. */
const SEGMENT_SEPARATOR = /[;&|()\n]/u

/** An inline environment assignment prefix (`FOO=bar cmd`). */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u

/** The `<skill_content>` marker `renderSkillContent` emits, as a capture. */
const SKILL_CONTENT_MARKER = /<skill_content name="([a-z0-9-]+)">/gu

/**
 * Which report language's compiler a shell command invokes, if any.
 *
 * The check is structural rather than textual: the command is split on shell
 * separators and only each segment's leading program word is considered, so
 * `grep -E "latexmk" Report/main.log` and `echo 'run latexmk'` are not
 * compiler invocations. `typst` counts only with its `compile` subcommand —
 * `typst --version` is not a report compilation.
 * @param command - raw shell command text from the tool call.
 * @returns the invoked compiler's language, or undefined when none is invoked.
 */
export function compileCommandLanguage(command: string): ReportSkillLanguage | undefined {
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const tokens = segment.trim().split(/\s+/u).filter(token => token.length > 0)
    let index = 0
    while (index < tokens.length) {
      const token = tokens[index] ?? ''
      if (COMMAND_PREFIXES.has(programName(token)) || ENV_ASSIGNMENT.test(token)) {
        index += 1
        continue
      }
      break
    }
    const head = programName(tokens[index] ?? '')
    if (head.length === 0) continue
    if (LATEX_COMPILERS.includes(head)) return 'latex'
    if (head === 'typst' && programName(tokens[index + 1] ?? '') === 'compile') return 'typst'
  }
  return undefined
}

/** A command word reduced to its program name, ignoring any path and quoting. */
function programName(token: string): string {
  const unquoted = token.replace(/^['"]|['"]$/gu, '')
  const separator = unquoted.lastIndexOf('/')
  return separator === -1 ? unquoted : unquoted.slice(separator + 1)
}

/**
 * Skill names {@link renderSkillContent} marked as loaded inside one tool result.
 *
 * Reads the text blocks themselves rather than a serialization of them: a
 * `JSON.stringify` pass would escape the quotes in `name="..."` and the marker
 * would never match.
 */
function markedSkillNames(content: unknown): string[] {
  const names: string[] = []
  for (const match of collectText(content).matchAll(SKILL_CONTENT_MARKER)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  return names
}

/** Every `text` block's text inside one content array, joined. */
function collectText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Skills a session has loaded, observed from its durable events rather than
 * from model prose. This is the gate's whole notion of "the instructions are
 * present": evidence the model received the body, nothing weaker.
 */
export class SkillLoadTracker {
  private readonly loaded = new Map<string, Set<string>>()
  /** Open `skill` tool calls, keyed by `callId`, so a result can be attributed. */
  private readonly openSkillCalls = new Map<string, Map<string, string>>()
  private readonly seeded = new Set<string>()

  /** Fold whatever this session already logged (a resumed child) exactly once. */
  ensureSeeded(session: Session): void {
    const id = String(session.id)
    if (this.seeded.has(id)) return
    this.seeded.add(id)
    for (const event of session.snapshotEvents()) this.absorb(id, event)
  }

  /**
   * Fold one newly appended event.
   *
   * Deliberately does NOT mark the session seeded: a live event may arrive
   * before the first guard call, and claiming the session here would make
   * {@link ensureSeeded} skip the earlier events that call must still see.
   */
  observe(session: Session, event: SessionEvent): void {
    this.absorb(String(session.id), event)
  }

  /** Which of these names the session has not loaded yet. */
  missing(sessionId: string, names: readonly string[]): string[] {
    return names.filter(name => this.loaded.get(sessionId)?.has(name) !== true)
  }

  /** Record a skill body as present for this session. */
  markLoaded(sessionId: string, name: string): void {
    setFor(this.loaded, sessionId).add(name)
  }

  /** Drop every observation for one session, e.g. when its child is disposed. */
  forget(sessionId: string): void {
    this.loaded.delete(sessionId)
    this.openSkillCalls.delete(sessionId)
    this.seeded.delete(sessionId)
  }

  /** Drop every observation, across all sessions (test isolation). */
  clear(): void {
    this.loaded.clear()
    this.openSkillCalls.clear()
    this.seeded.clear()
  }

  private absorb(sessionId: string, event: SessionEvent): void {
    if (event.type === 'tool/call') {
      if (event.data.name !== 'skill') return
      const name = skillToolArgument(event.data.arguments)
      if (name === undefined) return
      nestedFor(this.openSkillCalls, sessionId).set(String(event.data.callId), name)
      return
    }
    if (event.type === 'tool/result') {
      const open = this.openSkillCalls.get(sessionId)
      const block = event.data.message.content[0]
      const callId = String(block.toolCallId)
      const name = open?.get(callId)
      if (name === undefined) return
      open?.delete(callId)
      // A denied or failed call is not a load; the rendered marker is what the
      // model actually received.
      if (event.data.error !== undefined || block.isError === true) return
      if (markedSkillNames(block.content).includes(name)) this.markLoaded(sessionId, name)
      return
    }
    if (event.type === 'user/message') {
      const source = event.data.source as { kind?: unknown; name?: unknown }
      if (source.kind === 'skill-invocation' && typeof source.name === 'string') {
        this.markLoaded(sessionId, source.name)
      }
    }
  }
}

/** The `name` argument of a `skill` tool call, parsed from its raw JSON text. */
function skillToolArgument(argumentsText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const name = (parsed as { name?: unknown }).name
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

function setFor(store: Map<string, Set<string>>, key: string): Set<string> {
  let value = store.get(key)
  if (value === undefined) {
    value = new Set()
    store.set(key, value)
  }
  return value
}

function nestedFor(store: Map<string, Map<string, string>>, key: string): Map<string, string> {
  let value = store.get(key)
  if (value === undefined) {
    value = new Map()
    store.set(key, value)
  }
  return value
}

/**
 * The process-wide tracker. The host guard and the session-event observer must
 * see one instance, or a load recorded by one is invisible to the other.
 */
export const skillLoadTracker = new SkillLoadTracker()

/** Clear all tracked state (test isolation). */
export function resetSkillGates(): void {
  skillLoadTracker.clear()
}

/** Inputs the skill gate needs to identify and classify a calling session. */
export interface SkillGateOptions {
  /** Role bound to the calling session, or undefined when it is not AutoReport-owned. */
  readonly roleOf: (sessionId: string) => AutoReportRole | undefined
  /** Frozen report language of the calling session. */
  readonly languageOf: (sessionId: string) => ReportSkillLanguage | undefined
  /** Shared load tracker; defaults to {@link skillLoadTracker}. */
  readonly tracker?: SkillLoadTracker | undefined
}

/** The action a call is about to take, if it is one this gate governs. */
function gatedAction(
  exec: Readonly<ToolExecution>,
  requirements: ReportSkillRequirements,
  language: ReportSkillLanguage,
): { readonly label: string; readonly required: readonly string[] } | undefined {
  if (MUTATION_TOOL_NAMES.has(exec.name)) {
    if (exec.name === 'str_replace_editor' && isViewCall(exec)) return undefined
    return { label: 'modifying report files', required: requirements.writing }
  }
  if (!SHELL_TOOL_NAMES.has(exec.name)) return undefined
  const command = shellCommand(exec)
  if (command === undefined) return undefined
  // Only the ACTIVE language's compiler is gated; a REPORT child running some
  // other toolchain is not this requirement's business.
  if (compileCommandLanguage(command) !== language) return undefined
  return { label: 'running the report compiler', required: [requirements.compile] }
}

function isViewCall(exec: Readonly<ToolExecution>): boolean {
  const args = exec.arguments
  return typeof args === 'object' && args !== null
    && (args as { command?: unknown }).command === 'view'
}

function shellCommand(exec: Readonly<ToolExecution>): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

/**
 * The model-facing refusal. It has to carry everything the model needs to
 * recover on its own: what was refused, which skill to load, how to load it,
 * and the fact that the call itself was otherwise fine — so the model loads the
 * skill instead of rewriting a call that had nothing wrong with it.
 */
function denialText(tool: string, action: string, missing: readonly string[]): string {
  const names = missing.map(name => `\`${name}\``).join(', ')
  const pronoun = missing.length > 1 ? 'them' : 'it'
  return `AutoReport refused this ${tool} call: the REPORT role must load ${names} before ${action}. `
    + `Load ${pronoun} with the \`skill\` tool (one call per name), then retry this exact call unchanged. `
    + 'Nothing else about this call was wrong; only the missing skill blocks it.'
}

/**
 * Create the report-skill gate registered through `ctx.tools.guard()`.
 * @param options - role, language, and tracker inputs supplied by the host runtime.
 * @returns synchronous guard that refuses a call whose governing skill is absent.
 */
export function createSkillGateGuard(options: SkillGateOptions): ToolGuard {
  const tracker = options.tracker ?? skillLoadTracker
  return exec => {
    const session = exec.agent?.session
    if (session === undefined) return undefined
    const sessionId = String(session.id)
    if (options.roleOf(sessionId) !== 'REPORT') return undefined
    const language = options.languageOf(sessionId)
    if (language === undefined) return undefined

    const action = gatedAction(exec, reportSkillRequirements(language), language)
    if (action === undefined || action.required.length === 0) return undefined

    tracker.ensureSeeded(session)
    const missing = tracker.missing(sessionId, action.required)
    if (missing.length === 0) return undefined
    return denialText(exec.name, action.label, missing)
  }
}
