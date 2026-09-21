/**
 * Make AutoReport's session log loadable by the running DSH.
 *
 * DSH's persistence reader refuses to interpret a log containing an event type
 * outside its generated vocabulary unless the event carries the envelope's
 * `ignorable` marker. AutoReport writes log-only `autoreport/*` records, so a
 * session carrying them must be readable by whoever loads it later. Two
 * independent mechanisms can establish that, and this module measures both at
 * host activation:
 *
 * 1. **Vocabulary registration (in-process).** `KNOWN_SESSION_EVENT_TYPES` is a
 *    runtime-mutable `Set` (`ReadonlySet` is a compile-time type only), and the
 *    reader consults that same object. Adding AutoReport's names at activation
 *    makes every later load in this process accept them. Nothing is written to
 *    disk: a session log opened without this plugin loaded still refuses.
 * 2. **The persisted `ignorable` marker.** An event written with
 *    `{ ignorable: true }` is self-describing — any DSH, including one with no
 *    AutoReport plugin and newer builds, skips it instead of refusing the log.
 *    The write option is not in a stock release yet, so it is detected rather
 *    than assumed.
 *
 * Activation fails loud only when NEITHER mechanism is available, because that
 * is the state in which the plugin would silently write logs nobody can open.
 *
 * @module autoreportdsh/session-events
 */

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, type SessionEventType } from '@deepseek-ai/dsh-session'

/** Event types written by AutoReport. Log-only: never part of model history. */
export const AUTOREPORT_SESSION_EVENT_TYPES = [
  'autoreport/workflow',
  'autoreport/role-binding',
  'autoreport/task',
  'autoreport/delegation',
  'autoreport/artifact',
  'autoreport/file-note',
  'autoreport/role-note',
] as const satisfies readonly SessionEventType[]

/** Which loadability mechanisms the running DSH provides. */
export interface SessionEventCompatibility {
  /** The in-process reader recognizes `autoreport/*` (this process only). */
  readonly vocabularyRegistered: boolean
  /** `Session.append` persists the `ignorable` marker (portable logs). */
  readonly markerPersisted: boolean
}

/** Optional seams for tests and hosts with unusual module layouts. */
export interface RegisterSessionEventsOptions {
  /** Candidate vocabulary registries; defaults to the resolved DSH modules. */
  readonly registries?: readonly ReadonlySet<string>[]
  /** Marker-support probe; defaults to {@link probeIgnorableMarker}. */
  readonly markerProbe?: () => boolean
}

type SessionModule = {
  KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string>
}

function addToRegistry(registry: ReadonlySet<string>): boolean {
  const mutable = registry as Set<string>
  if (typeof mutable.add !== 'function') return false
  for (const type of AUTOREPORT_SESSION_EVENT_TYPES) mutable.add(type)
  return AUTOREPORT_SESSION_EVENT_TYPES.every(type => registry.has(type))
}

/**
 * Resolve a package from an executable/module anchor without assuming a
 * particular installation prefix.  `process.argv[1]` is the DSH launcher in
 * normal CLI/Web operation; `import.meta.url` is the source-test fallback.
 */
function resolveSessionModule(anchor: string): string | undefined {
  const candidates = [anchor]
  try {
    const realAnchor = realpathSync(anchor)
    if (realAnchor !== anchor) candidates.push(realAnchor)
  } catch {
    // The fallback anchor is still useful for virtual/test paths.
  }
  for (const candidate of candidates) {
    try {
      return createRequire(candidate).resolve('@deepseek-ai/dsh-session')
    } catch {
      // Try the next anchor, notably the real path behind a dsh bin symlink.
    }
  }
  return undefined
}

/**
 * Whether the running DSH persists the `ignorable` marker. Probes a scratch
 * in-memory session with a first-party non-surface type, so the check never
 * depends on our own vocabulary being registered and never touches storage.
 * @param session - session to probe; defaults to a fresh in-memory session.
 * @returns whether the appended event carried the marker.
 */
export function probeIgnorableMarker(session?: Session): boolean {
  const probe = session ?? Session.create(SessionId('autoreportdsh:compatibility-probe'))
  // The `ignorable` write option is not in a stock release yet: stock
  // declarations reject a third `append` argument, while the pinned development
  // checkout types it as the `AppendOptions` tuple member. Erasing the method's
  // signature lets this call site compile against both. A stock runtime ignores
  // the extra argument and returns an event without the marker.
  const append = probe.append.bind(probe) as unknown as (
    type: 'turn/start',
    data: { turn: number },
    options?: { ignorable?: boolean },
  ) => { ignorable?: boolean }
  const event = append('turn/start', { turn: 1 }, { ignorable: true })
  return event.ignorable === true
}

/**
 * Register the AutoReport vocabulary in the host DSH session module and report
 * which loadability mechanisms are available.
 *
 * The operation is idempotent. It fails loudly only when the vocabulary is not
 * mutable AND the running DSH cannot persist the marker — the one state where
 * AutoReport would write session logs that no reader can open.
 * @param options - test/host seams; production resolves the host DSH itself.
 * @returns the available mechanisms, for host logging and capability gates.
 */
export async function registerAutoReportSessionEvents(
  options: RegisterSessionEventsOptions = {},
): Promise<SessionEventCompatibility> {
  let registries: readonly ReadonlySet<string>[]
  if (options.registries !== undefined) {
    registries = options.registries
  } else {
    const anchors = [
      process.argv[1],
      fileURLToPath(import.meta.url),
    ].filter((value): value is string => value !== undefined)
    const modulePaths = new Set<string>([
      ...anchors
        .map(anchor => resolveSessionModule(anchor))
        .filter((value): value is string => value !== undefined),
    ])

    // Always include the package's own module as a deterministic test/source
    // fallback.  In a normal installed DSH this is usually the same module
    // reached from the launcher, or the only available module.
    const localPath = resolveSessionModule(fileURLToPath(import.meta.url))
    if (localPath !== undefined) modulePaths.add(localPath)

    const resolved: ReadonlySet<string>[] = [KNOWN_SESSION_EVENT_TYPES]
    for (const modulePath of modulePaths) {
      const module = await import(pathToFileURL(modulePath).href) as SessionModule
      if (module.KNOWN_SESSION_EVENT_TYPES !== undefined) resolved.push(module.KNOWN_SESSION_EVENT_TYPES)
    }
    registries = resolved
  }

  let vocabularyRegistered = false
  for (const registry of registries) {
    // There can be two copies in a source checkout: register every resolved
    // copy so both the plugin's Session helpers and the host persistence
    // reader observe the same vocabulary.
    vocabularyRegistered = addToRegistry(registry) || vocabularyRegistered
  }

  const markerPersisted = (options.markerProbe ?? probeIgnorableMarker)()

  if (!vocabularyRegistered && !markerPersisted) {
    throw new Error(
      'autoreportdsh: cannot make AutoReport session logs loadable on this DSH — the session vocabulary is not mutable and Session.append cannot persist the ignorable marker; install a DSH release that supports one of them',
    )
  }
  return { vocabularyRegistered, markerPersisted }
}
