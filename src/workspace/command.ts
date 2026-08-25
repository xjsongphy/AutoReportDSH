/**
 * The human-facing `/report-init` command: idempotent experiment workspace
 * initialization and resource materialization for the selected report
 * language.
 *
 * Registration wiring happens in the integration layer; this module exports a
 * factory so tests can exercise the handler against plain inputs without a
 * live Cordis context. The command is a recovery/explicit path — normal first
 * turns call `ensureInitialized` directly (see PLAN.md §2.10).
 * @module workspace/command
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { ensureInitialized, type InitializationResult, type ReportLanguage } from './init.js'

/** Inputs the factory needs that normally come from plugin configuration. */
export interface ReportInitCommandOptions {
  /**
   * Workspace root used when the invocation carries no explicit directory
   * argument and the invoking agent supplies no usable cwd.
   */
  readonly workspaceRoot?: string
  /** Report language selecting which bundled resources materialize. */
  readonly reportLanguage: ReportLanguage
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

/**
 * Resolve the workspace root for one invocation: an explicit argument wins,
 * then the invoking agent's session cwd, then configured default.
 * @param invocation - the raw command invocation.
 * @param options - factory options supplying the fallback root and language.
 * @returns absolute workspace root to initialize.
 */
function resolveWorkspaceRoot(invocation: CommandInvocation, options: ReportInitCommandOptions): string | undefined {
  const argument = invocation.rawInput.trim()
  if (argument.length > 0) return argument
  const cwd = invocation.agent.session.header.cwd
  if (cwd !== undefined && cwd.length > 0) return cwd
  return options.workspaceRoot
}

/**
 * Build the `/report-init` command definition.
 * @param options - defaults for workspace root and report language.
 * @returns the definition for `ctx.commands.register()`.
 */
export function createReportInitCommand(options: ReportInitCommandOptions): CommandDefinition {
  return {
    name: 'report-init',
    description: 'initialize or repair the experiment workspace layout and bundled report resources',
    input: { hint: '[workspace-directory]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const root = resolveWorkspaceRoot(invocation, options)
      if (root === undefined) {
        return {
          kind: 'error',
          text: 'No workspace directory available. Pass one: /report-init <directory>.',
        }
      }
      try {
        return { kind: 'success', text: renderInitialization(ensureInitialized(root, options.reportLanguage)) }
      } catch (error: unknown) {
        return { kind: 'error', text: `report-init failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
