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
    /** A coordinator briefing the AutoReport runtime authored for a resident role. */
    coordinator: {
      kind: 'coordinator'
      /** A message another agent addressed to this one (`relay` context form). */
      form: 'relay'
      /** Session id of the MAIN session whose dispatch produced the message. */
      senderSessionId: SessionId
    }
    /** A structured `report_workflow` relay from a bound specialist child. */
    'subagent-report': {
      kind: 'subagent-report'
      /** A message another agent addressed to this one (`relay` context form). */
      form: 'relay'
      /** Session id of the reporting child. */
      senderSessionId: SessionId
    }
  }
}

/** Source of one coordinator → resident-role briefing. */
export type CoordinatorMessageSource = import('@deepseek-ai/dsh-llm').MessageSourceMap['coordinator']

/** Source of one specialist child → MAIN structured report relay. */
export type SubagentReportMessageSource = import('@deepseek-ai/dsh-llm').MessageSourceMap['subagent-report']
