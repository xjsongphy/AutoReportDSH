import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { AUTOREPORT_SCHEMA_VERSION, type RoleBindingSnapshot } from '../src/workflow/events.js'
import { AUTOREPORT_MAIN_PRESET } from '../src/membership.js'
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

function emptyWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoreport-empty-'))
  roots.push(root)
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

function agent(id: string, cwd: string, header: Record<string, unknown> = {}): Agent {
  const sessionId = SessionId(id)
  const session = { id: sessionId, snapshotEvents: () => [] as unknown[], header: { id: sessionId, cwd, ...header } } as Session
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

  it('gives Main only Outline writes and allows bash', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({ registry: new RoleRegistry(), mainSessionId: main.id })
    expect(guard(execution('edit', { file_path: 'Outline/report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: 'Report/main.tex' }, main))).toContain('Outline')
    expect(guard(execution('bash', { command: 'true' }, main))).toBeUndefined()
  })

  it('creates only the authorized mutation parent on demand', () => {
    const root = emptyWorkspace()
    const main = agent('lazy-main', root, { agentPreset: AUTOREPORT_MAIN_PRESET })
    const guard = createRoleToolGuard({ registry: new RoleRegistry() })

    expect(guard(execution('write', { file_path: 'Outline/.cache/plan.md' }, main))).toBeUndefined()
    expect(existsSync(join(root, 'Outline/.cache'))).toBe(true)
    expect(existsSync(join(root, 'Report'))).toBe(false)
    expect(guard(execution('write', { file_path: 'Report/main.tex' }, main))).toContain('Outline')
    expect(guard(execution('write', { file_path: 'Report/main.tex' }, main))).not.toContain('/init')
  })

  it('recognizes a MAIN root through the autoreport preset alone', () => {
    const root = workspace()
    const main = agent('preset-main', root, { agentPreset: AUTOREPORT_MAIN_PRESET })
    const guard = createRoleToolGuard({ registry: new RoleRegistry() })
    expect(guard(execution('edit', { file_path: 'Outline/report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: 'Theory/notes.md' }, main))).toContain('Outline')
    expect(guard(execution('bash', { command: 'true' }, main))).toBeUndefined()
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

  it('passes MAIN escalation to the approval flow but denies it for specialists', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const main = agent('main', root)
    const theory = agent('theory', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry, mainSessionId: main.id })
    const escalation = { sandbox_permissions: 'danger-full-access' }
    // MAIN escalates through to DSH's user-approval flow; the guard steps aside.
    expect(guard(execution('bash', { command: 'true', ...escalation }, main))).toBeUndefined()
    // Specialists get the hard denial: they report missing_dependency instead.
    expect(guard(execution('bash', { command: 'true', ...escalation }, theory)))
      .toContain('sandbox_permissions')
    expect(guard(execution('bash', { command: 'true', ...escalation }, theory)))
      .toContain('MAIN')
  })

  it('handles current str_replace_editor schema and strict future delete/patch schemas', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const analyst = agent('analyst', root)
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('str_replace_editor', { command: 'view', path: 'Report/main.tex' }, analyst))).toBeUndefined()
    expect(guard(execution('str_replace_editor', { command: 'insert', path: 'Report/main.tex' }, analyst))).toContain('Data/Processed')
    expect(guard(execution('delete', { file_path: 'Data/Processed/old.md' }, analyst))).toBeUndefined()
    expect(guard(execution('apply_patch', { patch: '*** Update File: Report/main.tex\n@@' }, analyst))).toContain('Data/Processed')
    expect(guard(execution('apply_patch', { patch: 'not a patch' }, analyst))).toContain('no recognized')
  })

  it('passes foreign sessions through with stock policy untouched', () => {
    const root = workspace()
    const stockRoot = agent('stock-root', root)
    // An ordinary top-level DSH session (no preset) keeps native behavior.
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('write', { file_path: '/etc/autoreport-should-not-see-this' }, stockRoot),
    )).toBeUndefined()
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('bash', { command: 'true' }, stockRoot),
    )).toBeUndefined()

    // A preset-selected root that switched away stays foreign.
    const switchedAway = agent('switched', root, { agentPreset: 'other-preset' })
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('write', { file_path: 'Report/main.tex' }, switchedAway),
    )).toBeUndefined()

    // An ordinary DSH continuable child keeps its native behavior too.
    const ordinaryChild = agent('ordinary-child', root, { parentSession: SessionId('some-parent') })
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('write', { file_path: 'Data/raw.csv' }, ordinaryChild),
    )).toBeUndefined()

    // Agentless calls are equally unknown, not invalid AutoReport calls.
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('write', { file_path: 'anywhere' }),
    )).toBeUndefined()
  })

  it('keeps workspace reads available while denying THEORY shell execution', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    const analyst = agent('analyst', root)
    registry.registerReserved(binding('THEORY', theory.id))
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })

    expect(guard(execution('read', { file_path: 'References/handout.md' }, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Outline/report_outline.md' }, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Theory/formulas.md' }, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Data/raw.txt' }, theory))).toBeUndefined()
    expect(guard(execution('read_image', { file_path: 'Data/scan.png' }, theory))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cat Data/raw.txt' }, theory))).toContain('no shell execution')
    expect(guard(execution('str_replace_editor', { command: 'view', path: 'Data/raw.txt' }, theory))).toBeUndefined()
    expect(guard(execution('skill', { name: 'arbitrary' }, theory))).toBeUndefined()
    expect(guard(execution('manifest', { action: 'read' }, theory))).toBeUndefined()
    expect(guard(execution('report_workflow', {}, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Data/raw.txt' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'python analyze.py' }, analyst))).toBeUndefined()
  })

  it('denies bound specialists write escapes', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('bash', { command: 'true' }, theory))).toContain('no shell execution')
    expect(guard(execution('write', { file_path: '../escape' }, theory))).toContain('outside')
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'Theory/link'))
    expect(guard(execution('write', { file_path: 'Theory/link/escape.md' }, theory))).toContain('outside')

    // Production child shape: parentSession set AND registry-bound.
    const publishedChild = agent('theory-child', root, { parentSession: SessionId('main') })
    registry.registerReserved(binding('THEORY', publishedChild.id))
    expect(guard(execution('write', { file_path: 'Theory/a.md' }, publishedChild))).toBeUndefined()
    expect(guard(execution('write', { file_path: 'Report/main.tex' }, publishedChild))).toContain('Theory')
  })
})
