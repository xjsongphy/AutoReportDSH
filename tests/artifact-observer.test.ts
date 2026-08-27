import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOREPORT_SCHEMA_VERSION, type ArtifactSnapshot } from '../src/workflow/events.js'
import {
  attachArtifactObserver,
  emptyArtifactFoldState,
  foldArtifact,
  mutationTargetPaths,
  type ArtifactCaller,
} from '../src/artifacts/observer.js'

const WORKSPACE = '/tmp/ws'

function caller(role: ArtifactCaller['role'] = 'DATA_ANALYSIS'): ArtifactCaller {
  return { role, workspaceRoot: WORKSPACE }
}

let nextSeq = 1
function callEvent(name: string, args: unknown, callId = 'call-1'): SessionEvent<'tool/call'> {
  const seq = nextSeq++
  return {
    type: 'tool/call',
    seq,
    time: 1,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  } as unknown as SessionEvent<'tool/call'>
}

function resultEvent(callSeq: number, isError: boolean, resultId = 'call-1'): SessionEvent<'tool/result'> {
  const seq = nextSeq++
  return {
    type: 'tool/result',
    seq,
    time: 2,
    sourceEventSeqs: [callSeq],
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        id: 'm' + String(seq),
        content: [{ type: 'tool-result', toolCallId: resultId, content: [{ type: 'text', text: 'ok' }], isError }],
        source: { kind: 'tool', callId: resultId },
      },
    },
  } as unknown as SessionEvent<'tool/result'>
}

describe('mutationTargetPaths', () => {
  it('extracts write/edit file_path and delete aliases', () => {
    expect(mutationTargetPaths('write', { file_path: '/a.md', content: 'x' })).toEqual(['/a.md'])
    expect(mutationTargetPaths('delete_file', { path: '/b.md' })).toEqual(['/b.md'])
  })

  it('extracts str_replace_editor paths but ignores view commands', () => {
    expect(mutationTargetPaths('str_replace_editor', { command: 'create', path: '/c.md' })).toEqual(['/c.md'])
    expect(mutationTargetPaths('str_replace_editor', { command: 'view', path: '/c.md' })).toEqual([])
  })

  it('parses apply_patch headers only', () => {
    const patch = '*** Begin Patch\n*** Add File: d.md\n+hi\n*** Update File: e.md\n'
    expect(mutationTargetPaths('apply_patch', { patch })).toEqual(['d.md', 'e.md'])
    expect(mutationTargetPaths('apply_patch', { patch: '*** Begin Patch\n' })).toEqual([])
  })
})

