import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AutoReportRole } from '../roles.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { refreshArtifactsFromDisk } from '../artifacts/refresh.js'
import { AUTOREPORT_SCHEMA_VERSION, type FileNoteSnapshot, type RoleNoteSnapshot } from '../workflow/events.js'
import { projectManifest } from '../workflow/manifest.js'
import type { WorkflowProjection } from '../workflow/service.js'
import { delegationKey, normalizeProducedPath } from '../workflow/protocol.js'
import { MAX_FILE_DESCRIPTION, MAX_FILE_NOTES } from '../workflow/file-notes.js'
import { genericCall } from './presentation.js'

/** Upper bound for one manifest call's per-file description updates. */
const MAX_FILE_ENTRIES = 64

const MANIFEST_AGENT_TYPES: Readonly<Record<string, AutoReportRole>> = {
  main: 'MAIN',
  theory: 'THEORY',
  data_analysis: 'DATA_ANALYSIS',
  plotting: 'PLOTTING',
  report: 'REPORT',
}

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

function currentWorkflow(
  runtime: AutoReportWorkflowRuntime,
  agent: Agent,
  role: AutoReportRole,
): { session: Parameters<AutoReportWorkflowRuntime['commit']>[0]; projection: WorkflowProjection } {
  if (role === 'MAIN') {
    const session = agent.session
    if (session === undefined || !runtime.isMainSession(agent.id)) {
      throw new Error('manifest requires an AutoReport MAIN session')
    }
    return { session, projection: runtime.forSession(session).state.projection() }
  }
  const owner = runtime.workflowForChild(agent.id)
  if (owner === undefined) throw new Error('manifest requires an AutoReport subagent session')
  return { session: owner.session, projection: owner.runtime.state.projection() }
}

function roleFromAgentType(raw: unknown): AutoReportRole {
  if (typeof raw !== 'string' || MANIFEST_AGENT_TYPES[raw] === undefined) {
    throw new Error('agent must be one of main, theory, data_analysis, plotting, or report')
  }
  return MANIFEST_AGENT_TYPES[raw]
}

function stringField(raw: unknown, name: string, max: number, required: boolean): string | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`${name} must be a non-empty string`)
    return undefined
  }
  if (typeof raw !== 'string') throw new Error(`${name} must be a string`)
  const value = raw.trim()
  if (required && value.length === 0) throw new Error(`${name} must be a non-empty string`)
  if (value.length > max) throw new Error(`${name} exceeds ${max} chars`)
  return value
}

interface NotesPatchChunk {
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
  readonly eof: boolean
}

function parseNotesPatch(patch: string): NotesPatchChunk[] {
  const lines = patch.split(/\r?\n/u)
  if (lines[lines.length - 1] === '') lines.pop()
  const chunks: NotesPatchChunk[] = []
  let index = 0
  while (index < lines.length) {
    if (lines[index] === '@@' || lines[index]?.startsWith('@@ ') === true) index += 1
    const oldLines: string[] = []
    const newLines: string[] = []
    let eof = false
    let parsed = 0
    while (index < lines.length) {
      const line = lines[index] ?? ''
      if (line === '@@' || line.startsWith('@@ ')) break
      if (line === '*** End of File') {
        eof = true
        index += 1
        break
      }
      if (line.startsWith(' ')) {
        const body = line.slice(1)
        oldLines.push(body)
        newLines.push(body)
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1))
      } else if (line.startsWith('-')) {
        oldLines.push(line.slice(1))
      } else {
        throw new Error(`invalid notes_patch line: ${line}`)
      }
      parsed += 1
      index += 1
    }
    if (parsed === 0 && !eof) throw new Error('notes_patch must contain at least one change line')
    chunks.push({ oldLines, newLines, eof })
  }
  return chunks
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n')
}

function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return Math.min(start, lines.length)
  if (pattern.length > lines.length) return undefined
  const first = eof ? lines.length - pattern.length : Math.min(start, lines.length - pattern.length)
  for (let index = first; index <= lines.length - pattern.length; index += 1) {
    if (lines.slice(index, index + pattern.length).every((line, offset) => line === pattern[offset])) return index
  }
  for (let index = first; index <= lines.length - pattern.length; index += 1) {
    if (lines.slice(index, index + pattern.length).every((line, offset) => line.trimEnd() === (pattern[offset] ?? '').trimEnd())) return index
  }
  return undefined
}

