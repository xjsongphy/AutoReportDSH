/**
 * The human-facing `/report-init` command: idempotent experiment workspace
 * initialization and resource materialization for the selected report
 * language.
 *
 * Registration wiring happens in the integration layer; this module exports a
 * factory so tests can exercise the handler against plain inputs without a
 * live Cordis context. The command is a recovery/explicit path — normal first
 * turns call `ensureInitialized` directly (see PLAN.md §2.10).
 *
 * `--language latex|typst` (PLAN.md §2.14) updates the EXTERNAL project
 * settings document and materializes missing resources for that language; it
 * never deletes the other backend's files, so `Report/main.tex` and
 * `Report/main.typ` may coexist with the project language authoritative.
 * Without the flag the stored project language wins, then the resolved
 * defaults — never filesystem inference.
 * @module workspace/command
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AutoReportProjectSettings } from '../settings.js'
import { ensureInitialized, type InitializationResult, type ReportLanguage } from './init.js'

/** Load/save seam over one workspace's external project-settings document. */
export interface ProjectSettingsStore {
  /** Read the current patch (missing file ⇒ `{}`); may throw loud on corruption. */
  load(): AutoReportProjectSettings
  /** Atomically replace the stored patch. */
  save(next: AutoReportProjectSettings): void
}

/** Inputs the factory needs that normally come from plugin configuration. */
export interface ReportInitCommandOptions {
  /**
   * Workspace root used when the invocation carries no explicit directory
   * argument and the invoking agent supplies no usable cwd.
   */
  readonly workspaceRoot?: string
  /**
   * Resolved fallback language used when neither the invocation flag nor the
   * project settings choose one.
   */
  readonly reportLanguage: ReportLanguage
  /**
   * Builds the external settings seam for the invoked workspace root; absent
   * (factory-only tests) keeps the command persistence-free.
   */
  readonly projectStore?: (root: string) => ProjectSettingsStore
}

/** One-line summary of one initialization pass, rendered by the command. */
export function renderInitialization(result: InitializationResult): string {
  const parts = [
    `directories created: ${result.createdDirs.length}`,
    `files written: ${result.writtenFiles.length}`,
    `files already present: ${result.skippedFiles.length}`,
  ]
  const detail = [
    ...result.createdDirs.map(dir => `+ ${dir}/`),
    ...result.writtenFiles.map(file => `+ ${file}`),
    ...result.skippedFiles.map(file => `= ${file} (kept)`),
  ]
  return [`Workspace ready (${parts.join(', ')}).`, ...detail].join('\n')
}

/** Parsed `/report-init` input: optional explicit language plus directory tail. */
export interface ParsedReportInitInput {
  /** Explicit `--language` value; absent defers to project/defaults. */
  readonly language: ReportLanguage | undefined
  /** Remaining positional text (the workspace directory), spaces preserved. */
  readonly directory: string
}

/** Parsed input carrying a user-facing failure instead of a result. */
export interface InvalidReportInitInput {
  readonly error: string
}

const REPORT_LANGUAGES: readonly ReportLanguage[] = ['latex', 'typst']

/**
 * Tokenize raw command input following dsh command conventions: flags may
 * appear anywhere, positional tokens keep their order, and multi-token
 * directories rejoin with single spaces.
 * @param rawInput - exact text after the command name.
 * @returns parsed input, or an `{ error }` describing the first violation.
 */
export function parseReportInitInput(rawInput: string): ParsedReportInitInput | InvalidReportInitInput {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  const positional: string[] = []
  let language: ReportLanguage | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '--language') {
      const value = tokens[index + 1]
      if (value === undefined) return { error: '--language requires a value: latex or typst.' }
      if (!(REPORT_LANGUAGES as readonly string[]).includes(value)) {
        return { error: `--language must be latex or typst, got ${value}.` }
      }
      language = value as ReportLanguage
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      return { error: `unknown option ${token}. Supported: --language latex|typst.` }
    }
    positional.push(token)
  }
  return { language, directory: positional.join(' ') }
}

/**
 * Resolve the workspace root for one invocation: an explicit argument wins,
 * then the invoking agent's session cwd, then configured default.
 * @param directory - parsed positional directory text (may be empty).
 * @param invocation - the raw command invocation.
 * @param options - factory options supplying the fallback root and language.
 * @returns absolute workspace root to initialize.
 */
function resolveWorkspaceRoot(
  directory: string,
  invocation: CommandInvocation,
  options: ReportInitCommandOptions,
): string | undefined {
  if (directory.length > 0) return directory
  const cwd = invocation.agent.session.header.cwd
  if (cwd !== undefined && cwd.length > 0) return cwd
  return options.workspaceRoot
}

/**
 * Build the `/report-init` command definition.
 * @param options - defaults for workspace root and report language, plus the
 *   optional external project-settings seam.
 * @returns the definition for `ctx.commands.register()`.
 */
export function createReportInitCommand(options: ReportInitCommandOptions): CommandDefinition {
  return {
    name: 'report-init',
    description: 'initialize or repair the experiment workspace layout and bundled report resources',
    input: { hint: '[--language latex|typst] [workspace-directory]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const parsed = parseReportInitInput(invocation.rawInput)
      if ('error' in parsed) return { kind: 'error', text: parsed.error }
      const root = resolveWorkspaceRoot(parsed.directory, invocation, options)
      if (root === undefined) {
        return {
          kind: 'error',
          text: 'No workspace directory available. Pass one: /report-init [--language latex|typst] <directory>.',
        }
      }
      try {
        const store = options.projectStore?.(root)
        const project: AutoReportProjectSettings = store?.load() ?? {}
        const language = parsed.language ?? project.reportLanguage ?? options.reportLanguage
        let saved = ''
        if (parsed.language !== undefined && store !== undefined) {
          // Record the explicit choice BEFORE materializing so a crash between
          // the two steps still leaves the authoritative language persisted.
          store.save({ ...project, reportLanguage: parsed.language })
          saved = ' (saved to project settings)'
        }
        const initialization = ensureInitialized(root, language)
        return {
          kind: 'success',
          text: `${renderInitialization(initialization)}\nreport language: ${language}${saved}`,
        }
      } catch (error: unknown) {
        return { kind: 'error', text: `report-init failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
