import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import { createRoleToolGuard } from '../src/policy/tool-guard.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-guard-'))
  roots.push(root)
  for (const dir of ['Outline', 'Theory', 'Data/Processed', 'Plots', 'Report']) mkdirSync(join(root, dir), { recursive: true })
  return root
}

function binding(role: RoleBindingSnapshot['role'], id: string): RoleBindingSnapshot {
  return {
    version: AUTOREPORT_SCHEMA_VERSION,
    role,
    childSessionId: SessionId(id),
    parentSessionId: SessionId('main'),
    workflowId: 'workflow-1',
    provisioning: 'reserved',
  }
}

function agent(id: string, cwd: string): Agent {
  const sessionId = SessionId(id)
  const session = { id: sessionId, header: { id: sessionId, cwd } } as Session
  return { id: sessionId, session } as Agent
}

function execution(name: string, args: unknown, owner?: Agent): ToolExecution {
  return {
    name,
    arguments: args,
    agent: owner,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

describe('AutoReport role tool guard', () => {
  it.each([
    ['THEORY', 'Theory/notes.md', undefined],
    ['THEORY', 'Report/main.tex', 'Theory'],
    ['DATA_ANALYSIS', 'Data/Processed/result.csv', undefined],
    ['DATA_ANALYSIS', 'Data/raw.csv', 'Data/Processed'],
    ['PLOTTING', 'Plots/Fig/chart.png', undefined],
    ['PLOTTING', 'Data/Processed/chart.png', 'Plots'],
    ['REPORT', 'Report/main.tex', undefined],
    ['REPORT', 'Outline/report.md', 'Report'],
  ] as const)('enforces %s write scope for %s', (role, path, deniedText) => {
    const root = workspace()
    const registry = new RoleRegistry()
    const owner = agent(role.toLowerCase(), root)
    registry.registerReserved(binding(role, owner.id))
    const denial = createRoleToolGuard({ registry })(execution('write', { file_path: path, content: 'x' }, owner))
    if (deniedText === undefined) expect(denial).toBeUndefined()
    else expect(denial).toContain(deniedText)
  })

  it('gives Main only Outline writes and no process execution', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({ registry: new RoleRegistry(), mainSessionId: main.id })
    expect(guard(execution('edit', { file_path: 'Outline/report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: 'Report/main.tex' }, main))).toContain('Outline')
    expect(guard(execution('report_exec', { argv: ['python'] }, main))).toContain('cannot execute')
  })

  it('identifies Main through isMainSession for multiple parent sessions', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({
      registry: new RoleRegistry(),
      isMainSession: id => id === main.id,
    })
    expect(guard(execution('write', { file_path: 'Outline/report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: 'Theory/notes.md' }, main))).toContain('Outline')
  })

  it('authorizes compile_report only for REPORT', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const report = agent('report', root)
    const plotting = agent('plotting', root)
    registry.registerReserved(binding('REPORT', report.id))
    registry.registerReserved(binding('PLOTTING', plotting.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('compile_report', {}, report))).toBeUndefined()
    expect(guard(execution('compile_report', {}, plotting))).toContain('only to REPORT')
  })

  it('handles current str_replace_editor schema and strict future delete/patch schemas', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('str_replace_editor', { command: 'view', path: 'Report/main.tex' }, theory))).toBeUndefined()
    expect(guard(execution('str_replace_editor', { command: 'insert', path: 'Report/main.tex' }, theory))).toContain('Theory')
    expect(guard(execution('delete', { file_path: 'Theory/old.md' }, theory))).toBeUndefined()
    expect(guard(execution('apply_patch', { patch: '*** Update File: Report/main.tex\n@@' }, theory))).toContain('Theory')
    expect(guard(execution('apply_patch', { patch: 'not a patch' }, theory))).toContain('no recognized')
  })

  it('denies agentless, unbound, unrestricted, escaped, and symlink-escaped mutations', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    const unknown = agent('unknown', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('write', { file_path: 'Theory/a.md' }))).toContain('no valid role')
    expect(guard(execution('write', { file_path: 'Theory/a.md' }, unknown))).toContain('no valid role')
    expect(guard(execution('bash', { command: 'true' }, theory))).toContain('report_exec')
    expect(guard(execution('write', { file_path: '../escape' }, theory))).toContain('outside')
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'Theory/link'))
    expect(guard(execution('write', { file_path: 'Theory/link/escape.md' }, theory))).toContain('outside')
  })
})