describe('foldArtifact', () => {
  it('commits one artifact for a successful write with workspace-relative path and attempt keys', () => {
    const state = emptyArtifactFoldState()
    const committed: ArtifactSnapshot[] = []
    const deps = {
      sessionId: 'child-1',
      currentDelegationKey: () => ({ taskId: 'task-3', key: 'task-3#2' }),
      commit: (_sessionId: string, snapshot: ArtifactSnapshot) => committed.push(snapshot),
    }
    const call = callEvent('write', { file_path: `${WORKSPACE}/Data/Processed/out.csv` })
    expect(foldArtifact(call, caller(), state, deps)).toEqual([])
    const artifacts = foldArtifact(resultEvent((call as unknown as { seq: number }).seq, false), caller(), state, deps)
    expect(committed).toHaveLength(1)
    expect(artifacts).toEqual(committed)
    expect(committed[0]).toMatchObject({
      version: AUTOREPORT_SCHEMA_VERSION,
      path: 'Data/Processed/out.csv',
      producedBy: 'DATA_ANALYSIS',
      origin: 'fs-tool',
      status: 'created',
      taskId: 'task-3',
      delegationKey: 'task-3#2',
    })
  })

  it('produces nothing for failed or denied results', () => {
    const state = emptyArtifactFoldState()
    const committed: ArtifactSnapshot[] = []
    const deps = {
      sessionId: 'child-1',
      currentDelegationKey: undefined,
      commit: (_s: string, snapshot: ArtifactSnapshot) => committed.push(snapshot),
    }
    const call = callEvent('edit', { file_path: `${WORKSPACE}/Theory/x.md` })
    foldArtifact(call, caller('THEORY'), state, deps)
    const failed = foldArtifact(resultEvent(call.seq as number, true), caller('THEORY'), state, deps)
    expect(failed).toEqual([])
    expect(committed).toEqual([])
  })

  it('records MAIN as producedBy for Main Outline writes', () => {
    const state = emptyArtifactFoldState()
    const committed: ArtifactSnapshot[] = []
    const deps = {
      sessionId: 'main-1',
      currentDelegationKey: undefined,
      commit: (_s: string, snapshot: ArtifactSnapshot) => committed.push(snapshot),
    }
    const call = callEvent('write', { file_path: `${WORKSPACE}/Outline/plan.md` })
    foldArtifact(call, caller('MAIN'), state, deps)
    foldArtifact(resultEvent((call as unknown as { seq: number }).seq, false), caller('MAIN'), state, deps)
    expect(committed[0]?.producedBy).toBe('MAIN')
  })

  it('skips cache paths under Outline/.cache', () => {
    const state = emptyArtifactFoldState()
    const committed: ArtifactSnapshot[] = []
    const deps = {
      sessionId: 'main-1',
      currentDelegationKey: undefined,
      commit: (_s: string, snapshot: ArtifactSnapshot) => committed.push(snapshot),
    }
    const call = callEvent('write', { file_path: `${WORKSPACE}/Outline/.cache/mineru/out.md` })
    foldArtifact(call, caller('MAIN'), state, deps)
    foldArtifact(resultEvent((call as unknown as { seq: number }).seq, false), caller('MAIN'), state, deps)
    expect(committed).toEqual([])
  })

  it('observes bash process writes via before/after snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-bash-'))
    const outline = join(root, 'Outline')
    mkdirSync(outline, { recursive: true })
    writeFileSync(join(outline, 'before.md'), 'x')
    const state = emptyArtifactFoldState()
    const committed: ArtifactSnapshot[] = []
    const deps = {
      sessionId: 'main-1',
      currentDelegationKey: undefined,
      commit: (_s: string, snapshot: ArtifactSnapshot) => committed.push(snapshot),
    }
    const mainCaller: ArtifactCaller = { role: 'MAIN', workspaceRoot: root }
    const call = callEvent('bash', { command: 'echo hi > new.md' })
    foldArtifact(call, mainCaller, state, deps)
    writeFileSync(join(outline, 'after.md'), 'y')
    foldArtifact(resultEvent((call as unknown as { seq: number }).seq, false), mainCaller, state, deps)
    expect(committed).toEqual([expect.objectContaining({
      path: 'Outline/after.md',
      producedBy: 'MAIN',
      origin: 'process',
      status: 'created',
    })])
  })

  it('produces nothing for failed bash results', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-bash-fail-'))
    mkdirSync(join(root, 'Theory'), { recursive: true })
    const state = emptyArtifactFoldState()
    const committed: ArtifactSnapshot[] = []
    const deps = {
      sessionId: 'child-1',
      currentDelegationKey: undefined,
      commit: (_s: string, snapshot: ArtifactSnapshot) => committed.push(snapshot),
    }
    const theoryCaller: ArtifactCaller = { role: 'THEORY', workspaceRoot: root }
    const call = callEvent('bash', { command: 'false' }, 'call-b')
    foldArtifact(call, theoryCaller, state, deps)
    writeFileSync(join(root, 'Theory', 'leak.md'), 'x')
    foldArtifact(resultEvent((call as unknown as { seq: number }).seq, true), theoryCaller, state, deps)
    expect(committed).toEqual([])
  })

  it('ignores non-mutation tools entirely', () => {
    const state = emptyArtifactFoldState()
    const read = callEvent('read', { path: '/x' }, 'call-r')
    expect(foldArtifact(read, caller(), state, {
      sessionId: 'child-1',
      currentDelegationKey: undefined,
      commit: () => {},
    })).toEqual([])
    expect(state.pending.size).toBe(0)
  })

  it('deduplicates repeated delivery of the same triple', () => {
    const state = emptyArtifactFoldState()
    let count = 0
    const deps = {
      sessionId: 'child-1',
      currentDelegationKey: undefined,
      commit: () => {
        count += 1
      },
    }
    const call = callEvent('write', { file_path: `${WORKSPACE}/Outline/a.md` })
    foldArtifact(call, caller('MAIN'), state, deps)
    const result = resultEvent((call as unknown as { seq: number }).seq, false)
    foldArtifact(result, caller('MAIN'), state, deps)
    // Replay of the identical result event must not double-commit.
    const replayState = emptyArtifactFoldState()
    replayState.dedup = state.dedup
    foldArtifact(call, caller('MAIN'), replayState, deps)
    foldArtifact(result, caller('MAIN'), replayState, deps)
    expect(count).toBe(1)
  })
})

describe('attachArtifactObserver', () => {
  class FakeSession {
    readonly listeners: Array<(session: unknown, event: SessionEvent) => void> = []
    readonly id = { toString: () => 'main-session' }
    readonly header = { cwd: WORKSPACE }
    on(event: 'session/event', listener: (session: unknown, event: SessionEvent) => void): () => void {
      if (event !== 'session/event') throw new Error(String(event))
      this.listeners.push(listener)
      return () => {
        this.listeners.splice(this.listeners.indexOf(listener), 1)
      }
    }
    emit(session: unknown, event: SessionEvent): void {
      for (const listener of [...this.listeners]) listener(session, event)
    }
  }

  it('wires session events to commits and disposes cleanly', () => {
    const session = new FakeSession()
    const committed: Array<{ owner: string; path: string }> = []
    const dispose = attachArtifactObserver(session, {
      resolveCaller: sessionId => (sessionId === 'main-session' ? caller('MAIN') : undefined),
      commit: (owner, snapshot) => committed.push({ owner, path: snapshot.path }),
    })
    const call = callEvent('write', { file_path: `${WORKSPACE}/Outline/plan.md` }, 'call-w')
    session.emit(session, call)
    session.emit(session, resultEvent((call as unknown as { seq: number }).seq, false, 'call-w'))
    expect(committed).toEqual([{ owner: 'main-session', path: 'Outline/plan.md' }])
    dispose()
    expect(session.listeners.length).toBe(0)
  })

  it('ignores streams whose caller cannot be resolved', () => {
    const session = new FakeSession()
    let commits = 0
    attachArtifactObserver(session, {
      resolveCaller: () => undefined,
      commit: () => {
        commits += 1
      },
    })
    const call = callEvent('write', { file_path: '/elsewhere/x.md' }, 'call-x')
    session.emit(session, call)
    session.emit(session, resultEvent((call as unknown as { seq: number }).seq, false, 'call-x'))
    expect(commits).toBe(0)
  })
})
