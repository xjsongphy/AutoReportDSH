/**
 * AutoReport session membership: which sessions an AutoReport deployment owns.
 *
 * The overlay installs a global session-event listener and a global tool
 * guard, so membership must be EXPLICIT: otherwise every ordinary top-level
 * DSH session could drift into the workflow runtime merely by producing
 * events. The compatibility invariant (PLAN.md): loading the AutoReportDSH
 * overlay must not change the behavior of sessions that did not explicitly
 * select AutoReport.
 *
 * Root membership therefore follows the agent preset a session actually runs:
 * only sessions composed from {@link AUTOREPORT_MAIN_PRESET} are AutoReport
 * MAIN roots. Continuable children are NOT covered by the preset; their
 * membership is the synchronous RoleRegistry binding that `send_to_agent`
 * reserves BEFORE publishing the child.
 *
 * Preset resolution mirrors DSH's canonical `resolveSessionPreset`
 * (`@deepseek-ai/dsh-agent-presets/session`): the creation header supplies
 * the initial value and a logged `agent-preset/selected` event overrides it,
 * newest selection winning. Mirrored locally because the out-of-tree plugin
 * does not link the in-tree presets package.
 * @module membership
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** The only agent preset whose root sessions join the AutoReport runtime. */
export const AUTOREPORT_MAIN_PRESET = 'autoreport-main'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    // Declared in-tree by @deepseek-ai/dsh-agent-presets; mirrored here so the
    // out-of-tree plugin can read preset switches without linking that package.
    'agent-preset/selected': { agentPreset: string }
  }
}

/**
 * Resolve the agent preset one session runs under: the newest logged
 * `agent-preset/selected` event wins over the creation header, because a
 * blank session may switch presets and every later turn runs under the newer
 * composition.
 * @param session - any durable session (root or child).
 * @returns the effective preset id, or `undefined` when none was recorded.
 */
export function resolveAgentPreset(session: Session): string | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.header.agentPreset
}

/**
 * Whether one session is an AutoReport MAIN root: top-level AND running the
 * `autoreport-main` preset (header value or a later logged selection).
 * @param session - candidate root session.
 */
export function isAutoReportMainSession(session: Session): boolean {
  return session.header.parentSession === undefined
    && resolveAgentPreset(session) === AUTOREPORT_MAIN_PRESET
}
