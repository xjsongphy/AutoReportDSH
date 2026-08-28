import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectPythonEnvironments,
  ensureManagedPython,
  invalidCustomPythonPath,
  MANAGED_PYTHON_SENTINEL,
  managedPythonExecutable,
  pythonBinDir,
} from '../src/python-detect.js'

function fakePython(root: string, version = 'Python 3.12.0-test'): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const executable = join(bin, 'python')
  writeFileSync(executable, `#!/bin/sh\necho ${JSON.stringify(version)}\n`)
  chmodSync(executable, 0o755)
  return executable
}

/** Interpreter that implements `python3 -m venv <dest>` by writing a stub venv. */
function fakeVenvPython(root: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const executable = join(bin, 'python3')
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Python 3.12.0-bootstrap"
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  dest="$3"
  mkdir -p "$dest/bin"
  printf '%s\\n' '#!/bin/sh' 'echo Python 3.12.0-managed' > "$dest/bin/python"
  chmod +x "$dest/bin/python"
  cp "$dest/bin/python" "$dest/bin/python3"
  exit 0
fi
exit 1
`)
  chmodSync(executable, 0o755)
  return executable
}

function createEnv(bin: string): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  return { PATH: [bin, '/usr/bin', '/bin'].join(sep) }
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
  it('creates $dshHome/autoreport/venv via python3 -m venv when uv is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'autoreport-managed-'))
    const dshHome = join(root, 'dsh')
    fakeVenvPython(join(root, 'bootstrap'))
    const created = ensureManagedPython({
      dshHome,
      env: createEnv(join(root, 'bootstrap', 'bin')),
    })
    expect(realpathSync(created)).toBe(realpathSync(managedPythonExecutable(dshHome)))
    expect(invalidCustomPythonPath(created)).toBeUndefined()
    expect(ensureManagedPython({
      dshHome,
      env: createEnv(join(root, 'bootstrap', 'bin')),
    })).toBe(created)
  })
})

describe('pythonBinDir', () => {
  it('returns the parent of an absolute interpreter and omits a bare command', () => {
    expect(pythonBinDir('/opt/venv/bin/python3')).toBe('/opt/venv/bin')
    expect(pythonBinDir('python3')).toBeUndefined()
  })
})
