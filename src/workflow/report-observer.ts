import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentReportMessageSource, SubagentSettledMessageSource } from '@deepseek-ai/dsh-subagent'
import type { DelegationSnapshot } from './events.js'
import { delegationKey, parseWorkflowEnvelope } from './protocol.js'
import type { WorkflowState } from './service.js'
import type { WaiterRegistry, WaiterOutcome } from './waiters.js'

/** Dependencies borrowed by the durable parent-message observer. */
export interface WorkflowReportObserverDependencies {
  readonly state: WorkflowState
  readonly waiters: WaiterRegistry
  readonly commit: (type: 'autoreport/delegation', data: DelegationSnapshot) => void
}

function messageText(event: SessionEvent<'user/message'>): string {
  return event.data.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function currentForChild(state: WorkflowState, childId: SessionId): DelegationSnapshot | undefined {
  let match: DelegationSnapshot | undefined
  for (const task of state.projection().tasks.values()) {
    const current = state.currentDelegation(task.taskId)
    if (current?.childSessionId !== childId) continue
    if (current.phase !== 'dispatched' && current.phase !== 'waiting_for_child') continue
    if (match === undefined || (current.dispatchedAt ?? 0) > (match.dispatchedAt ?? 0)) match = current
  }
  return match
}

function settleOutcome(snapshot: DelegationSnapshot): WaiterOutcome {
  if (snapshot.phase === 'completed') {
    return {
      status: 'completed',
      ...(snapshot.report?.response !== undefined ? { response: snapshot.report.response } : {}),
      ...(snapshot.report?.produced_files !== undefined ? { producedFiles: snapshot.report.produced_files } : {}),
    }
  }
  if (snapshot.phase === 'blocked') {
    return {
      status: 'blocked',
      ...(snapshot.report?.response !== undefined ? { response: snapshot.report.response } : {}),
      ...(snapshot.report?.block_type === 'missing_data' || snapshot.report?.block_type === 'quality'
        ? { blockType: snapshot.report.block_type }
        : {}),
    }
  }
  return {
    status: 'failed',
    ...(snapshot.reason !== undefined ? { response: snapshot.reason } : {}),
  }
}

/**
 * Fold one durable parent Session event into AutoReport delegation state.
 * The input is the real SessionEvent wrapper, never a raw UserMessage.
 * @param _session - parent session receiving the message.
 * @param event - committed Session event.
 * @param deps - projection, waiters, and durable commit callback.
 */
export function observeWorkflowMessage(
  _session: Session,
  event: SessionEvent,
  deps: WorkflowReportObserverDependencies,
): void {
  if (event.type !== 'user/message') return
  const source = event.data.source
  if (source.kind === 'subagent-report') {
    const reportSource = source as SubagentReportMessageSource
    const parsed = parseWorkflowEnvelope(messageText(event))
    if (!parsed.ok) {
      const current = currentForChild(deps.state, reportSource.senderSessionId)
      if (current === undefined) return
      const failed: DelegationSnapshot = {
        ...current,
        phase: 'failed',
        reportMessageId: String(event.data.id),
        reason: `invalid workflow report: ${parsed.reason}`,
        settledAt: Date.now(),
      }
      deps.commit('autoreport/delegation', failed)
      deps.waiters.settle(delegationKey(failed.taskId, failed.delegationRevision), settleOutcome(failed))
      return
    }

    const report = parsed.value
    const attempt = deps.state.delegationAt(report.task_id, report.delegation_revision)
    if (attempt === undefined || attempt.childSessionId !== reportSource.senderSessionId) return
    const reportMessageId = String(event.data.id)
    if (attempt.reportMessageId === reportMessageId) return
    const current = deps.state.currentDelegation(report.task_id)
    const stale = current === undefined || current.delegationRevision !== report.delegation_revision
    const settled: DelegationSnapshot = {
      ...attempt,
      phase: stale ? 'stale' : report.status === 'success' ? 'completed' : 'blocked',
      report,
      reportMessageId,
      settledAt: Date.now(),
      ...(stale ? { reason: `late report for delegation revision ${report.delegation_revision}` } : {}),
    }
    deps.commit('autoreport/delegation', settled)
    if (!stale) {
      deps.waiters.settle(delegationKey(settled.taskId, settled.delegationRevision), settleOutcome(settled))
    }
    return
  }

  if (source.kind === 'subagent-settled') {
    const settledSource = source as SubagentSettledMessageSource
    const current = currentForChild(deps.state, settledSource.senderSessionId)
    if (current === undefined) return
    const failed: DelegationSnapshot = {
      ...current,
      phase: 'failed',
      reportMessageId: String(event.data.id),
      reason: settledSource.summary,
      settledAt: Date.now(),
    }
    deps.commit('autoreport/delegation', failed)
    deps.waiters.settle(delegationKey(failed.taskId, failed.delegationRevision), settleOutcome(failed))
  }
}
