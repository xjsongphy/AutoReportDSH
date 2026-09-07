/**
 * Register AutoReport's session vocabulary with the DSH process that hosts
 * this plugin.
 *
 * DSH's persistence reader deliberately rejects unknown required event types.
 * The current DSH release exposes its vocabulary as a mutable Set, but does
 * not yet expose a public third-party registration API. A plugin is loaded
 * from a profile and can therefore be backed by a different local/link copy
 * of `@deepseek-ai/dsh-session`; registering only the copy resolved from this
 * package would leave the host persistence reader unchanged. Resolve the
 * package from the running DSH entry point first, then fall back to this
 * package for tests and source-only hosts.
 *
 * This is an in-process registration only. It does not modify DSH source,
 * installed packages, session files, or user configuration, and it does not
 * affect stock sessions because the added names are all AutoReport-owned.
 *
 * This is deliberately performed during host-plugin activation, before the
 * plugin creates or resumes any AutoReport session.  It is not an Agent Loop
 * hook: persistence validation happens at the session boundary, outside the
 * loop.
 *
 * @module autoreportdsh/session-events
 */

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** Event types written by AutoReport or its per-session sandbox policy. */
export const AUTOREPORT_SESSION_EVENT_TYPES = [
  'autoreport/workflow',
  'autoreport/role-binding',
  'autoreport/task',
  'autoreport/delegation',
  'autoreport/artifact',
  'autoreport/file-note',
  'autoreport/role-note',
  'sandbox/workspace-root',
] as const

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
 * Register the event vocabulary in the host DSH session module.
 *
 * The operation is idempotent and intentionally fails loudly if no mutable
 * registry can be found: silently starting a session that cannot later be
 * restored would recreate the persistence bug this compatibility seam owns.
 */
export async function registerAutoReportSessionEvents(): Promise<void> {
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

  const registries: ReadonlySet<string>[] = [KNOWN_SESSION_EVENT_TYPES]
  for (const modulePath of modulePaths) {
    const module = await import(pathToFileURL(modulePath).href) as SessionModule
    if (module.KNOWN_SESSION_EVENT_TYPES !== undefined) registries.push(module.KNOWN_SESSION_EVENT_TYPES)
  }

  let registered = false
  for (const registry of registries) {
    // There can be two copies in a source checkout: register every resolved
    // copy so both the plugin's Session helpers and the host persistence
    // reader observe the same vocabulary.
    registered = addToRegistry(registry) || registered
  }
  if (!registered) {
    throw new Error('autoreportdsh: the host DSH session vocabulary is not mutable; upgrade DSH to a plugin-compatible release')
  }
}
