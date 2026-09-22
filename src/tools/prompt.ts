/**
 * Model-facing policy text for the AutoReport tools.
 *
 * Placement follows the master dsh convention, not a resource loader: tool
 * guidance ships with the tool as a prompt section (`tool:<tool>`) or runtime
 * context, and its text lives as a module constant in the tool's own package
 * (the `tool-cordis/src/prompt.ts` / `tool-agent-team` POLICY shape). The
 * owning module registers the contribution, so the policy cannot drift away
 * from the tool it describes.
 *
 * @module autoreportdsh-tools-prompt
 */

/**
 * MAIN's `tool:send_to_agent` policy: the dispatch payload and result handling
 * that a parameter schema cannot express.
 */
export const SEND_TO_AGENT_SYSTEM_PROMPT = `# Delegating with \`send_to_agent\`

Use \`send_to_agent\` for all subagent delegation. Subagents also answer the user
directly through ordinary conversation when the user opens them; those exchanges
are not workflow delegations and never change task state. Your dispatches are the
workflow channel.

## Minimal dispatch

Send subagents only the task goal, relevant input locations, dependencies, and
explicit user constraints.

- **No micromanagement**: Do not specify implementation steps, formulas, data-analysis methods, plotting design, report structure, report-engine settings, output filenames, or file formats unless the user explicitly requires them.
- **No technical relay**: Do not read, summarize, transform, or copy technical content for subagents. Subagents are responsible for finding and interpreting the technical material they need within the task scope you assign.
- **No hidden context dumping**: Do not attach internal plans, previous agent reasoning, or unrelated file contents to subagent messages.
- **No prompt expansion**: Do not turn a task into a mini-spec. If a subagent can infer the method from its own prompt and the referenced files, stop there.
- **Default to under-specifying**: When unsure whether to include a technical detail, omit it unless it is a user constraint or a routing dependency.

When dispatching, include only:

- Task goal
- Dependency relationship
- Explicit user constraints needed to preserve the request

Do not include:

- Implementation steps or methods
- Technical formulas or copied source content
- Processed results copied from files
- Plotting or report design choices
- report-engine classes, packages, section structures, filenames, or formats
- Subagent built-in output or quality requirements
- Internal plans or unrelated context

If a user constraint conflicts with a subagent role, forward it as user-provided
and let the subagent handle or report the conflict.

## Handling results

Route follow-up work according to the \`send_to_agent\` result; do not do the
subagent's work yourself when a task comes back blocked.

When a subagent reports a blocker, reschedule the relevant upstream agent, pause
dependent work when needed, or escalate to the user.`

/**
 * MAIN's `tool:workflow_task` policy: when the durable board is worth writing
 * to, and why it is not a generic todo list.
 */
export const WORKFLOW_TASK_SYSTEM_PROMPT = `# The workflow task board

Use \`workflow_task\` only to read or maintain the durable AutoReport workflow
checklist and status; do not use generic todo tools.

Track only nontrivial coordination work with concrete deliverables or
dependencies; do not create workflow tasks for direct answers, simple checks,
passive waiting, or internal bookkeeping.`

/**
 * The delegation-scope statement every AutoReport child reads: how a
 * Main-dispatched task ends, and what a direct human follow-up is. A runtime
 * context rather than a section, so the deployment's system prompt stays
 * uniform across parents and children.
 */
export const CHILD_REPORT_PROTOCOL_CONTEXT = `# Reporting back to Main

Main-dispatched tasks must finish through \`report_workflow\`: never end the turn
on a dispatch without reporting — there is no other way to finish a dispatched
task. Do not ask the user questions directly — assume sensibly or report
\`missing_data\` to Main.

Workflow reporting tools apply only to active Main-dispatched tasks. Direct human
follow-ups are ordinary conversation: answer normally, but never create,
complete, or otherwise mutate AutoReport task state for them.

AutoReport's durable task board is for Main-dispatched report work only; it is
not DSH \`todo_write\`. MAIN creates and dispatches tasks with \`send_to_agent\` and
may inspect, update checklist steps, cancel, or reopen them with \`workflow_task\`.
Specialists report their assigned task through \`report_workflow\`; they do not
mutate the task board directly.

Use task tracking only for nontrivial report work with concrete deliverables or
dependencies. Do not create workflow tasks for greetings, status checks, ordinary
conversation, or passive waiting. Do not restate task IDs or internal checklists
to the user unless asked.`

/** Prompt-section name carrying MAIN's `send_to_agent` policy. */
export const SEND_TO_AGENT_SECTION = 'tool:send_to_agent'

/** Prompt-section name carrying MAIN's `workflow_task` policy. */
export const WORKFLOW_TASK_SECTION = 'tool:workflow_task'

/** Runtime-context name carrying the specialist report protocol. */
export const CHILD_REPORT_CONTEXT = 'autoreport:report-protocol'
