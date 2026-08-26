import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SpecialistRole } from '../roles.js'
import { parseWorkflowEnvelope } from '../workflow/protocol.js'

/**
 * Install the only child→Main return tool visible to an AutoReport specialist.
 * @param childCtx - unpublished specialist scope.
 * @param hostCtx - host context carrying the shared subagent service.
 * @param role - bound specialist identity rendered in guidance.
 * @returns disposer for the scoped tool and prompt section.
 */
export function installWorkflowReportTool(childCtx: Context, hostCtx: Context, role: SpecialistRole): () => void {
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:report-workflow',
    order: 117,
    text: `You are the ${role} specialist. Before finishing any Main-dispatched task, call report_workflow once with the exact task_id and delegation_revision from your briefing. Reporting does not end the turn. The generic report tool is unavailable.`,
  })
  let disposeTool: () => void
  try {
    disposeTool = childCtx.tools.register(defineTool({
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
        const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(parsed.value) }]
        const messageId = await hostCtx.subagents.reportFrom(exec.agent as Agent, content, {
          delivery: 'next-step',
          signal: exec.signal,
        })
        return { messageId: String(messageId) }
      },
      presentCall: args => ({ card: 'generic', title: `report_workflow ${String(args.status)}`, kind: 'other', rawInput: args }),
    }))
  } catch (error: unknown) {
    disposeSection()
    throw error
  }
  return () => {
    disposeTool()
    disposeSection()
  }
}
