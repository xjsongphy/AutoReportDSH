/**
 * Runtime artifact observation over the durable tool pipeline (PLAN.md
 * §2.11). Successful mutations made by model-facing filesystem tools and
 * process tools (`bash` / `pwsh`) produce `autoreport/artifact` facts; agents
 * never report their own files.
 *
 * The observer folds BOTH halves of a tool call from the session log: the
 * `tool/call` event carries the name and frozen arguments, the correlated
 * `tool/result` event carries the success flag. Only the pair (call seen,
 * result successful) yields artifacts.
 * @module
 */

import { isAbsolute, relative, resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { rolePolicy, type AutoReportRole } from '../roles.js'
import type { ArtifactSnapshot } from '../workflow/events.js'
import { AUTOREPORT_SCHEMA_VERSION } from '../workflow/events.js'
import { type DirSnapshot, diffSnapshots, shouldIgnore, snapshotDir } from './artifact-policy.js'
import { MUTATION_TOOL_NAMES } from '../policy/tool-guard.js'

/** Process tools whose workspace writes are observed via before/after snapshots. */
const PROCESS_TOOL_NAMES = new Set(['bash', 'pwsh'])

/** Caller identity resolved by the same mechanism as the role guard. */
export interface ArtifactCaller {
  readonly role: AutoReportRole
  /** Absolute experiment workspace root used to normalize target paths. */
  readonly workspaceRoot: string
}

/** Dependencies borrowed from the host workflow runtime. */
export interface ArtifactObserverDependencies {
  /** Resolve the calling agent's role and workspace; undefined callers are ignored. */
  readonly resolveCaller: (sessionId: string) => ArtifactCaller | undefined
  /** Current attempt key for one specialist child, when one is open. */
  readonly currentDelegationKey?: ((childSessionId: string) => { taskId: string; key: string } | undefined) | undefined
  /** Durable commit through {@link appendWorkflowEvent}; must apply to the live projection. */
  readonly commit: (sessionId: string, data: ArtifactSnapshot) => void
}

/** One pending mutation call between its `tool/call` and `tool/result`. */
interface PendingCall {
  readonly callId: string
  readonly sessionId: string
  readonly name: string
  /** Named targets for filesystem tools; empty for process tools. */
  readonly paths: readonly string[]
  /** Log position of the `tool/call`; results cite it through `sourceEventSeqs`. */
  readonly seq: number
  /** Pre-run snapshot for process tools; absent for filesystem tools. */
  readonly before?: DirSnapshot
}

/** Extract Codex-style patch targets without interpreting patch content. */
function patchTargets(args: Readonly<Record<string, unknown>>): readonly string[] {
  const patch = typeof args['patch'] === 'string' && args['patch'].length > 0
    ? args['patch']
    : typeof args['input'] === 'string' && args['input'].length > 0
      ? args['input']
      : undefined
  if (patch === undefined) return []
  const paths: string[] = []
  for (const line of patch.split(/\r?\n/u)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line)
    if (match?.[1] !== undefined) paths.push(match[1])
  }
  return paths
}

function stringField(args: Readonly<Record<string, unknown>>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Target paths named by one mutation call's arguments, using guard-identical field rules. */
export function mutationTargetPaths(toolName: string, args: unknown): readonly string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return []
  const record = args as Readonly<Record<string, unknown>>
  switch (toolName) {
    case 'write':
    case 'edit': {
      const path = stringField(record, 'file_path')
      return path === undefined ? [] : [path]
    }
    case 'str_replace_editor': {
      if (record['command'] === 'view') return []
      const path = stringField(record, 'path')
      return path === undefined ? [] : [path]
    }
    case 'delete':
    case 'delete_file': {
      const path = stringField(record, 'file_path', 'path')
      return path === undefined ? [] : [path]
    }
    case 'apply_patch':
      return patchTargets(record)
    default:
      return []
  }
}

/** Workspace-relative POSIX spelling; outside roots stay absolute and visible. */
function normalizePath(workspaceRoot: string, raw: string): string {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)
  const rel = relative(workspaceRoot, absolute)
  return rel === '' || rel.startsWith('..') ? absolute : rel.split('\\').join('/')
}

/** Absolute writable root for one caller role (first policy entry). */
function writableRoot(caller: ArtifactCaller): string {
  const relativeRoot = rolePolicy(caller.role).writableRoots[0] ?? '.'
  return resolve(caller.workspaceRoot, relativeRoot)
}

/** Workspace-relative path for one entry returned by {@link snapshotDir}. */
function processArtifactPath(caller: ArtifactCaller, relativeToWritableRoot: string): string {
  const relRoot = rolePolicy(caller.role).writableRoots[0] ?? '.'
  if (relRoot === '.') return relativeToWritableRoot.split('\\').join('/')
  return `${relRoot}/${relativeToWritableRoot}`.split('\\').join('/')
}

/** Deduplication memory keyed by `${toolName}\u0000${path}\u0000${seq}`. */
export class ArtifactDedup {
  private readonly seen = new Set<string>()

