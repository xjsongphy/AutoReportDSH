import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SpecialistRole } from '../roles.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { formatWorkflowRelay } from '../workflow/display.js'
import { staleDescribedPathsForDelegation } from '../workflow/file-notes.js'
import { hasAcceptedWorkflowReport } from '../workflow/report-observer.js'
import { parseWorkflowEnvelope } from '../workflow/protocol.js'

function runtimeOf(hostCtx: Context): AutoReportWorkflowRuntime | undefined {
  const getter = (hostCtx as { get?: (name: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      return getter.call(hostCtx, 'autoreportWorkflow') as AutoReportWorkflowRuntime | undefined
    } catch {
      return undefined
    }
  }
  return (hostCtx as { autoreportWorkflow?: AutoReportWorkflowRuntime }).autoreportWorkflow
}

/**
 * Install the structured Main report tool.
 * `report_workflow(success)` refuses stale file descriptions.
 * @param childCtx - unpublished specialist scope.
 * @param hostCtx - host context carrying the shared subagent service.
 * @param role - bound specialist identity rendered in guidance.
 * @returns disposer for the scoped tools and prompt section.
 */
export function installWorkflowReportTool(childCtx: Context, hostCtx: Context, role: SpecialistRole): () => void {
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:report-workflow',
    order: 117,
    text: `You are the ${role} subagent. After changing files, update your manifest so each path has a fresh description. Before finishing any Main-dispatched task, call report_workflow once with the exact task_id and delegation_revision from your briefing. Success reports are rejected while descriptions are stale. Reporting does not end the turn. The generic report tool is unavailable.`,
  })
  const disposers: (() => void)[] = []
  try {
    disposers.push(childCtx.tools.register(defineTool({
      name: 'report_workflow',
      description: 'Return a validated AutoReport task outcome to Main. Use the exact task and delegation identities from the briefing.',
      parameters: {
        task_id: { type: 'string', required: true },
        delegation_revision: { type: 'number', required: true },
        status: { type: 'string', required: true, enum: ['success', 'blocked'] },
        block_type: { type: 'string', enum: ['missing_data', 'quality'], description: 'Required only for blocked status.' },
        response: { type: 'string', required: true },
        produced_files: { type: 'array', items: { type: 'string' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `workflow report accepted as message ${value.messageId}` }],
      },
      async execute(args, exec) {
        const parsed = parseWorkflowEnvelope({
          task_id: args.task_id,
          delegation_revision: args.delegation_revision,
          status: args.status,
          block_type: args.status === 'success' ? null : args.block_type,
          response: args.response,
          produced_files: args.produced_files ?? [],
        })
        if (!parsed.ok) throw new Error(`invalid workflow report: ${parsed.reason}`)
        const runtime = runtimeOf(hostCtx)
        const owner = runtime?.workflowForChild((exec.agent as Agent).id)
        const attempt = owner?.runtime.state.delegationAt(parsed.value.task_id, parsed.value.delegation_revision)
        if (attempt !== undefined && hasAcceptedWorkflowReport(attempt) && attempt.reportMessageId !== undefined) {
          return { messageId: attempt.reportMessageId }
        }
        if (parsed.value.status === 'success' && attempt !== undefined && owner !== undefined) {
          const stale = staleDescribedPathsForDelegation(owner.runtime.state.projection(), attempt)
          if (stale.length > 0) {
            throw new Error(
              `Cannot complete task: manifest descriptions are stale for:\n${stale.map(path => `- ${path}`).join('\n')}\nUpdate the manifest before reporting.`,
            )
          }
        }
        const content: ContentBlock[] = [
          { type: 'text', text: `${formatWorkflowRelay(role, parsed.value)}\n\nDetails\n` },
          { type: 'text', text: JSON.stringify(parsed.value) },
        ]
        const messageId = await hostCtx.subagents.reportFrom(exec.agent as Agent, content, {
          delivery: 'next-step',
          signal: exec.signal,
        })
        return { messageId: String(messageId) }
      },
      presentCall: args => ({ card: 'generic', title: `report_workflow ${String(args.status)}`, kind: 'other', rawInput: args }),
    })))
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // Best-effort rollback of partial registrations before rethrowing.
      }
    }
    disposeSection()
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch (caught: unknown) {
        failures.push(caught)
      }
    }
    try {
      disposeSection()
    } catch (caught: unknown) {
      failures.push(caught)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke AutoReport subagent workflow tools')
    }
  }
}
