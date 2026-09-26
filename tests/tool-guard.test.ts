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
    ['THEORY', 'notes.md', undefined],
    ['THEORY', (root: string) => join(root, 'Theory/notes.md'), undefined],
    ['THEORY', (root: string) => join(root, 'Report/main.tex'), 'Theory'],
    ['DATA_ANALYSIS', 'result.csv', undefined],
    ['DATA_ANALYSIS', (root: string) => join(root, 'Data/Processed/result.csv'), undefined],
    ['DATA_ANALYSIS', (root: string) => join(root, 'Data/raw.csv'), 'Data/Processed'],
    ['PLOTTING', 'chart.png', undefined],
    ['PLOTTING', (root: string) => join(root, 'Plots/chart.png'), undefined],
    ['PLOTTING', (root: string) => join(root, 'Data/Processed/chart.png'), 'Plots'],
    ['REPORT', 'main.tex', undefined],
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

  it('gives Main only Outline writes and allows bash', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({ registry: new RoleRegistry(), mainSessionId: main.id })
    expect(guard(execution('edit', { file_path: 'main.tex' }, main))).toBeUndefined()
    expect(guard(execution('edit', { file_path: join(root, 'Outline/main.tex') }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, main))).toContain('Outline')
    expect(guard(execution('bash', { command: 'true' }, main))).toBeUndefined()
  })

  it('creates only the authorized mutation parent on demand', () => {
    const root = emptyWorkspace()
    const main = agent('lazy-main', root, { agentPreset: AUTOREPORT_MAIN_PRESET })
    const guard = createRoleToolGuard({ registry: new RoleRegistry() })

    expect(guard(execution('write', { file_path: '.cache/plan.md' }, main))).toBeUndefined()
    expect(existsSync(join(root, 'Outline/.cache'))).toBe(true)
    expect(existsSync(join(root, 'Report'))).toBe(false)
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, main))).toContain('Outline')
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, main))).not.toContain('/init')
  })

  it('recognizes a MAIN root through the autoreport preset alone', () => {
    const root = workspace()
    const main = agent('preset-main', root, { agentPreset: AUTOREPORT_MAIN_PRESET })
    const guard = createRoleToolGuard({ registry: new RoleRegistry() })
    expect(guard(execution('edit', { file_path: 'report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Theory/notes.md') }, main))).toContain('Outline')
    expect(guard(execution('bash', { command: 'true' }, main))).toBeUndefined()
  })

  it('identifies Main through isMainSession for multiple parent sessions', () => {
    const root = workspace()
    const main = agent('main', root)
    const guard = createRoleToolGuard({
      registry: new RoleRegistry(),
      isMainSession: id => id === main.id,
    })
    expect(guard(execution('write', { file_path: 'report.md' }, main))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Theory/notes.md') }, main))).toContain('Outline')
  })

  it('anchors relative edits to the second role writable root and accepts absolute workspace paths', () => {
    const root = workspace()
    const analyst = agent('analyst-edit', root)
    const registry = new RoleRegistry()
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('edit', { file_path: 'result.csv' }, analyst))).toBeUndefined()
    expect(guard(execution('edit', { file_path: join(root, 'Data/Processed/result.csv') }, analyst))).toBeUndefined()
    expect(guard(execution('edit', { file_path: join(root, 'Plots/result.csv') }, analyst))).toContain('Data/Processed')
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
    expect(guard(execution('str_replace_editor', { command: 'view', path: join(root, 'Theory/formulas.md') }, analyst))).toBeUndefined()
    expect(guard(execution('str_replace_editor', { command: 'insert', path: join(root, 'Report/main.tex') }, analyst))).toContain('Data/Processed')
    expect(guard(execution('delete', { file_path: 'old.md' }, analyst))).toBeUndefined()
    expect(guard(execution('apply_patch', { patch: `*** Update File: ${join(root, 'Report/main.tex')}\n@@` }, analyst))).toContain('Data/Processed')
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

  it('enforces role-specific model-facing reads while preserving tool membership', () => {
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
    expect(guard(execution('read', { file_path: 'Data/raw.txt' }, theory))).toContain('allowed read directories')
    expect(guard(execution('read_image', { file_path: 'Data/scan.png' }, theory))).toContain('allowed read directories')
    expect(guard(execution('bash', { command: 'cat Data/raw.txt' }, theory))).toContain('no shell execution')
    expect(guard(execution('str_replace_editor', { command: 'view', path: 'Data/raw.txt' }, theory))).toContain('allowed read directories')
    expect(guard(execution('list', { path: '.', depth: 1 }, theory))).toBeUndefined()
    expect(guard(execution('list', { path: './', depth: 1 }, theory))).toBeUndefined()
    expect(guard(execution('list', { path: join(root, 'Theory'), depth: 1 }, theory))).toContain('workspace-relative')
    expect(guard(execution('list', { path: 'Data', depth: 2 }, theory))).toContain('allowed read directories')
    expect(guard(execution('skill', { name: 'arbitrary' }, theory))).toBeUndefined()
    expect(guard(execution('manifest', { action: 'read' }, theory))).toBeUndefined()
    // Manifests are small coordination metadata (file handoff summaries), so
    // cross-role reads remain available even when raw file reads are scoped.
    expect(guard(execution('manifest', { action: 'read', agent: 'data_analysis' }, theory))).toBeUndefined()
    expect(guard(execution('report_workflow', {}, theory))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Data/raw.txt' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'python analyze.py' }, analyst))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'Plots/fit.png' }, analyst))).toContain('allowed read directories')
    expect(guard(execution('read', { file_path: '../outside.txt' }, analyst))).toContain('outside the experiment workspace')
  })

  it('gives bash preflight denials actionable command and directory context', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const analyst = agent('preflight-analyst', root)
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    const guard = createRoleToolGuard({ registry })

    const dangerous = guard(execution('bash', { command: 'rm -rf Data' }, analyst))
    expect(dangerous).toContain('recursive rm is blocked')
    expect(dangerous).toContain('advisory supported commands for this role:')
    expect(dangerous).toContain('allowed read directories: References/, Outline/, Theory/, Data/')
    expect(dangerous).toContain('allowed write directories: Data/Processed/')
    expect(guard(execution('bash', { command: 'invented-command file' }, analyst))).toContain('unsupported command "invented-command"')
    expect(guard(execution('bash', { command: 'cd Data && python analyze.py' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'rm -f preview.tmp' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cd .. && rm raw.csv' }, analyst))).toContain('only inside this role\'s writable directories')
    expect(guard(execution('bash', {
      command: 'python - <<\'PY\'\nprint("checks; and pipes |")\nPY',
    }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'typst compile Report/main.typ' }, analyst))).toContain('unsupported command "typst"')
    expect(guard(execution('bash', { command: 'python analyze.py' }, analyst))).toBeUndefined()
  })

  it('advertises shell commands by role without offering other specialists’ tools', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const main = agent('main-command-policy', root)
    const plotter = agent('plot-command-policy', root)
    const reporter = agent('report-command-policy', root)
    registry.registerReserved(binding('PLOTTING', plotter.id))
    registry.registerReserved(binding('REPORT', reporter.id))
    const guard = createRoleToolGuard({ registry, mainSessionId: main.id })

    expect(guard(execution('bash', { command: 'pdftotext input.pdf -' }, main))).toBeUndefined()
    expect(guard(execution('bash', { command: 'latexmk -xelatex main.tex' }, main))).toContain('unsupported command "latexmk"')
    expect(guard(execution('bash', { command: 'python fit.py' }, main))).toContain('unsupported command "python"')
    expect(guard(execution('bash', { command: 'gnuplot plot.gp' }, plotter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'python plot.py' }, plotter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'pdflatex main.tex' }, plotter))).toContain('unsupported command "pdflatex"')
    expect(guard(execution('bash', { command: 'latexmk -xelatex main.tex' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'typst compile main.typ' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'gnuplot plot.gp' }, reporter))).toContain('unsupported command "gnuplot"')
    expect(guard(execution('bash', { command: `cd ${root}/Report; rm -f preview.pdf` }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'rm -f preview.pdf', workdir: `${root}/Report` }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'rm -f raw.csv', workdir: `${root}/Data` }, reporter)))
      .toContain('only inside this role\'s writable directories')
    expect(guard(execution('bash', { command: 'cd /tmp; rm -f preview.pdf', workdir: `${root}/Report` }, reporter)))
      .toContain('cannot cd to /tmp')
    expect(guard(execution('bash', { command: 'python -c "open(\"Data/raw.csv\").read()"' }, reporter))).toBeUndefined()
  })

  it('preflights obvious bash read paths while leaving the interpreter limitation explicit', () => {
    const root = workspace()
    const main = agent('main-bash-paths', root)
    const analyst = agent('analyst-bash-paths', root)
    const reporter = agent('reporter-bash-paths', root)
    const registry = new RoleRegistry()
    registry.registerReserved(binding('DATA_ANALYSIS', analyst.id))
    registry.registerReserved(binding('REPORT', reporter.id))
    const guard = createRoleToolGuard({ registry, mainSessionId: main.id })

    const catDenied = guard(execution('bash', { command: 'cat ../Data/raw.csv' }, main))
    expect(catDenied).toContain('cannot read ../Data/raw.csv with cat')
    expect(catDenied).toContain('allowed read directories: References/, Outline/')
    expect(guard(execution('bash', { command: 'cat ../References/procedure.md' }, main))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cd ../Data && pwd' }, main))).toContain('cannot cd to ../Data')
    expect(guard(execution('bash', { command: 'pwd', workdir: '../Data' }, main))).toContain('cannot use bash workdir ../Data')
    expect(guard(execution('bash', { command: 'cp ../Data/raw.csv raw.csv' }, main))).toContain('cannot read ../Data/raw.csv with cp')
    expect(guard(execution('bash', { command: 'ls ../Data' }, main))).toContain('cannot read ../Data with ls')
    expect(guard(execution('bash', { command: 'rg raw ../Data' }, main))).toContain('cannot read ../Data with rg')
    expect(guard(execution('bash', { command: 'find ../Data -type f' }, main))).toContain('cannot read ../Data with find')
    expect(guard(execution('bash', { command: 'du ../Data' }, main))).toContain('cannot read ../Data with du')
    expect(guard(execution('bash', { command: 'ls ..' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'rg raw ..' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cp ../raw.csv raw.csv' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cp ../Data/raw.csv raw.csv' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cp ../Data/raw.csv ../Theory/raw.csv' }, reporter)))
      .toContain('cannot write ../Theory/raw.csv with cp')
    expect(guard(execution('bash', { command: 'cp -t . ../Data/raw.csv' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'mkdir -p tmp' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'mkdir -p ../Data/tmp' }, reporter))).toContain('allowed write directories: Report/')
    expect(guard(execution('bash', { command: 'printf x > output.txt' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'printf x > ../Theory/output.txt' }, reporter))).toContain('allowed write directories: Report/')
    expect(guard(execution('bash', { command: 'mv old.tex new.tex' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'mv ../Data/raw.csv raw.csv' }, reporter)))
      .toContain('cannot move source ../Data/raw.csv')
    expect(guard(execution('bash', { command: 'cat analysis.md' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'cat analysis.md', workdir: 'nested' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'printf x > output.csv' }, analyst))).toBeUndefined()
    expect(guard(execution('bash', { command: 'typst compile main.typ main.pdf' }, reporter))).toBeUndefined()
    expect(guard(execution('bash', { command: 'typst compile main.typ main.pdf', workdir: 'compile' }, reporter))).toBeUndefined()
    // The preflight catches common path operands; Python can still read files
    // from an allowed command, so this is not process-level read confinement.
    expect(guard(execution('bash', { command: 'python -c "open(\"../Data/raw.csv\").read()"' }, main))).toContain('unsupported command "python"')
  })

  it('denies model read paths whose symlink resolves outside their allowed roots', () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-read-outside-'))
    roots.push(outside)
    mkdirSync(join(root, 'References'), { recursive: true })
    symlinkSync(outside, join(root, 'References', 'escape'))
    const registry = new RoleRegistry()
    const theory = agent('theory-read-link', root)
    registry.registerReserved(binding('THEORY', theory.id))
    expect(createRoleToolGuard({ registry })(execution('read', { file_path: 'References/escape/secret.txt' }, theory)))
      .toContain('outside the experiment workspace')
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
    expect(guard(execution('read', { file_path: join(neighboringBundle, 'hidden.md') }, reporter)))
      .toContain('outside the experiment workspace')
    expect(guard(execution('read', { file_path: join(typstBundle, 'basics.md') }, analyst)))
      .toContain('outside the experiment workspace')
  })

  it('denies bound specialists write escapes', () => {
    const root = workspace()
    const registry = new RoleRegistry()
    const theory = agent('theory', root)
    registry.registerReserved(binding('THEORY', theory.id))
    const guard = createRoleToolGuard({ registry })
    expect(guard(execution('bash', { command: 'true' }, theory))).toContain('no shell execution')
    expect(guard(execution('write', { file_path: '../../escape' }, theory))).toContain('outside')
    const outside = mkdtempSync(join(tmpdir(), 'autoreport-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(root, 'Theory/link'))
    expect(guard(execution('write', { file_path: join(root, 'Theory/link/escape.md') }, theory))).toContain('outside')

    // Production child shape: parentSession set AND registry-bound.
    const publishedChild = agent('theory-child', root, { parentSession: SessionId('main') })
    registry.registerReserved(binding('THEORY', publishedChild.id))
    expect(guard(execution('write', { file_path: 'a.md' }, publishedChild))).toBeUndefined()
    expect(guard(execution('write', { file_path: join(root, 'Report/main.tex') }, publishedChild))).toContain('Theory')
  })
})