  /**
   * Whether one (toolName, path, seq) triple was already folded.
   * @param toolName - mutating tool name.
   * @param path - normalized artifact path.
   * @param seq - durable result-event sequence number.
   * @returns true only for the first sighting.
   */
  first(toolName: string, path: string, seq: number): boolean {
    const key = `${toolName}${path} ${String(seq)}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }

  /** Number of remembered triples (diagnostics/tests). */
  get size(): number {
    return this.seen.size
  }
}

/** Mutable fold state carried across one session's events. */
export interface ArtifactFoldState {
  readonly pending: Map<string, PendingCall>
  readonly dedup: ArtifactDedup
}

/** Fresh fold state for one session stream. */
export function emptyArtifactFoldState(): ArtifactFoldState {
  return { pending: new Map(), dedup: new ArtifactDedup() }
}

/**
 * Pure fold of one session-log event into artifact snapshots. Success is read
 * from the correlated `tool/result` message block exactly as the loop wrote
 * it (`content[0].isError === false`).
 * @param event - committed session event.
 * @param caller - resolved caller identity, or undefined to skip.
 * @param state - per-session mutable fold state (pending calls + dedup).
 * @param deps - delegation-key lookup and durable commit sink.
 * @returns committed snapshots (already handed to `deps.commit`); empty unless
 *   a successful mutation completed here.
 */
export function foldArtifact(
  event: SessionEvent,
  caller: ArtifactCaller | undefined,
  state: ArtifactFoldState,
  deps: Pick<ArtifactObserverDependencies, 'currentDelegationKey' | 'commit'> & {
    /** Session id owning the observed stream. */
    readonly sessionId: string
  },
): readonly ArtifactSnapshot[] {
  if (caller === undefined) return []
  if (event.type === 'tool/call') {
    const data = event.data as { callId: string; name: string; arguments: string }
    const isProcess = PROCESS_TOOL_NAMES.has(data.name)
    const isFs = MUTATION_TOOL_NAMES.has(data.name)
    if (!isProcess && !isFs) return []
    let parsed: unknown
    let paths: readonly string[] = []
    if (isFs) {
      try {
        parsed = JSON.parse(data.arguments) as unknown
      } catch {
        return []
      }
      paths = mutationTargetPaths(data.name, parsed)
    }
    const before = isProcess ? snapshotDir(writableRoot(caller)) : undefined
    state.pending.set(data.callId, {
      callId: data.callId,
      sessionId: deps.sessionId,
      name: data.name,
      paths,
      seq: event.seq,
      ...(before !== undefined ? { before } : {}),
    })
    return []
  }
  if (event.type !== 'tool/result') return []

  const data = event.data as {
    message: { content: readonly [{ isError?: boolean }] | readonly never[] }
  }
  const callSeq = event.sourceEventSeqs?.[0]
  const pending = callSeq === undefined
    ? undefined
    : [...state.pending.values()].find(call => call.seq === callSeq)
  if (pending === undefined) return []
  state.pending.delete(pending.callId)

  const success = data.message?.content?.[0]?.isError === false
  if (!success) return []

  const committed: ArtifactSnapshot[] = []
  if (pending.before !== undefined) {
    const after = snapshotDir(writableRoot(caller))
    for (const change of diffSnapshots(pending.before, after)) {
      const path = processArtifactPath(caller, change.path)
      if (shouldIgnore(path)) continue
      if (!state.dedup.first(pending.name, path, event.seq)) continue
      const attempt = caller.role === 'MAIN'
        ? undefined
        : deps.currentDelegationKey?.(deps.sessionId)
      const snapshot: ArtifactSnapshot = {
        version: AUTOREPORT_SCHEMA_VERSION,
        path,
        producedBy: caller.role,
        origin: 'process',
        status: change.kind,
        recordedAt: Date.now(),
        ...(attempt !== undefined ? { taskId: attempt.taskId, delegationKey: attempt.key } : {}),
      }
      deps.commit(deps.sessionId, snapshot)
      committed.push(snapshot)
    }
    return committed
  }

  for (const raw of pending.paths) {
    const path = normalizePath(caller.workspaceRoot, raw)
    if (shouldIgnore(path)) continue
    if (!state.dedup.first(pending.name, path, event.seq)) continue
    const attempt = caller.role === 'MAIN'
      ? undefined
      : deps.currentDelegationKey?.(deps.sessionId)
    const snapshot: ArtifactSnapshot = {
      version: AUTOREPORT_SCHEMA_VERSION,
      path,
      producedBy: caller.role,
      origin: 'fs-tool',
      status: 'created',
      recordedAt: Date.now(),
      ...(attempt !== undefined ? { taskId: attempt.taskId, delegationKey: attempt.key } : {}),
    }
    deps.commit(deps.sessionId, snapshot)
    committed.push(snapshot)
  }
  return committed
}

/**
 * Subscribe one session/event stream to the artifact fold. Artifacts are
 * committed to the OWNING workflow session (MAIN's), keeping every
 * `autoreport/*` fact in one durable place.
 * @param session - session whose tool calls are observed.
 * @param emit - commit sink receiving (owningSessionId, snapshot).
 * @param deps - caller resolution and delegation lookup over the host runtime.
 * @returns disposer removing the listener.
 */
export function attachArtifactObserver(
  session: {
    readonly id: { toString(): string }
    readonly header: { cwd?: string | undefined }
    on(event: 'session/event', listener: (session: unknown, event: SessionEvent) => void): () => void
  },
  deps: ArtifactObserverDependencies,
): () => void {
  const state = emptyArtifactFoldState()
  const sessionId = String(session.id)
  return session.on('session/event', (_observed, event) => {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return
    const caller = deps.resolveCaller(sessionId)
    if (caller === undefined) return
    foldArtifact(event, caller, state, {
      sessionId,
      currentDelegationKey: deps.currentDelegationKey,
      commit: (owner, data) => deps.commit(owner, data),
    })
  })
}
