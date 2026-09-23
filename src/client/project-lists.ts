/**
 * The two project lists the settings page shows.
 *
 * A project is a workspace an AutoReport session has actually conversed in —
 * the same event that created its `REQUIRED_DIRS` — and the Client already
 * holds every session, so the list is derived from that store. That is why
 * nothing here scans: no host round trip, no filesystem read, no registry to
 * keep in sync, and a workspace with no AutoReport conversation never appears.
 * @module client/project-lists
 */

/** Report language as the settings document carries it. */
export type ProjectLanguage = 'latex' | 'typst'

/** The session fields one project row is derived from. */
export interface ProjectSessionRow {
  /** Workspace root the session runs in; the project's identity. */
  readonly cwd?: string
  /** Owning session id when this row is a subagent; those never name a project. */
  readonly parentId?: string
  /** Empty-log bit: false once the session has committed a turn. */
  readonly blank?: boolean
  /** Composing agent preset; only `autoreport` rows are projects. */
  readonly agentPreset?: string
  /**
   * Host-computed projection values. The preset arrives here on the wire the
   * Client builds rows from, so it is read as a fallback for the row-level
   * field the conversation-window picker already uses.
   */
  readonly projectionValues?: { readonly agentPreset?: string | null }
}

/** Agent preset of one row, from whichever face carries it. */
function presetOf(row: ProjectSessionRow): string | undefined {
  const projected = row.projectionValues?.agentPreset
  return row.agentPreset ?? (typeof projected === 'string' ? projected : undefined)
}

/** One project as a list row. */
export interface ProjectEntry {
  /** Absolute workspace root, and the settings map's key. */
  readonly root: string
  /** Display name: the session's title, else the directory's own name. */
  readonly name: string
  /** Language in effect for this project. */
  readonly language: ProjectLanguage
}

/** Both lists, one per report language. */
export interface ProjectLists {
  readonly latex: readonly ProjectEntry[]
  readonly typst: readonly ProjectEntry[]
}

/** Agent preset whose sessions make a workspace an AutoReport project. */
const AUTOREPORT_PRESET = 'autoreport'

/**
 * Display name for one project: the workspace directory's own name.
 *
 * The workspace is the list's unit, so its row is named by its directory -
 * not by any one conversation's title. Sessions only decide whether a
 * workspace qualifies for the list at all.
 */
function projectName(root: string): string {
  const segments = root.split('/').filter(segment => segment.length > 0)
  const last = segments[segments.length - 1]
  return last === undefined ? root : last
}

/**
 * Split the session rows into the two language lists.
 *
 * Blank sessions are skipped: a project joins a list once it has conversed,
 * which is exactly when the host initialized its workspace directories. A
 * project with no recorded language follows the default, so a newly started
 * project lands in the list the page currently selects.
 * @param rows - the Client's session rows, keyed by session id.
 * @param recorded - the settings map of workspace root to language.
 * @param fallback - the user's default language for unrecorded workspaces.
 * @returns both lists, each sorted by display name.
 */
export function projectsByLanguage(
  rows: Readonly<Record<string, ProjectSessionRow>>,
  recorded: Readonly<Record<string, ProjectLanguage>> | undefined,
  fallback: ProjectLanguage,
): ProjectLists {
  const seen = new Map<string, ProjectEntry>()
  for (const row of Object.values(rows)) {
    if (presetOf(row) !== AUTOREPORT_PRESET) continue
    if (row.parentId !== undefined) continue
    if (row.blank !== false) continue
    const root = row.cwd
    if (root === undefined || root.length === 0) continue
    if (seen.has(root)) continue
    seen.set(root, { root, name: projectName(root), language: recorded?.[root] ?? fallback })
  }
  const entries = [...seen.values()]
  return {
    latex: entries.filter(entry => entry.language === 'latex').sort(byName),
    typst: entries.filter(entry => entry.language === 'typst').sort(byName),
  }
}

/** Stable list order: by name, never by insertion. */
function byName(left: ProjectEntry, right: ProjectEntry): number {
  return left.name.localeCompare(right.name)
}
