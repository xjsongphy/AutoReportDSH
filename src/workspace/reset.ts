/**
 * The human-facing `/reset` command: put one experiment workspace back to a
 * freshly initialized state without touching what the user supplied.
 *
 * A reset clears the generated work — the coordinator's outline, the
 * specialist role outputs, the report sources AutoReport materializes, and the
 * processed datasets — and then re-runs initialization, so the workspace is
 * immediately usable under the language its record names. `References/` and
 * everything under `Data/` except `Data/Processed` are user inputs and are
 * never touched; the command names them in its result so a reset can never
 * quietly delete an experiment.
 *
 * The invoking session's own workflow (task board, delegations, role bindings)
 * is cleared with it — but only when the reset root is the workspace that
 * session's workflow is keyed by, so resetting a directory named on the
 * command line never wipes the board of the session that typed it.
 * @module workspace/reset
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureInitialized, type InitializationResult, type ReportLanguage } from './init.js'
import {
  resolveReportLanguage,
  resolveWorkspaceRoot,
  type ReportLanguageSources,
} from './command.js'

/**
 * Workspace-relative directories whose CONTENTS a reset removes. Every one of
 * them holds generated work — `Plots/` as a whole, because that is the
 * PLOTTING role's writable root and figures may sit at any depth below it —
 * and the directories themselves come back immediately through the
 * initialization pass that follows.
 */
export const RESET_DIRS: readonly string[] = Object.freeze([
  'Outline',
  'Theory',
  'Plots',
  'Report',
  'Data/Processed',
])

/** Read as the whole command's promise about user inputs, so it is rendered too. */
const KEPT_INPUTS = 'kept: Data/ (except Data/Processed), References/'

