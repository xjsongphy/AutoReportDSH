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
    text: `The generic report tool is unavailable; Main-dispatched tasks finish through report_workflow (see its description). After changing files, update your manifest so each path has a fresh description.`,
  })
  const disposers: (() => void)[] = []
  try {
    disposers.push(childCtx.tools.register(defineTool({
      name: 'report_workflow',
      description: [
        'Finish one Main-dispatched AutoReport task by returning its outcome to Main. Required before ending the turn on any Main dispatch; never used for ordinary conversation.',
        'Pass the exact task_id and delegation_revision from the task briefing.',
        'status="success" when the requested outcome is complete and self-checks pass; status="blocked" with block_type="missing_data" (required inputs absent, unreadable, or ambiguous) or "quality" (requirements conflict or scope is unclear) otherwise.',
        'response must be self-contained; produced_files lists workspace-relative paths you wrote.',
        'Success is rejected while your manifest has stale file descriptions — update descriptions for changed files via manifest first.',
        'Reporting does not end the turn; finish normally after an accepted report.',
      ].join(' '),
      parameters: {
        task_id: { type: 'string', required: true, description: 'Exact task id from the task briefing.' },
        delegation_revision: { type: 'number', required: true, description: 'Exact delegation revision from the task briefing.' },
        status: { type: 'string', required: true, enum: ['success', 'blocked'] },
        block_type: { type: 'string', enum: ['missing_data', 'quality'], description: 'Required only for blocked status.' },
        response: { type: 'string', required: true, description: 'Self-contained outcome summary: results, file paths, or what is missing/wrong.' },
        produced_files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths written for this task.' },
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
