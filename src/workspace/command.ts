/**
 * The human-facing `/init` command: idempotent experiment workspace
 * initialization and resource materialization for the selected report
 * language.
 *
 * Registration wiring happens in the integration layer; this module exports a
 * factory so tests can exercise the handler against plain inputs without a
 * live Cordis context. The command is a recovery/explicit path — normal first
 * turns call `ensureInitialized` directly (see PLAN.md §2.10).
 *
 * `--language latex|typst` (PLAN.md §2.18) records the choice in the
 * authoritative per-workspace map and materializes missing resources for that
 * language; the host switches the workspace's templates from that record, so a
 * template this command never deleted is deleted there instead. A bare
 * `latex`/`typst` token means the same flag, because the command is typed by
 * hand. Without a language the recorded map wins, then the legacy project
 * setting, then the resolved defaults — never filesystem inference.
 * @module workspace/command
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { AutoReportProjectSettings } from '../settings.js'
import { ensureInitialized, type InitializationResult, type ReportLanguage } from './init.js'

/** Read-only seam over one workspace's legacy external project-settings document. */
export interface LegacyProjectSettingsSource {
  /** Read the current patch (missing file ⇒ `{}`); may throw loud on corruption. */
  load(): AutoReportProjectSettings
}

/**
 * Authoritative per-workspace language seam over the `autoreport` settings
 * namespace. Writing records the choice; the host turns that record into the
 * workspace's template switch, so this command never deletes files itself.
 */
export interface WorkspaceLanguageStore {
  /** Language recorded for one workspace root, or undefined when none is. */
  read(root: string): ReportLanguage | undefined
  /** Record the choice (fire-and-forget; the host reports its own failures). */
  write(root: string, language: ReportLanguage): void
}

/** Inputs the factory needs that normally come from plugin configuration. */
export interface ReportInitCommandOptions {
  /**
   * Workspace root used when the invocation carries no explicit directory
   * argument and the invoking agent supplies no usable cwd.
   */
  readonly workspaceRoot?: string
  /**
   * Resolved fallback language used when neither the invocation flag, the
   * recorded map, nor the legacy project settings choose one.
   */
  readonly reportLanguage: ReportLanguage
  /** Current DSH user default; read at invocation time when no record/flag wins. */
  readonly currentDefaultReportLanguage?: () => ReportLanguage
  /**
   * Builds the legacy project-settings reader for the invoked workspace root;
   * absent (factory-only tests) reads no legacy value.
   */
  readonly legacyProject?: (root: string) => LegacyProjectSettingsSource
  /**
   * Authoritative language seam; absent (factory-only tests) keeps the command
   * from recording anything, so it only materializes resources.
   */
  readonly languageStore?: WorkspaceLanguageStore
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

/** Parsed `/init` input: optional explicit language plus directory tail. */
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
      return { error: `unknown option ${token}. Supported: latex|typst, or --language latex|typst.` }
    }
    // A bare `latex`/`typst` anywhere is the language, so `/init typst ~/exp`
    // and `/init ~/exp typst` both work. Only the first one counts: a second
    // stays positional, which keeps a directory named `latex` reachable as
    // `./latex`.
    if (language === undefined && (REPORT_LANGUAGES as readonly string[]).includes(token)) {
      language = token as ReportLanguage
      continue
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
 * Build the `/init` command definition.
 * @param options - defaults for workspace root and report language, plus the
 *   optional external project-settings seam.
 * @returns the definition for `ctx.commands.register()`.
 */
export function createReportInitCommand(options: ReportInitCommandOptions): CommandDefinition {
  return {
    name: 'init',
    description: 'initialize or repair the experiment workspace layout and bundled report resources',
    input: { hint: '[--language] latex|typst [workspace-directory]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const parsed = parseReportInitInput(invocation.rawInput)
      if ('error' in parsed) return { kind: 'error', text: parsed.error }
      const root = resolveWorkspaceRoot(parsed.directory, invocation, options)
      if (root === undefined) {
        return {
          kind: 'error',
          text: 'No workspace directory available. Pass one: /init [--language latex|typst] <directory>.',
        }
      }
      try {
        const legacy: AutoReportProjectSettings = options.legacyProject?.(root).load() ?? {}
        const language = parsed.language
          ?? options.languageStore?.read(root)
          ?? legacy.reportLanguage
          ?? options.currentDefaultReportLanguage?.()
          ?? options.reportLanguage
        let saved = ''
        if (parsed.language !== undefined && options.languageStore !== undefined) {
          // Record the explicit choice BEFORE materializing so a crash between
          // the two steps still leaves the authoritative language persisted.
          // The write is also what makes the host switch the templates, so this
          // command never deletes a file itself.
          options.languageStore.write(root, parsed.language)
          saved = ' (saved to settings)'
        }
        const initialization = ensureInitialized(root, language)
        return {
          kind: 'success',
          text: `${renderInitialization(initialization)}\nreport language: ${language}${saved}`,
        }
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: 'init failed: ' + (error instanceof Error ? error.message : String(error)),
        }
      }
    },
  }
}
