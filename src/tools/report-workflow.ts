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
import { observedProducedFilesForDelegation } from '../workflow/file-notes.js'
import { genericCall } from './presentation.js'
import { WorkflowError } from '../workflow/errors.js'
import { staleDependencyReason } from '../workflow/graph.js'

/** Host-owned recovery guidance returned with a missing-input report to MAIN. */
export const MISSING_INPUT_RECOVERY = `AutoReport recovery guidance for MAIN:
Before asking the user for more data, classify the blocker with its scientific owner: an unavailable original observation/reference/condition, an unresolved model or convention, or a result that has not yet been computed. A missing result table is not evidence that the underlying data are absent. Do not ask the user to supply the quantities the specialist was assigned to derive.
If usable inputs and a model are present, return the unfinished analysis to its owner. If a completed task omitted a requested scientific outcome, reopen that original task and revise its result; an audit marked complete does not complete the analysis. Ensure required theoretical tasks are completed dependencies before model-dependent calculation, then run the affected scope. Retain unrelated completed work and respect downstream freshness; avoiding unnecessary reruns is not a reason to preserve an incomplete analysis.
For a genuine source lookup or interpretation check, create a narrowly scoped audit task without reopening completed scientific tasks during the lookup. Check supplied References/ documents, extracted tables, captions, units, corrections, raw images, and prior answers. Distinguish absent data from incomplete extraction or unreadable presentation. If MinerU could not adequately recognize a needed page, use extract_pdf with path, page, and extraction_issue to preview it. The audit must identify found inputs, what can now be calculated, and any specific unresolved ambiguity. When it finds usable evidence, return to the scientific task; do not repeat source-only audits or ask for precomputed answers.
For an unresolved physical model or mapping, route the question to THEORY or the responsible specialist. Require a concrete identification or adequacy check before accepting a claim that existing data cannot determine a requested quantity. Legitimate model-based estimates must state their applicability and uncertainty; do not fill absent measurements with predictions or arbitrary assumptions.
Ask the user only about an essential external input or requirement that remains unresolved after the relevant internal work, naming the source, attempted check, and exact affected outcome. Do not ask again for data or an answer already supplied unless new evidence changes the issue. Keep independent supported analysis moving: one unavailable measurement does not make every quantitative result unavailable or justify reducing the whole report to description. Reconcile the actual assignment and operating protocol with general textbook material before treating an unperformed exercise as mandatory.`

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
 * @returns disposer for the scoped tool.
 */
