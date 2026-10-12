/**
 * AutoReport-owned message sources. The stock subagent report relay was
 * removed upstream in the 2026-08-27 unified-steer change; AutoReport keeps
 * its structured report channel by declaring its own kinds through the
 * `MessageSourceMap` merge point (the sanctioned plugin extension).
 * @module
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime-authored report workflow notice. */
    'autoreport-notice': { kind: 'autoreport-notice'; form: 'notice'; summary: string }
    /** A coordinator briefing the AutoReport runtime authored for a resident role. */
    coordinator: {
      kind: 'coordinator'
      /** A message another agent addressed to this one (`relay` context form). */
      form: 'relay'
      /** Session id of the MAIN session whose dispatch produced the message. */
      senderSessionId: SessionId
      /** Durable task identity for the execution started by this briefing. */
      taskId: string
      /** Durable task revision for the execution started by this briefing. */
      delegationRevision: number
    }
    /** A structured `report_workflow` relay from a bound specialist child. */
    'subagent-report': {
      kind: 'subagent-report'
      /** A message another agent addressed to this one (`relay` context form). */
      form: 'relay'
      /** Session id of the reporting child. */
      senderSessionId: SessionId
      /** Dispatch identity captured from the child's active briefing. */
      taskId?: string
      /** Dispatch revision captured from the child's active briefing. */
      delegationRevision?: number
    }
    /** A versioned runtime notice that a particular resident execution ended without a report. */
    'autoreport-settled': {
      kind: 'autoreport-settled'
      form: 'notice'
      senderSessionId: SessionId
      taskId: string
      delegationRevision: number
      summary: string
    }
  }
}

/** Source of one coordinator → resident-role briefing. */
export type CoordinatorMessageSource = import('@deepseek-ai/dsh-llm').MessageSourceMap['coordinator']

/** Source of one specialist child → MAIN structured report relay. */
export type SubagentReportMessageSource = import('@deepseek-ai/dsh-llm').MessageSourceMap['subagent-report']
