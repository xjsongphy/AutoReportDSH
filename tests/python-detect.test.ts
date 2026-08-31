import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_PACKAGES,
  detectPythonEnvironments,
  ensureAnalysisPackages,
  ensureManagedPython,
  invalidCustomPythonPath,
  MANAGED_PYTHON_SENTINEL,
  managedPythonExecutable,
  managedVenvDir,
  missingAnalysisPackages,
  pythonBinDir,
  removeManagedPython,
} from '../src/python-detect.js'
import { pathWithBin, writeAnalysisPython, writeFakePython, writeFakeVenvBootstrap } from './helpers/managed-python-stub.js'

function fakePython(root: string, version = 'Python 3.12.0-test'): string {
  return writeFakePython(root, version)
}

describe('detectPythonEnvironments', () => {
  it('lists a workspace venv and PATH python without requiring a custom-path check', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'autoreport-py-detect-'))
    const executable = fakePython(join(workspace, '.venv'))
    const found = detectPythonEnvironments({
      workspace,
      home: join(workspace, 'no-home'),
      env: { PATH: '' },
      condaCli: false,
      wellKnownConda: false,
    })
    expect(found.some(candidate => candidate.source === 'virtualenv' && candidate.executable.includes('.venv'))).toBe(true)
    expect(invalidCustomPythonPath(executable)).toBeUndefined()
  })

  it('lists conda base and named envs under an install prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-conda-'))
    fakePython(root, 'Python 3.13.0-base')
    fakePython(join(root, 'envs', 'lab'), 'Python 3.12.0-lab')
    const found = detectPythonEnvironments({
      home: join(root, 'no-home'),
      env: { PATH: '' },
      extraCondaRoots: [root],
      condaCli: false,
      wellKnownConda: false,
    })
    expect(found.some(candidate => candidate.source === 'conda' && candidate.label === 'Conda · lab')).toBe(true)
    expect(found.some(candidate => candidate.source === 'conda' && candidate.executable.includes(`${join('envs', 'lab')}`))).toBe(true)
  })

  it('rejects a typed path that is not an interpreter', () => {
    expect(invalidCustomPythonPath('python3')).toMatch(/absolute/u)
    expect(invalidCustomPythonPath(join(tmpdir(), 'missing-python'))).toMatch(/does not exist/u)
  })

  it('always lists the AutoReport-managed row first when dshHome is set', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'autoreport-dsh-home-'))
    const found = detectPythonEnvironments({
      dshHome,
      home: join(dshHome, 'no-user-home'),
      env: { PATH: '' },
      condaCli: false,
      wellKnownConda: false,
    })
    expect(found[0]).toMatchObject({
      source: 'managed',
      executable: MANAGED_PYTHON_SENTINEL,
      version: 'created on save',
    })
  })

  it('lists a CLI ~/.autoreport/venv as a local AutoReportCLI row, not managed', () => {
    const home = mkdtempSync(join(tmpdir(), 'autoreport-cli-home-'))
    fakePython(join(home, '.autoreport', 'venv'), 'Python 3.11.0-cli')
    const found = detectPythonEnvironments({
      home,
      env: { PATH: '' },
      condaCli: false,
      wellKnownConda: false,
    })
    expect(found.some(candidate => candidate.source === 'virtualenv' && candidate.label === 'AutoReportCLI · venv')).toBe(true)
    expect(found.some(candidate => candidate.source === 'managed')).toBe(false)
  })
})

describe('ensureManagedPython', () => {
  it('creates $dshHome/autoreport/venv with uv venv when the user selects managed', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-managed-'))
    const dshHome = join(root, 'dsh')
    const bin = writeFakeVenvBootstrap(join(root, 'bootstrap'))
    const created = ensureManagedPython({
      dshHome,
      env: pathWithBin(bin),
    })
    expect(realpathSync(created)).toBe(realpathSync(managedPythonExecutable(dshHome)))
    expect(invalidCustomPythonPath(created)).toBeUndefined()
    expect(missingAnalysisPackages(created)).toEqual([])
    expect(ensureManagedPython({
      dshHome,
      env: pathWithBin(bin),
    })).toBe(created)
  })

  it('does not create the venv until ensureManagedPython runs, and removeManagedPython deletes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-managed-remove-'))
    const dshHome = join(root, 'dsh')
    const bin = writeFakeVenvBootstrap(join(root, 'bootstrap'))
    expect(existsSync(managedVenvDir(dshHome))).toBe(false)
    const created = ensureManagedPython({ dshHome, env: pathWithBin(bin) })
    expect(existsSync(created)).toBe(true)
    removeManagedPython(dshHome)
    expect(existsSync(managedVenvDir(dshHome))).toBe(false)
    const recreated = ensureManagedPython({ dshHome, env: pathWithBin(bin) })
    expect(missingAnalysisPackages(recreated)).toEqual([])
  })

  it('refuses to create the managed venv when uv is absent', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'autoreport-managed-no-uv-'))
    expect(() => ensureManagedPython({
      dshHome,
      env: { PATH: join(dshHome, 'empty-bin') },
    })).toThrow(/requires uv on PATH/)
    expect(existsSync(managedVenvDir(dshHome))).toBe(false)
  })

  it('reports missing analysis packages until uv pip install succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-py-pkgs-'))
    const bin = writeFakeVenvBootstrap(join(root, 'bootstrap'))
    const python = writeAnalysisPython(join(root, 'venv'))
    expect(missingAnalysisPackages(python)).toEqual([...ANALYSIS_PACKAGES])
    expect(ensureAnalysisPackages(python, pathWithBin(bin))).toEqual([...ANALYSIS_PACKAGES])
    expect(missingAnalysisPackages(python)).toEqual([])
  })
})

describe('pythonBinDir', () => {
  it('returns the parent of an absolute interpreter and omits a bare command', () => {
    const executable = join(tmpdir(), 'venv', 'bin', 'python3')
    expect(pythonBinDir(executable)).toBe(dirname(executable))
    expect(pythonBinDir('python3')).toBeUndefined()
  })
})