export function installWorkflowReportTool(childCtx: Context, hostCtx: Context, role: SpecialistRole): () => void {
  const disposers: (() => void)[] = []
  try {
    disposers.push(childCtx.tools.register(defineTool({
      name: 'report_workflow',
      description: [
        'Finish one Main-dispatched AutoReport task by returning its outcome to Main. Required before ending the turn on any Main dispatch; never used for ordinary conversation.',
        'Pass the exact task_id and delegation_revision from the task briefing; a mismatched or unknown delegation is rejected.',
        'status="success" when the requested outcome is complete and self-checks pass; status="blocked" with block_type="missing_data" (required inputs absent, unreadable, or ambiguous; a References/ PDF with no extracted markdown beside it is missing_data: report and stop; MAIN may request a bounded original-page preview through extract_pdf only when MinerU failed or its output is insufficient), "quality" (requirements conflict or scope is unclear), or "missing_dependency" (a Python package or tool your selected environment lacks) otherwise.',
        'An uncomputed derived result is unfinished work, not a missing raw input. For a genuine blocker, response must name the required input/model or unresolved convention, the supplied evidence checked, the analysis or adequacy check attempted, and the specific outcome it prevents; continue independent supported work.',
        'Never install or change Python packages yourself — MAIN owns the environment. For missing_dependency, name the package(s) in response and stop.',
        'response must be self-contained (up to 16384 chars); produced_files lists workspace-relative paths you wrote, at most 512, staying inside your role writable roots — absolute paths and ".." segments are rejected.',
        'Success is rejected while your manifest has stale file descriptions — update descriptions for changed files via manifest first.',
        'Reporting is idempotent: repeating the same task_id and delegation_revision returns the already-accepted message instead of reporting twice.',
        'Reporting does not end the turn; finish normally after an accepted report.',
        'Example call: report_workflow({task_id: "task-1", delegation_revision: 1, status: "success", response: "self-contained outcome summary", produced_files: ["Theory/theory.md"]}). A plain-text summary without this call is not a report and the task fails as an invalid workflow report.',
      ].join(' '),
      parameters: {
        task_id: { type: 'string', required: true, description: 'Exact task id from the task briefing.' },
        delegation_revision: { type: 'number', required: true, description: 'Exact delegation revision from the task briefing.' },
        status: { type: 'string', required: true, enum: ['success', 'blocked'], description: 'success completes the task; blocked returns the missing or unclear item to Main for rescheduling.' },
        block_type: { type: 'string', enum: ['missing_data', 'quality', 'missing_dependency'], description: 'Required only for blocked status: missing_data for absent, unreadable, or ambiguous inputs; a References/ PDF with no extracted markdown beside it is missing_data: report and stop; MAIN may request a bounded original-page preview through extract_pdf only when MinerU failed or its output is insufficient; quality for conflicting requirements or unclear scope; missing_dependency for a Python package/tool the selected environment lacks (MAIN installs it).' },
        response: { type: 'string', required: true, description: 'Self-contained outcome summary: results, file paths, or what is missing/wrong (up to 16384 chars).' },
        produced_files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths you wrote for this task (at most 512), inside your role writable roots.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `workflow report accepted as message ${value.messageId}` }],
      },
      async execute(args, exec) {
        if (args.status === 'success' && args.block_type !== undefined && args.block_type !== null) throw new WorkflowError('WORKFLOW_INVALID_ARGUMENT', `block_type=${String(args.block_type)} is only valid when status="blocked". For status="success", omit block_type; no report was delivered.`, { field: 'block_type', actual: args.block_type, status: args.status, expected: 'omit block_type for success' })
        const parsed = parseWorkflowEnvelope({
          task_id: args.task_id,
          delegation_revision: args.delegation_revision,
          status: args.status,
          block_type: args.status === 'success' ? null : args.block_type,
          response: args.response,
          produced_files: args.produced_files ?? [],
        })
        if (!parsed.ok) throw new WorkflowError('WORKFLOW_INVALID_REPORT', `Invalid workflow report for task_id=${String(args.task_id)}, delegation_revision=${String(args.delegation_revision)}: ${parsed.reason}. Correct the named field and use the task ID/revision from your briefing.`, { task_id: args.task_id, delegation_revision: args.delegation_revision, validation_reason: parsed.reason })
        const runtime = runtimeOf(hostCtx)
        const owner = runtime?.workflowForChild((exec.agent as Agent).id)
        const attempt = owner?.runtime.state.delegationAt(parsed.value.task_id, parsed.value.delegation_revision)
        if (attempt !== undefined && hasAcceptedWorkflowReport(attempt) && attempt.reportMessageId !== undefined) {
          return { messageId: attempt.reportMessageId }
        }
        if (owner === undefined || attempt === undefined || attempt.childSessionId !== (exec.agent as Agent).id) {
          throw new WorkflowError('WORKFLOW_UNKNOWN_REPORT_TARGET', `unknown task_id/delegation_revision for this child: task ${parsed.value.task_id}, revision ${parsed.value.delegation_revision}, child ${(exec.agent as Agent).id}. Use your current Main briefing; the task/revision must belong to this child.`,
            { task_id: parsed.value.task_id, delegation_revision: parsed.value.delegation_revision, child_session_id: String((exec.agent as Agent).id), known_tasks: owner === undefined ? [] : [...owner.runtime.state.projection().tasks.values()].filter(task => owner.runtime.state.currentDelegation(task.taskId)?.childSessionId === (exec.agent as Agent).id).map(task => ({ task_id: task.taskId, delegation_revision: owner.runtime.state.currentDelegation(task.taskId)?.delegationRevision })) })
        }
        const activeExecution = typeof runtime?.executionForChild === 'function'
          ? runtime.executionForChild((exec.agent as Agent).id)
          : undefined
        if (activeExecution !== undefined && (activeExecution.taskId !== parsed.value.task_id || activeExecution.delegationRevision !== parsed.value.delegation_revision)) {
          throw new WorkflowError('WORKFLOW_STALE_REPORT', `This child is currently executing ${activeExecution.taskId} revision ${activeExecution.delegationRevision}; the report claims ${parsed.value.task_id} revision ${parsed.value.delegation_revision}. Use the task ID and revision from the current briefing. No report was delivered.`, { task_id: parsed.value.task_id, delegation_revision: parsed.value.delegation_revision, active_task_id: activeExecution.taskId, active_delegation_revision: activeExecution.delegationRevision })
        }
        const obsolete = staleDependencyReason(owner.runtime.state, attempt)
        if (obsolete !== undefined || attempt.phase === 'stale' || attempt.phase === 'cancelled') throw new WorkflowError('WORKFLOW_STALE_REPORT', obsolete ?? `Task ${attempt.taskId} revision ${attempt.delegationRevision} is ${attempt.phase}: ${attempt.reason ?? 'this execution is no longer current'}. It cannot complete this task; MAIN must reopen/redispatch if work is still needed.`, { task_id: attempt.taskId, delegation_revision: attempt.delegationRevision, phase: attempt.phase, dependency_versions: attempt.dependencyVersions ?? {} })
        const canonical = {
          ...parsed.value,
          produced_files: observedProducedFilesForDelegation(owner.runtime.state.projection(), attempt),
        }
        if (canonical.status === 'success' && owner !== undefined) {
          const stale = staleDescribedPathsForDelegation(owner.runtime.state.projection(), attempt)
          if (stale.length > 0) {
            throw new Error(
              `Cannot complete task: manifest descriptions are stale for:\n${stale.map(path => `- ${path}`).join('\n')}\nUpdate the manifest before reporting.`,
            )
          }
        }
        const content: ContentBlock[] = [
          { type: 'text', text: `${formatWorkflowRelay(role, canonical)}\n\nDetails\n` },
          { type: 'text', text: JSON.stringify(canonical) },
        ]
        if (canonical.status === 'blocked' && canonical.block_type === 'missing_data') {
          content.push({ type: 'text', text: MISSING_INPUT_RECOVERY })
        }
        const residentReport = typeof runtime?.reportFromResident === 'function'
          ? runtime.reportFromResident(exec.agent as Agent, content, exec.signal)
          : undefined
        let messageId = await residentReport
        if (messageId === undefined) {
          // Non-resident (manager-owned) child: the adjacent-agent messaging
          // seam replaced the stock report relay upstream. The durable parent
          // is the role binding's owner, falling back to session lineage.
          const caller = exec.agent as Agent
          const parentId = runtime?.roleRegistry?.lookup(caller.id)?.binding.parentSessionId
            ?? caller.session?.header.parentSession
          if (parentId === undefined) throw new Error('reporting child has no bound parent; report was not delivered')
          const sent = await hostCtx.subagents.sendMessage(caller, parentId, content, {
            signal: exec.signal,
          })
          messageId = String(sent)
        }
        return { messageId }
      },
      presentCall: args => genericCall(`report_workflow ${String(args.status)}`, args.task_id),
    })))
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // Best-effort rollback of partial registrations before rethrowing.
      }
    }
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
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to revoke AutoReport subagent workflow tools')
    }
  }
}