/** What one reset cleared, and what the initialization pass restored. */
export interface ResetResult {
  /** Reset targets that existed and were emptied, in layout order. */
  readonly clearedDirs: readonly string[]
  /** Direct entries removed across those targets; their subtrees went with them. */
  readonly removedEntries: number
  /** Directories the initialization pass created back. */
  readonly createdDirs: readonly string[]
  /** Files the initialization pass wrote back. */
  readonly writtenFiles: readonly string[]
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** One entry count in a report a human reads. */
function entryCount(count: number): string {
  return count === 1 ? '1 entry' : `${count} entries`
}

/** One-line summary of one reset pass, rendered by the command. */
export function renderReset(result: ResetResult): string {
  const cleared = result.clearedDirs.length === 0
    ? 'cleared: nothing generated'
    : `cleared: ${result.clearedDirs.join(', ')} (${entryCount(result.removedEntries)})`
  return [
    `Workspace reset (${cleared}).`,
    `directories created: ${result.createdDirs.length}, files written: ${result.writtenFiles.length}`,
    KEPT_INPUTS,
  ].join('\n')
}

/**
 * Clear one workspace's generated work and initialize it again.
 *
 * Contents are removed by deleting each target directory and letting the
 * initialization pass recreate it, so no stale entry can survive at any depth.
 * @param root - absolute workspace root to reset.
 * @param language - report language whose templates are materialized back.
 * @returns what was cleared and what came back.
 * @throws when the root is not an existing directory: a reset never creates a
 *   workspace, and a mistyped path must not silently become one.
 */
export function resetWorkspace(root: string, language: ReportLanguage): ResetResult {
  if (!isDirectory(root)) throw new Error(`workspace root is not a directory: ${root}`)
  const clearedDirs: string[] = []
  let removedEntries = 0
  for (const dir of RESET_DIRS) {
    const path = join(root, dir)
    if (!isDirectory(path)) continue
    // An empty target is already what a reset wants; only targets holding
    // something are cleared, so the report names real removals.
    const entries = readdirSync(path).length
    if (entries === 0) continue
    removedEntries += entries
    rmSync(path, { recursive: true, force: true })
    clearedDirs.push(dir)
  }
  const restored: InitializationResult = ensureInitialized(root, language)
  return {
    clearedDirs,
    removedEntries,
    createdDirs: restored.createdDirs,
    writtenFiles: restored.writtenFiles,
  }
}

/** Parsed `/reset` input: the workspace directory, spaces preserved. */
export interface ParsedReportResetInput {
  /** Remaining positional text (the workspace directory). */
  readonly directory: string
}

/** Parsed input carrying a user-facing failure instead of a result. */
export interface InvalidReportResetInput {
  readonly error: string
}

/**
 * Parse raw `/reset` input. The command takes a workspace directory and
 * nothing else, so any option-looking token is a usage error rather than
 * something silently ignored — a mistyped reset is not recoverable.
 * @param rawInput - exact text after the command name.
 * @returns the parsed directory, or an `{ error }` naming the first option.
 */
export function parseReportResetInput(rawInput: string): ParsedReportResetInput | InvalidReportResetInput {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  const option = tokens.find(token => token.startsWith('--'))
  if (option !== undefined) {
    return { error: `unknown option ${option}. /reset takes a workspace directory only.` }
  }
  return { directory: tokens.join(' ') }
}

/**
 * Clear the invoking session's workflow when the reset root is its own.
 *
 * A session's workflow log is keyed by the workspace that owns it, so a reset
 * of any other directory leaves this session's task board alone — the result
 * says which board was kept and where it lives.
 * @param invocation - the raw command invocation.
 * @param root - absolute workspace root being reset.
 * @param workflow - the runtime seam; absent in factory-only tests.
 * @returns the rendered task-board line, or an empty string without a seam.
 */
async function resetSessionWorkflow(
  invocation: CommandInvocation,
  root: string,
  workflow: ReportResetWorkflowSeam | undefined,
): Promise<string> {
  if (workflow === undefined) return ''
  const session = invocation.agent.session as Session | undefined
  if (session === undefined) return ''
  const own = workflow.root(session)
  if (own === undefined) return ''
  if (resolve(own) !== resolve(root)) return `\ntask board: left alone (${own})`
  await workflow.reset(session)
  return '\ntask board: this session workflow cleared'
}

/** Runtime seam for clearing one session's own workflow state. */
export interface ReportResetWorkflowSeam {
  /** Workspace root the invoking session's workflow log is keyed by. */
  root: (session: Session) => string | undefined
  /** Delete that session's workflow log and drop its cached state. */
  reset: (session: Session) => Promise<void> | void
}

/** Inputs the factory needs that normally come from plugin configuration. */
export interface ReportResetCommandOptions extends ReportLanguageSources {
  /** Configured workspace root used when the invocation names no directory. */
  readonly workspaceRoot?: string
  /** The invoking session's own workflow, when this deployment owns one. */
  readonly workflow?: ReportResetWorkflowSeam
}

/**
 * Build the `/reset` command definition.
 * @param options - workspace root and language sources, plus the optional
 *   invoking-session workflow seam.
 * @returns the definition for `ctx.commands.register()`.
 */
export function createReportResetCommand(options: ReportResetCommandOptions): CommandDefinition {
  return {
    name: 'reset',
    description: 'reset the experiment workspace: clear generated work, keep References/ and raw Data/',
    input: { hint: '[workspace-directory]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const parsed = parseReportResetInput(invocation.rawInput)
      if ('error' in parsed) return { kind: 'error', text: parsed.error }
      const root = resolveWorkspaceRoot(parsed.directory, invocation, options)
      if (root === undefined) {
        return {
          kind: 'error',
          text: 'No workspace directory available. Pass one: /reset <workspace-directory>.',
        }
      }
      try {
        const resolved = resolveReportLanguage(root, options)
        const result = resetWorkspace(root, resolved.language)
        const board = await resetSessionWorkflow(invocation, root, options.workflow)
        const warningLines = resolved.warnings.length > 0
          ? '\n' + resolved.warnings.map(w => `warning: ${w}`).join('\n')
          : ''
        return {
          kind: 'success',
          text: `${renderReset(result)}\nreport language: ${resolved.language}${board}${warningLines}`,
        }
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: 'reset failed: ' + (error instanceof Error ? error.message : String(error)),
        }
      }
    },
  }
}
