/**
 * Human-facing AutoReport workflow copy for DSH context rows.
 *
 * Model-facing JSON stays in the same message so observers can parse it;
 * Chat should show this prefix, with protocol details under the disclosure.
 * @module
 */

import type { SpecialistRole } from '../roles.js'
import type { WorkflowReportEnvelope } from './events.js'

/** `MessageSource.plugin` for turn-stopping steers in the durable session log. */
export const TURN_GUARD_PLUGIN = 'autoreportdsh/turn-guard'

/** Collapsed notice: MAIN was resumed because a subagent task is blocked. */
export const MAIN_STEER_SUMMARY = 'AutoReport resumed MAIN because a subagent is blocked'

/** Collapsed notice: subagent turn resumed to call report_workflow. */
export const REPORT_STEER_SUMMARY = 'AutoReport resumed subagent to report results'

/** Collapsed notice: subagent turn resumed to refresh describe_files. */
export const MANIFEST_STEER_SUMMARY = 'AutoReport resumed subagent to refresh file descriptions'

/**
 * Human relay prefix placed ahead of the durable JSON envelope.
 * @param role - reporting subagent role.
 * @param envelope - validated workflow report.
 * @returns model-and-Chat text; JSON follows separately.
 */
export function formatWorkflowRelay(role: SpecialistRole, envelope: WorkflowReportEnvelope): string {
  const heading = envelope.status === 'blocked'
    ? `⚠ ${role} → MAIN\n${envelope.task_id} blocked`
    : `✓ ${role} → MAIN\n${envelope.task_id} completed`
  const files = envelope.produced_files.length === 0
    ? undefined
    : `${envelope.produced_files.length} file${envelope.produced_files.length === 1 ? '' : 's'}\n${envelope.produced_files.map(path => path).join('\n')}`
  return [heading, envelope.response, files].filter(part => part !== undefined && part.length > 0).join('\n\n')
}

/**
 * Steer body listing stale semantic descriptions.
 * @param paths - workspace-relative stale files.
 * @returns model-facing repair instructions.
 */
export function formatManifestSteer(paths: readonly string[]): string {
  const listed = paths.map(path => `- ${path}`).join('\n')
  return [
    'You changed files whose manifest descriptions are stale.',
    'Update the semantic manifest for these files with describe_files before finishing:',
    listed,
  ].join('\n')
}
