/**
 * Test-only PATH `uv` that creates a dest venv whose interpreter can probe
 * and "install" AutoReport analysis packages. Mirrors Host `uv venv` +
 * `uv pip install --python`. Unix uses a shebang `uv`; Windows uses `uv.cmd`
 * plus `Scripts/python.cmd` so spawnSync can run the stubs.
 * @module tests/helpers/managed-python-stub
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const win = process.platform === 'win32'

/** Unix managed-venv interpreter: version, import probe, and analysis marker. */
export const MANAGED_PYTHON_STUB = `#!/bin/sh
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
marker="$root/.analysis-ok"
if [ "$1" = "--version" ]; then echo "Python 3.12.0-managed"; exit 0; fi
if [ "$1" = "-c" ]; then
  case "$2" in
    *find_spec*)
      if [ -f "$marker" ]; then echo OK; exit 0; fi
      echo "MISSING:numpy,scipy,pandas,matplotlib"
      exit 0
      ;;
  esac
  exit 0
fi
echo "Python 3.12.0-managed"
exit 0
`

const MANAGED_PYTHON_CMD = `@echo off
setlocal
set "ROOT=%~dp0.."
set "MARKER=%ROOT%\\.analysis-ok"
if "%~1"=="--version" (
  echo Python 3.12.0-managed
  exit /b 0
)
if "%~1"=="-c" (
  echo %~2 | findstr /C:"find_spec" >nul
  if errorlevel 1 exit /b 0
  if exist "%MARKER%" (
    echo OK
    exit /b 0
  )
  echo MISSING:numpy,scipy,pandas,matplotlib
  exit /b 0
)
echo Python 3.12.0-managed
exit /b 0
`

/**
 * Write a runnable fake interpreter under a prefix (`bin/python` or
 * `Scripts/python.cmd`).
 * @param prefix - venv/conda env root.
 * @param version - `python --version` first line.
 * @returns the executable path `pythonInPrefix` will discover.
 */
export function writeFakePython(prefix: string, version = 'Python 3.12.0-test'): string {
  if (win) {
    const scripts = join(prefix, 'Scripts')
    mkdirSync(scripts, { recursive: true })
    const executable = join(scripts, 'python.cmd')
    writeFileSync(executable, `@echo off\r\necho ${version}\r\nexit /b 0\r\n`)
    return executable
  }
  const bin = join(prefix, 'bin')
  mkdirSync(bin, { recursive: true })
  const executable = join(bin, 'python')
  writeFileSync(executable, `#!/bin/sh\necho ${JSON.stringify(version)}\n`)
  chmodSync(executable, 0o755)
  return executable
}

/**
 * Write a managed-stub interpreter that reports missing analysis packages
 * until `.analysis-ok` exists next to the prefix.
 * @param prefix - venv root (`bin/python` or `Scripts/python.cmd`).
 * @returns the executable path.
 */
export function writeAnalysisPython(prefix: string): string {
  if (win) {
    const scripts = join(prefix, 'Scripts')
    mkdirSync(scripts, { recursive: true })
    const executable = join(scripts, 'python.cmd')
    writeFileSync(executable, MANAGED_PYTHON_CMD)
    return executable
  }
  const destBin = join(prefix, 'bin')
  mkdirSync(destBin, { recursive: true })
  const executable = join(destBin, 'python')
  writeFileSync(executable, MANAGED_PYTHON_STUB)
  chmodSync(executable, 0o755)
  return executable
}

/**
 * Write a PATH `uv` that creates a dest venv whose interpreter is the
 * managed stub, and `uv pip install --python` that marks analysis packages.
 * Stubs are native shell/cmd so tests do not need `node` on the isolated PATH.
 * @param root - directory receiving `bin/uv` (or `uv.cmd`) and the stub file.
 * @returns the bootstrap bin directory to prepend to PATH.
 */
export function writeFakeVenvBootstrap(root: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const stubName = win ? 'managed-python.cmd' : 'managed-python.sh'
  const stub = join(root, stubName)
  writeFileSync(stub, win ? MANAGED_PYTHON_CMD : MANAGED_PYTHON_STUB)
  if (!win) chmodSync(stub, 0o755)

  if (win) {
    const uv = join(bin, 'uv.cmd')
    writeFileSync(uv, [
      '@echo off',
      'setlocal EnableDelayedExpansion',
      `set "STUB=%~dp0..\\${stubName}"`,
      'if /I "%~1"=="venv" goto venv',
      'if /I "%~1"=="pip" goto pip',
      'exit /b 1',
      ':venv',
      'set "DEST=%~2"',
      'if /I "%~2"=="--seed" set "DEST=%~3"',
      'if "!DEST!"=="" exit /b 1',
      'mkdir "!DEST!\\Scripts" >nul 2>&1',
      'copy /Y "%STUB%" "!DEST!\\Scripts\\python.cmd" >nul',
      'copy /Y "%STUB%" "!DEST!\\Scripts\\python3.cmd" >nul',
      'exit /b 0',
      ':pip',
      'shift',
      ':findpy',
      'if "%~1"=="" exit /b 1',
      'if /I "%~1"=="--python" (',
      '  set "PY=%~2"',
      '  goto gotpy',
      ')',
      'shift',
      'goto findpy',
      ':gotpy',
      'if "!PY!"=="" exit /b 1',
      'for %%I in ("!PY!") do echo.>"%%~dpI..\\.analysis-ok"',
      'exit /b 0',
      '',
    ].join('\r\n'))
    return bin
  }

  const uv = join(bin, 'uv')
  writeFileSync(uv, `#!/bin/sh
STUB="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/${stubName}"
if [ "$1" = "venv" ]; then
  dest="$2"
  if [ "$2" = "--seed" ]; then dest="$3"; fi
  [ -n "$dest" ] || exit 1
  mkdir -p "$dest/bin"
  cp "$STUB" "$dest/bin/python"
  chmod 755 "$dest/bin/python"
  cp "$STUB" "$dest/bin/python3"
  chmod 755 "$dest/bin/python3"
  exit 0
fi
if [ "$1" = "pip" ]; then
  py=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--python" ]; then py="$arg"; break; fi
    prev="$arg"
  done
  [ -n "$py" ] || exit 1
  : > "$(dirname "$py")/../.analysis-ok"
  exit 0
fi
exit 1
`)
  chmodSync(uv, 0o755)
  return bin
}

/** PATH overlay that prefers `bin` over the host interpreters. */
export function pathWithBin(bin: string): NodeJS.ProcessEnv {
  const sep = win ? ';' : ':'
  const current = process.env.PATH ?? process.env.Path ?? ''
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [bin, current].filter(part => part.length > 0).join(sep),
  }
  if (win) delete env.Path
  return env
}

/** Constructor detect options that do not scan the host conda/PATH. */
export const ISOLATED_PYTHON_DETECT = {
  condaCli: false,
  wellKnownConda: false,
  env: { PATH: '' },
} as const
