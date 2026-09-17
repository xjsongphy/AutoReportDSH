/**
 * The single writer seam for `autoreport/*` events. Every AutoReport record
 * goes through {@link appendWorkflowEvent} and is written by DSH's official
 * `Session.append` path, marked `ignorable` so any harness that does not know
 * the vocabulary skips the record instead of refusing the whole log — the
 * persisted marker IS the third-party compatibility mechanism upstream keeps.
 *
 * Monkey-patching `Session`, constructing events outside `Session.append`, or
 * writing straight to a persistence backend are all forbidden alternatives.
 * @module
 */

import type { Session, SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'

/** The event keys this plugin owns. */
const AUTOREPORT_EVENT_TYPES = new Set<string>([
  'autoreport/workflow',
  'autoreport/role-binding',
  'autoreport/task',
  'autoreport/delegation',
  'autoreport/artifact',
  'autoreport/file-note',
  'autoreport/role-note',
])

/**
 * Whether an event type belongs to the AutoReport vocabulary.
 * @param type - session event type to test.
 * @returns whether {@link appendWorkflowEvent} owns this type.
 */
export function isAutoreportEvent(type: SessionEventType): boolean {
  return AUTOREPORT_EVENT_TYPES.has(type)
}

/**
 * Append one AutoReport domain fact through the official writer. The returned
 * event is the committed log entry: assigned `seq`/`time` plus the frozen data
 * snapshot, carrying the `ignorable` marker.
 * @param session - owning session (MAIN's workflow session in practice).
 * @param type - one of the AutoReport `autoreport/*` types.
 * @param data - complete payload snapshot; must be JSON-serializable.
 * @returns the logged event.
 */
export function appendWorkflowEvent<T extends keyof SessionEventMap & string>(
  session: Session,
  type: T,
  data: SessionEventMap[T],
): SessionEvent<T> {
  // The conditional tuple type cannot prove a generic `T` is non-surface;
  // this helper's contract is exactly that, so the narrow cast records it.
  // `.call(session, …)` keeps the receiver — extracting the method would lose it.
  const append = session.append as unknown as <K extends keyof SessionEventMap & string>(
    this: Session,
    type: K,
    data: SessionEventMap[K],
    options?: { ignorable?: true },
  ) => SessionEvent<K>
  return append.call(session, type as never, data as never, { ignorable: true }) as SessionEvent<T>
}
