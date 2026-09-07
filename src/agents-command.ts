/** Human-facing `/agents` command for explicit resident-subagent activation. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { isAutoReportMainSession } from './membership.js'

/** Minimal runtime seam needed by the command. */
export interface ResidentActivator {
  activateResidentRoles(parent: Agent, signal?: AbortSignal): Promise<void>
}
/** Build the explicit command that starts or restores all resident subagents. */
export function createAgentsCommand(runtime: ResidentActivator): CommandDefinition {
  return {
    name: 'agents',
    description: 'start or restore all AutoReport subagents',
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      if (!isAutoReportMainSession(invocation.agent.session)) {
        return {
          kind: 'error',
          text: "agents is available only in an 'autoreport' session.",
        }
      }
      try {
        await runtime.activateResidentRoles(invocation.agent, invocation.signal)
        return { kind: 'success', text: 'AutoReport subagents are ready.' }
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: 'agents failed: ' + (error instanceof Error ? error.message : String(error)),
        }
      }
    },
  }
}