function applyNotesPatch(current: string, patch: string): string {
  const lines = splitLines(current)
  let cursor = 0
  for (const chunk of parseNotesPatch(patch)) {
    const start = chunk.oldLines.length === 0
      ? Math.min(cursor, lines.length)
      : seekSequence(lines, chunk.oldLines, cursor, chunk.eof)
    if (start === undefined) throw new Error('notes_patch did not match current notes')
    lines.splice(start, chunk.oldLines.length, ...chunk.newLines)
    cursor = start + chunk.newLines.length
  }
  return lines.join('\n')
}

function notesDiff(oldText: string, newText: string): string | null {
  return oldText === newText ? null : `- ${oldText}\n+ ${newText}`
}

function manifestValue(manifest: ReturnType<typeof projectManifest>) {
  return {
    agent_type: manifest.agent_type,
    updated_at: manifest.updated_at,
    files: manifest.files.map(file => ({ ...file })),
    notes: manifest.notes,
    notes_updated_at: manifest.notes_updated_at,
  }
}

/**
 * Disk-truth pass before any manifest is served: stat every file tracked for
 * the target role and commit refreshed `modified` artifacts for files edited
 * outside the harness since their last artifact. Without this, a manifest
 * read would report the last agent-write time and stale-detection would miss
 * external edits entirely — the observer only sees tool events.
 *
 * Best-effort: a workflow without a workspace root, or a runtime that does
 * not expose re-projection (test fakes), skips the refresh silently — the
 * manifest then serves the last event-sourced facts as before.
 * @param runtime - host runtime that owns the workflow log.
 * @param session - owning MAIN session receiving the refreshed records.
 * @param projection - current fold for that session.
 * @param role - manifest target role.
 * @returns the projection to serve from: re-read after refresh when possible,
 *   otherwise the caller's original.
 */
function refreshTrackedFiles(
  runtime: AutoReportWorkflowRuntime,
  agent: Agent,
  session: Parameters<AutoReportWorkflowRuntime['commit']>[0],
  projection: WorkflowProjection,
  role: AutoReportRole,
): WorkflowProjection {
  const workspaceRoot = projection.meta?.workspaceRoot
  if (workspaceRoot === undefined) return projection
  let refreshedSomething = false
  refreshArtifactsFromDisk(projection, role, workspaceRoot, Date.now(), snapshot => {
    runtime.commit(session, 'autoreport/artifact', snapshot)
    refreshedSomething = true
  })
  return refreshedSomething ? liveProjection(runtime, session, agent) ?? projection : projection
}

/**
 * Re-read the live projection after commits, through the same resolution the
 * caller used: the owning session when the runtime exposes `forSession`, else
 * the child-binding owner. Test fakes may expose neither, in which case the
 * caller's projection stands.
 */
function liveProjection(
  runtime: AutoReportWorkflowRuntime,
  session: Parameters<AutoReportWorkflowRuntime['commit']>[0],
  agent: Agent,
): WorkflowProjection | undefined {
  if (typeof runtime.forSession === 'function') {
    try {
      return runtime.forSession(session).state.projection()
    } catch {
      // The session may not be admitted in this runtime; fall through.
    }
  }
  if (typeof runtime.workflowForChild === 'function') {
    try {
      return runtime.workflowForChild(agent.id)?.runtime.state.projection()
    } catch {
      // Not a bound child in this runtime; nothing left to try.
    }
  }
  return undefined
}

function fileRecords(raw: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('files must be an array')
  if (raw.length > MAX_FILE_ENTRIES) throw new Error(`files exceeds ${MAX_FILE_ENTRIES} entries`)
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`files[${index}] must be an object`)
    }
    return entry as Readonly<Record<string, unknown>>
  })
}

