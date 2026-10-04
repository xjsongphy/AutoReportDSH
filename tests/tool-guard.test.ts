import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
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
import { ROLE_PROCESS_TOOL } from '../src/roles.js'

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
    ['THEORY', (root: string) => join(root, 'Theory/notes.md'), undefined],
    ['THEORY', (root: string) => join(root, 'Report/main.tex'), 'Theory'],
    ['DATA_ANALYSIS', 'Data/Processed/result.csv', undefined],
    ['DATA_ANALYSIS', (root: string) => join(root, 'Data/Processed/result.csv'), undefined],
    ['DATA_ANALYSIS', (root: string) => join(root, 'Data/raw.csv'), 'Data/Processed'],
    ['PLOTTING', 'Plots/chart.png', undefined],
    ['PLOTTING', (root: string) => join(root, 'Plots/chart.png'), undefined],
    ['PLOTTING', (root: string) => join(root, 'Data/Processed/chart.png'), 'Plots'],
    ['REPORT', 'Report/main.tex', undefined],
    ['REPORT', (root: string) => join(root, 'Report/main.tex'), undefined],
    ['REPORT', (root: string) => join(root, 'Outline/report.md'), 'Report'],
  ] as const)('enforces %s write scope for %s', (role, path, deniedText) => {
    const root = workspace()
    const registry = new RoleRegistry()
    const owner = agent(role.toLowerCase(), root)
    registry.registerReserved(binding(role, owner.id))
    const filePath = typeof path === 'function' ? path(root) : path
    const denial = createRoleToolGuard({ registry })(execution('write', { file_path: filePath, content: 'x' }, owner))
    if (deniedText === undefined) expect(denial).toBeUndefined()
    else expect(denial).toContain(deniedText)
  })

  it('rejects bare relative writes outside the writable root: all paths are workspace-relative', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('write', { file_path: 'notes.md' }, theory))).toContain('writes only inside Theory/')
  })

  it('gives Main Outline-only writes and no process tool', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({ registry: new RoleRegistry(), mainSessionId: main.id })
    expect(guard(execution('edit', { file_path: 'Outline/main.tex' }, main))).toBeUndefined()
    expect(guard(execution('edit', { file_path: join(root, 'Outline/main.tex') }, main))).toBeUndefined()
    expect(guard(execution('edit', { file_path: 'main.tex' }, main))).toContain('Outline')
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, main))).toContain('Outline')
    expect(guard(execution('bash', { command: 'uv --version' }, main))).toContain('no process tool')
    expect(guard(execution('bash', { command: 'python inspect.py' }, main))).toContain('no process tool')
  })

  it('creates only the authorized mutation parent on demand', () => {
    const root = emptyWorkspace()
    const main = agent('lazy-main', root, { agentPreset: AUTOREPORT_MAIN_PRESET })
    const guard = createRoleToolGuard({ registry: new RoleRegistry() })

    expect(guard(execution('write', { file_path: 'Outline/.cache/plan.md' }, main))).toBeUndefined()
    expect(existsSync(join(root, 'Outline/.cache'))).toBe(true)
    expect(existsSync(join(root, 'Report'))).toBe(false)
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, main))).toContain('Outline')
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, main))).not.toContain('/init')
  })

  it('recognizes a MAIN root through the autoreport preset alone', () => {
    const root = workspace()
    const main = agent('preset-main', root, { agentPreset: AUTOREPORT_MAIN_PRESET })
    const guard = createRoleToolGuard({ registry: new RoleRegistry() })
    expect(guard(execution('edit', { file_path: 'Outline/report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Theory/notes.md') }, main))).toContain('Outline')
    expect(guard(execution('bash', { command: 'uv --version' }, main))).toContain('no process tool')
  })

  it('identifies Main through isMainSession for multiple parent sessions', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({
      registry: new RoleRegistry(),
      isMainSession: id => id === main.id,
    })
    expect(guard(execution('write', { file_path: 'Outline/report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Theory/notes.md') }, main))).toContain('Outline')
  })

  it('anchors every write path to the workspace root and accepts absolute workspace paths', () => {
    const root = workspace()
    const analyst = agent('analyst-edit', root)
    const registry = new RoleRegistry()
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('edit', { file_path: 'Data/Processed/result.csv' }, analyst))).toBeUndefined()
    expect(guard(execution('edit', { file_path: join(root, 'Data/Processed/result.csv') }, analyst))).toBeUndefined()
    expect(guard(execution('edit', { file_path: join(root, 'Plots/result.csv') }, analyst))).toContain('Data/Processed')
  })

  it('denies generic process escalation for MAIN and specialists', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const main = agent('main', root)
    const analyst = agent('analyst', root)
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry, mainSessionId: main.id })
    const escalation = { sandbox_permissions: 'danger-full-access' }
    // Package changes use a dedicated environment capability, not generic shell escalation.
    expect(guard(execution('bash', { command: 'uv --version', ...escalation }, main)))
      .toContain('dedicated MAIN environment capability')
    expect(guard(execution('bash', { command: 'true', ...escalation }, analyst)))
      .toContain('generic sandbox escalation')
  })

  it('denies background shell calls even for compute roles', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const analyst = agent('analyst', root)
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })
    // Stock dsh shells expose run_in_background; a preset-mounted shell that
    // replaces the AutoReport compute shell must not reopen background jobs.
    expect(guard(execution(ROLE_PROCESS_TOOL, { command: 'python a.py', run_in_background: true }, analyst)))
      .toContain('foreground')
    expect(guard(execution(ROLE_PROCESS_TOOL, { command: 'python a.py', run_in_background: false }, analyst))).toBeUndefined()
    expect(guard(execution(ROLE_PROCESS_TOOL, { command: 'python a.py' }, analyst))).toBeUndefined()
  })

  it('lets hidden optional DSH tools fall through to the registry unknown-tool result', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const analyst = agent('analyst', root)
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('str_replace_editor', { command: 'view', path: join(root, 'Theory/formulas.md') }, analyst)))
      .toBeUndefined()
    expect(guard(execution('str_replace_editor', { command: 'create', path: join(root, 'Theory/result.md') }, analyst)))
      .toBeUndefined()
    // delete/apply_patch are also unmapped; the strict schemas deny via membership.
    expect(guard(execution('delete', { file_path: 'Data/Processed/old.md' }, analyst))).toContain('no declared capability')
    expect(guard(execution('apply_patch', { patch: `*** Update File: ${join(root, 'Report/main.tex')}\n@@` }, analyst)))
      .toContain('no declared capability')
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
      execution('write', { file_path: join(root, 'Report/main.tex') }, switchedAway),
    )).toBeUndefined()

    // An ordinary DSH continuable child keeps its native behavior too.
    const ordinaryChild = agent('ordinary-child', root, { parentSession: SessionId('some-parent') })
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('write', { file_path: join(root, 'Data/raw.csv') }, ordinaryChild),
    )).toBeUndefined()

    // Agentless calls are equally unknown, not invalid AutoReport calls.
    expect(createRoleToolGuard({ registry: new RoleRegistry() })(
      execution('write', { file_path: 'anywhere' }),
    )).toBeUndefined()
  })

  it('gives every role the whole workspace for reads and never parses shell commands', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const main = agent('main-reads', root)
    const theory = agent('theory', root)
    const analyst = agent('analyst', root)
    registry.registerReserved(binding('THEORY', theory.id))
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry, mainSessionId: main.id })

    // Read scope is the whole workspace for every role: context, not duty.
    expect(guard(execution('read', { file_path: 'References/handout.md' }, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Data/raw.txt' }, theory))).toBeUndefined()
    expect(guard(execution('read_image', { file_path: 'Data/scan.png' }, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Plots/fit.png' }, analyst))).toBeUndefined()
    expect(guard(execution('list', { path: '.', depth: 1 }, theory))).toBeUndefined()
    expect(guard(execution('list', { path: './', depth: 1 }, theory))).toBeUndefined()
    expect(guard(execution('list', { path: 'Data', depth: 2 }, theory))).toBeUndefined()
    expect(guard(execution('list', { path: join(root, 'Theory'), depth: 1 }, theory))).toContain('workspace-relative')
    expect(guard(execution('list', { path: '.', depth: 4 }, theory))).toBeUndefined()
    expect(guard(execution('list', { path: '.', depth: 5 }, theory))).toContain('depth')
    expect(guard(execution('list', { path: '.', depth: 0 }, theory))).toContain('depth')
    expect(guard(execution('grep', { pattern: 'result', path: '.' }, theory))).toBeUndefined()
    expect(guard(execution('grep', { pattern: 'raw' }, theory))).toBeUndefined()
    expect(guard(execution('grep', { pattern: 'voltage', path: 'Data/Raw' }, main))).toBeUndefined()
    expect(guard(execution('grep', { pattern: 'voltage', path: join(root, 'Data/Raw') }, main))).toContain('workspace-relative')
    expect(guard(execution('skill', { name: 'arbitrary' }, theory))).toBeUndefined()
    expect(guard(execution('manifest', { action: 'read' }, theory))).toBeUndefined()
    expect(guard(execution('manifest', { action: 'read', agent: 'data_analysis' }, theory))).toBeUndefined()
    expect(guard(execution('report_workflow', {}, theory))).toBeUndefined()
    // Hidden tools should reach DSH's normal unknown-tool path, not an
    // AutoReport refusal that discloses their names to the model.
    expect(guard(execution('glob', { pattern: '**/*.csv' }, main))).toBeUndefined()
    // Reads must stay inside the workspace boundary.
    const deniedRead = guard(execution('read', { file_path: '../outside.txt' }, analyst))
    expect(deniedRead).toContain('can read only the experiment workspace')
    expect(deniedRead).toContain('Readable directories for this role:')
    expect(deniedRead).toContain(realpathSync.native(root))
    // No shell parsing: a process role's shell call is never inspected.
    expect(guard(execution(ROLE_PROCESS_TOOL, { command: 'python analyze.py' }, analyst))).toBeUndefined()
    expect(guard(execution(ROLE_PROCESS_TOOL, { command: 'rm -rf Data' }, analyst))).toBeUndefined()
    expect(guard(execution(ROLE_PROCESS_TOOL, { command: 'typst compile Report/main.typ' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cat Data/raw.txt' }, theory))).toContain('no process tool')
    // Platform shell mismatch stays denied.
    const otherProcessTool = ROLE_PROCESS_TOOL === 'bash' ? 'pwsh' : 'bash'
    expect(guard(execution(otherProcessTool, { command: 'Get-Location' }, analyst))).toContain(`${ROLE_PROCESS_TOOL} tool`)
  })

  it('lets MAIN review report sources while keeping Report read-only', () => {
    const root = workspace()
    const main = agent('main-editorial-review', root)
    const guard = createRoleToolGuard({ registry: new RoleRegistry(), mainSessionId: main.id })

    expect(guard(execution('read', { file_path: 'Report/main.tex' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex'), content: 'edited by MAIN' }, main)))
      .toContain('Outline')
    expect(guard(execution('write', { file_path: 'Outline/report_outline.md', content: 'scope' }, main))).toBeUndefined()
  })

  it('denies DSH-created agents and workflow delegation for MAIN and specialists', () => {
    const root = workspace()
    const main = agent('main-no-stock-delegation', root)
    const analyst = agent('analyst-no-stock-delegation', root)
    const registry = new RoleRegistry()
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry, mainSessionId: main.id })
    for (const roleAgent of [main, analyst]) {
      for (const name of ['workflow', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'todo_write']) {
        expect(guard(execution(name, {}, roleAgent))).toContain('fixed AutoReport role workflow')
      }
    }
    expect(guard(execution('send_to_agent', {}, main))).toBeUndefined()
    expect(guard(execution('send_to_agent', {}, analyst))).toContain('fixed AutoReport role workflow')
    expect(guard(execution('future_search_tool', { path: 'Data' }, analyst))).toContain('no declared capability')
  })

  it('denies model read paths whose symlink resolves outside the workspace', () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-read-outside-'))
    roots.push(outside)
    mkdirSync(join(root, 'References'), { recursive: true })
    symlinkSync(outside, join(root, 'References', 'escape'))
    const registry = new RoleRegistry()
    const theory = agent('theory-read-link', root)
    registry.registerReserved(binding('THEORY', theory.id))
    expect(createRoleToolGuard({ registry })(execution('read', { file_path: 'References/escape/secret.txt' }, theory)))
      .toContain('can read only the experiment workspace')
  })

  it('allows only the current role’s registered skill bundle resource root', () => {
    const root = workspace()
    const pluginResources = mkdtempSync(join(tmpdir(), 'autoreport-skill-resources-'))
    roots.push(pluginResources)
    const typstBundle = join(pluginResources, 'typst', 'skills', 'typst')
    const neighboringBundle = join(pluginResources, 'latex', 'skills')
    mkdirSync(typstBundle, { recursive: true })
    mkdirSync(neighboringBundle, { recursive: true })
    const registry = new RoleRegistry()
    const reporter = agent('report-resource-reader', root)
    const analyst = agent('analysis-resource-reader', root)
    registry.registerReserved(binding('REPORT', reporter.id))
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({
      registry,
      readableResourceRootsOf: (_id, role) => role === 'REPORT' ? [typstBundle] : [],
    })

    expect(guard(execution('read', { file_path: join(typstBundle, 'basics.md') }, reporter))).toBeUndefined()
    const deniedReporterRead = guard(execution('read', { file_path: join(neighboringBundle, 'hidden.md') }, reporter))
    expect(deniedReporterRead).toContain('can read only the experiment workspace')
    expect(deniedReporterRead).toContain(`Readable directories for this role: "${realpathSync.native(root)}"`)
    expect(deniedReporterRead).toContain(`"${realpathSync.native(typstBundle)}"`)
    expect(guard(execution('read', { file_path: join(typstBundle, 'basics.md') }, analyst)))
      .toContain('can read only the experiment workspace')
  })

  it('denies bound specialists write escapes', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('bash', { command: 'true' }, theory))).toContain('no process tool')
    expect(guard(execution('write', { file_path: '../escape' }, theory))).toContain('outside')
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'Theory/link'))
    expect(guard(execution('write', { file_path: join(root, 'Theory/link/escape.md') }, theory))).toContain('outside')

    // Production child shape: parentSession set AND registry-bound.
    const publishedChild = agent('theory-child', root, { parentSession: SessionId('main') })
    registry.registerReserved(binding('THEORY', publishedChild.id))
    expect(guard(execution('write', { file_path: 'Theory/a.md' }, publishedChild))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, publishedChild))).toContain('Theory')
  })
})
