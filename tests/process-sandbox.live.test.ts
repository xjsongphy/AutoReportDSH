import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { roleProcessCommand } from '../src/policy/process-sandbox.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function backendUsable(): boolean {
  if (process.platform === 'darwin') {
    return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '--', 'true'], {
      timeout: 5_000, stdio: 'ignore',
    }).status === 0
  }
  if (process.platform === 'linux') {
    return spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--', 'true'], {
      timeout: 5_000, stdio: 'ignore',
    }).status === 0
  }
  return false
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function runRoleCommand(root: string, cwd: string, command: string) {
  const wrapped = roleProcessCommand('PLOTTING', root, cwd, command)
  return spawnSync('/bin/bash', ['-lc', wrapped], { cwd, encoding: 'utf8', timeout: 30_000 })
}

const liveSandboxAvailable = backendUsable()

describe.skipIf(!liveSandboxAvailable)('role-aware process filesystem view', () => {
  it('lets Python read only Plotting roots and write only Plots/', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-process-scope-'))
    roots.push(root)
    for (const directory of ['References', 'Outline', 'Theory', 'Data/Raw', 'Data/Processed', 'Plots', 'Report']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    writeFileSync(join(root, 'Data/Raw/private.csv'), 'raw-secret-marker')
    writeFileSync(join(root, 'Data/Processed/analysis.csv'), 'processed-marker')
    writeFileSync(join(root, 'Report/main.tex'), 'report-secret-marker')
    const cwd = resolve(root, 'Plots')
    const pythonAvailable = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5_000 }).status === 0
    const executable = pythonAvailable ? 'python3' : 'cat'
    const allowedPath = join(root, 'Data/Processed/analysis.csv')
    const deniedPath = join(root, 'Data/Raw/private.csv')
    const deniedReport = join(root, 'Report/main.tex')
    const readAllowed = executable === 'python3'
      ? runRoleCommand(root, cwd, `python3 -c 'import pathlib; print(pathlib.Path(${JSON.stringify(allowedPath)}).read_text())'`)
      : runRoleCommand(root, cwd, `cat ${shellQuote(allowedPath)}`)
    expect(readAllowed.status, readAllowed.stderr).toBe(0)
    expect(readAllowed.stdout).toContain('processed-marker')

    const readRaw = executable === 'python3'
      ? runRoleCommand(root, cwd, `python3 -c 'import pathlib; print(pathlib.Path(${JSON.stringify(deniedPath)}).read_text())'`)
      : runRoleCommand(root, cwd, `cat ${shellQuote(deniedPath)}`)
    expect(readRaw.status).not.toBe(0)
    expect(readRaw.stdout).not.toContain('raw-secret-marker')

    const readReport = executable === 'python3'
      ? runRoleCommand(root, cwd, `python3 -c 'import pathlib; print(pathlib.Path(${JSON.stringify(deniedReport)}).read_text())'`)
      : runRoleCommand(root, cwd, `cat ${shellQuote(deniedReport)}`)
    expect(readReport.status).not.toBe(0)
    expect(readReport.stdout).not.toContain('report-secret-marker')

    const allowedWrite = join(root, 'Plots/generated.txt')
    const writePlots = executable === 'python3'
      ? runRoleCommand(root, cwd, `python3 -c 'import pathlib; pathlib.Path(${JSON.stringify(allowedWrite)}).write_text("plot-output")'`)
      : runRoleCommand(root, cwd, `printf plot-output > ${shellQuote(allowedWrite)}`)
    expect(writePlots.status, writePlots.stderr).toBe(0)
    expect(readFileSync(allowedWrite, 'utf8')).toBe('plot-output')

    const deniedWrite = join(root, 'Report/forbidden.txt')
    const writeReport = executable === 'python3'
      ? runRoleCommand(root, cwd, `python3 -c 'import pathlib; pathlib.Path(${JSON.stringify(deniedWrite)}).write_text("forbidden")'`)
      : runRoleCommand(root, cwd, `printf forbidden > ${shellQuote(deniedWrite)}`)
    expect(writeReport.status).not.toBe(0)
    expect(existsSync(deniedWrite)).toBe(false)
  })
})
