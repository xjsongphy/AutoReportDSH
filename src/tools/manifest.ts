import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AutoReportRole } from '../roles.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { AUTOREPORT_SCHEMA_VERSION, type FileNoteSnapshot, type RoleNoteSnapshot } from '../workflow/events.js'
import { projectManifest } from '../workflow/manifest.js'
import type { WorkflowProjection } from '../workflow/service.js'
import { delegationKey, normalizeProducedPath } from '../workflow/protocol.js'
import { MAX_FILE_DESCRIPTION, MAX_FILE_NOTES } from '../workflow/file-notes.js'

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

function fileRecords(raw: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('files must be an array')
  if (raw.length > 64) throw new Error('files exceeds 64 entries')
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
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:manifest',
    order: 116,
    text: `Use manifest(action="read") to inspect your AutoReport manifest or another subagent's manifest. You may update only the ${role.toLowerCase()} manifest with manifest(action="update"). File descriptions are required before a successful workflow report; manifest notes are durable handoff context.`,
  })
  let disposeTool: (() => void) | undefined
  try {
    disposeTool = ctx.tools.register(defineTool({
      name: 'manifest',
      description: 'Read or update AutoReport manifests. Read any role manifest; update only your own file descriptions and role-level notes.',
      parameters: {
        action: { type: 'string', enum: ['read', 'update'], default: 'read' },
        agent: { type: 'string', enum: ['main', 'theory', 'data_analysis', 'plotting', 'report'] },
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              description_old: { type: 'string' },
              description_new: { type: 'string' },
            },
          },
        },
        notes_patch: { type: 'string' },
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
        const action = args.action === undefined ? 'read' : args.action
        if (action === 'read') return manifestValue(projectManifest(current.projection, targetRole))
        if (action !== 'update') throw new Error(`unknown action '${String(action)}'`)
        if (targetRole !== callerRole) throw new Error(`cannot update other agent's manifest; you can only update ${callerRole.toLowerCase()}`)

        const now = Date.now()
        const before = projectManifest(current.projection, callerRole, () => now)
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
          const previous = current.projection.fileNotes.get(path)
          const note: FileNoteSnapshot = {
            version: AUTOREPORT_SCHEMA_VERSION,
            path,
            description: descriptionNew,
            descriptionUpdatedAt: now,
            producedBy: callerRole,
            ...(previous?.taskId === undefined ? delegationContext(current.projection, callerRole, path) : {
              taskId: previous.taskId,
              ...(previous.delegationKey === undefined ? {} : { delegationKey: previous.delegationKey }),
            }),
          }
          runtime.commit(current.session, 'autoreport/file-note', note)
          changes.push({ path, old: entry.description, new: descriptionNew })
        }

        let roleNote = current.projection.roleNotes.get(callerRole)
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

        const refreshedProjection = typeof runtime.forSession === 'function'
          ? runtime.forSession(current.session).state.projection()
          : runtime.workflowForChild(agent.id)?.runtime.state.projection() ?? current.projection
        const after = projectManifest(refreshedProjection, callerRole, () => now)
        return {
          status: 'ok',
          manifest: manifestValue(after),
          not_found: notFound,
          description_changes: changes,
          description_mismatches: mismatches,
          notes_diff: roleNotesDiff,
        }
      },
      presentCall: args => ({ card: 'generic', title: `manifest ${String(args.action ?? 'read')}`, kind: 'other', rawInput: args }),
    }))
  } catch (error: unknown) {
    try { disposeSection() } catch { /* rollback best effort */ }
    throw error
  }
  return () => {
    try { disposeTool?.() } finally { disposeSection() }
  }
}