function delegationContext(projection: WorkflowProjection, role: AutoReportRole, path: string): Pick<FileNoteSnapshot, 'taskId' | 'delegationKey'> {
  let latest: { taskId: string; delegationKey: string; dispatchedAt: number } | undefined
  for (const task of projection.tasks.values()) {
    if (task.role !== role || task.latestDelegationRevision === undefined) continue
    const delegation = projection.delegations.get(delegationKey(task.taskId, task.latestDelegationRevision))
    if (delegation === undefined || delegation.dispatchedAt === undefined) continue
    const dispatchedAt = delegation.dispatchedAt
    const artifact = projection.artifacts.find(item => item.path === path && item.producedBy === role && item.recordedAt >= dispatchedAt)
    if (artifact === undefined) continue
    if (latest === undefined || delegation.dispatchedAt > latest.dispatchedAt) {
      latest = { taskId: task.taskId, delegationKey: delegationKey(task.taskId, delegation.delegationRevision), dispatchedAt: delegation.dispatchedAt }
    }
  }
  return latest === undefined ? {} : { taskId: latest.taskId, delegationKey: latest.delegationKey }
}

/** Install the AutoReport-compatible agent manifest read/update tool. */
export function installManifestTool(ctx: Context, hostCtx: Context, role: AutoReportRole): () => void {
  let disposeTool: (() => void) | undefined
  try {
    disposeTool = ctx.tools.register(defineTool({
      name: 'manifest',
      description: [
        'AutoReport semantic manifest for agent-produced file handoff; this is not a full workspace index. It tracks successful file mutations made by each role, while agents maintain semantic descriptions and role-level notes. Use list when available for directory discovery and pre-existing file inventory.',
        'Every read first re-stats tracked files against their recorded baselines: files edited outside the harness (user editor, re-run scripts) get refreshed update times and read as stale until re-described.',
        'Read any role manifest; update only your own — action="update" defaults to the caller\u2019s own role, and agent is only for reading another role. A path must already be tracked for your role to accept a description; unknown paths are reported back in not_found and nothing is written for them.',
        'Descriptions are the handoff contract: report_workflow(success) is rejected while any file you changed still has a stale description.',
        'Role notes are durable handoff context that survives across tasks and session rebinds. The reply reports what was applied (description_changes, notes_diff) and what was rejected (not_found, description_mismatches), plus the refreshed manifest.',
      ].join(' '),
      parameters: {
        action: { type: 'string', enum: ['read', 'update'], default: 'read', description: 'read returns the manifest (default); update writes file descriptions and role notes for your own role.' },
        agent: { type: 'string', enum: ['main', 'theory', 'data_analysis', 'plotting', 'report'], description: 'Role whose manifest to act on; defaults to your own role. update may only target your own role.' },
        files: {
          type: 'array',
          description: `File description updates for files you wrote, at most ${MAX_FILE_ENTRIES} entries.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true, description: 'Workspace-relative path of a file already tracked for your role.' },
              description_old: { type: 'string', description: 'Expected current description. A value that does not match the current description skips this path and reports it in description_mismatches instead of writing; omit it to overwrite unconditionally.' },
              description_new: { type: 'string', required: true, description: `New semantic description of the file: what it contains and what downstream agents need from it, up to ${MAX_FILE_DESCRIPTION} chars.` },
            },
          },
        },
        notes_patch: { type: 'string', description: `Line-based patch applied to your own role notes, not a replacement document, up to ${MAX_FILE_NOTES} chars: unchanged context lines start with a space, additions with "+", removals with "-", hunks are separated by a line containing "@@" (optionally "@@ <anchor>"), and "*** End of File" anchors a hunk to the end of the notes. Context lines must match the current notes or the whole patch is rejected.` },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const runtime = runtimeOf(hostCtx)
        const agent = exec.agent as Agent | undefined
        if (runtime === undefined || agent === undefined) throw new Error('manifest requires an AutoReport session')
        // The preset installs the MAIN tool globally. In test/embedded hosts
        // that same registration can also service a bound child, so resolve
        // the caller's fixed role from the durable binding before enforcing
        // the read-any/update-own rule.
        const childOwner = runtime.workflowForChild(agent.id)
        const callerRole = role === 'MAIN'
          ? childOwner?.runtime.state.bindingForChild(agent.id)?.role ?? role
          : role
        const current = currentWorkflow(runtime, agent, callerRole)
        const targetRole = roleFromAgentType(args.agent ?? callerRole.toLowerCase())
        // Refresh from disk BEFORE serving the manifest, for every read AND
        // every update's pre-image: tracked file mtimes must reflect external
        // edits the observer cannot see, or stale detection silently passes
        // files that changed underneath the workflow.
        const refreshed = refreshTrackedFiles(runtime, agent, current.session, current.projection, targetRole)
        const action = args.action === undefined ? 'read' : args.action
        if (action === 'read') return manifestValue(projectManifest(refreshed, targetRole))
        if (action !== 'update') throw new Error(`unknown action '${String(action)}'`)
        if (targetRole !== callerRole) throw new Error(`cannot update other agent's manifest; you can only update ${callerRole.toLowerCase()}`)

        const now = Date.now()
        const before = projectManifest(refreshed, callerRole, () => now)
        const changes: { path: string; old: string; new: string }[] = []
        const mismatches: { path: string; expected: string; actual: string }[] = []
        const notFound: string[] = []
        for (const record of fileRecords(args.files)) {
          const rawPath = stringField(record.path, 'path', 4_096, true) as string
          const path = normalizeProducedPath(rawPath)
          if (path === null) throw new Error(`files.path is absolute or traversing: ${rawPath}`)
          const entry = before.files.find(file => file.path === path)
          if (entry === undefined) {
            notFound.push(path)
            continue
          }
          const descriptionNew = stringField(record.description_new, 'description_new', MAX_FILE_DESCRIPTION, true) as string
          const descriptionOld = stringField(record.description_old, 'description_old', MAX_FILE_DESCRIPTION, false) ?? entry.description
          if (descriptionOld !== entry.description) {
            mismatches.push({ path, expected: descriptionOld, actual: entry.description })
            continue
          }
          if (descriptionNew === entry.description) continue
          const previous = refreshed.fileNotes.get(path)
          const note: FileNoteSnapshot = {
            version: AUTOREPORT_SCHEMA_VERSION,
            path,
            description: descriptionNew,
            descriptionUpdatedAt: now,
            producedBy: callerRole,
            ...(previous?.taskId === undefined ? delegationContext(refreshed, callerRole, path) : {
              taskId: previous.taskId,
              ...(previous.delegationKey === undefined ? {} : { delegationKey: previous.delegationKey }),
            }),
          }
          runtime.commit(current.session, 'autoreport/file-note', note)
          changes.push({ path, old: entry.description, new: descriptionNew })
        }

        let roleNote = refreshed.roleNotes.get(callerRole)
        let roleNotesDiff: string | null = null
        const notesPatch = typeof args.notes_patch === 'string' ? args.notes_patch : undefined
        if (notesPatch !== undefined && notesPatch.trim().length > 0) {
          if (notesPatch.length > MAX_FILE_NOTES) throw new Error(`notes_patch exceeds ${MAX_FILE_NOTES} chars`)
          const oldNotes = roleNote?.notes ?? ''
          const newNotes = applyNotesPatch(oldNotes, notesPatch)
          if (newNotes !== oldNotes) {
            roleNote = {
              version: AUTOREPORT_SCHEMA_VERSION,
              role: callerRole,
              notes: newNotes,
              updatedAt: now,
            } satisfies RoleNoteSnapshot
            runtime.commit(current.session, 'autoreport/role-note', roleNote)
            roleNotesDiff = notesDiff(oldNotes, newNotes)
          }
        }

        const afterProjection = liveProjection(runtime, current.session, agent) ?? refreshed
        const after = projectManifest(afterProjection, callerRole, () => now)
        return {
          status: 'ok',
          manifest: manifestValue(after),
          not_found: notFound,
          description_changes: changes,
          description_mismatches: mismatches,
          notes_diff: roleNotesDiff,
        }
      },
      presentCall: args => genericCall(`manifest ${String(args.action ?? 'read')}`, args.agent),
    }))
  } catch (error: unknown) {
    throw error
  }
  return () => { disposeTool?.() }
}
