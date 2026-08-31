/**
 * Test-only PATH `uv` that creates a dest venv whose interpreter can probe
 * and "install" AutoReport analysis packages. Mirrors Host `uv venv` +
 * `uv pip install --python`.
 * @module tests/helpers/managed-python-stub
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Managed-venv interpreter: version, import probe, and analysis marker. */
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

/**
 * Write a PATH `uv` that creates a dest venv whose interpreter is
 * {@link MANAGED_PYTHON_STUB}, and `uv pip install --python` that marks
 * analysis packages present.
 * @param root - directory receiving `bin/uv` and the stub file.
 * @returns the bootstrap bin directory to prepend to PATH.
 */
export function writeFakeVenvBootstrap(root: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const stub = join(root, 'managed-python.sh')
  writeFileSync(stub, MANAGED_PYTHON_STUB)
  chmodSync(stub, 0o755)
  const uv = join(bin, 'uv')
  writeFileSync(uv, `#!/bin/sh
stub=${JSON.stringify(stub)}
if [ "$1" = "venv" ]; then
  dest="$2"
  if [ "$2" = "--seed" ]; then dest="$3"; fi
  mkdir -p "$dest/bin"
  cp "$stub" "$dest/bin/python"
  chmod +x "$dest/bin/python"
  cp "$dest/bin/python" "$dest/bin/python3"
  exit 0
fi
if [ "$1" = "pip" ]; then
  py=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--python" ]; then
      py="$2"
      shift 2
      continue
    fi
    shift
  done
  if [ -z "$py" ]; then exit 1; fi
  root="$(CDPATH= cd -- "$(dirname "$py")/.." && pwd)"
  touch "$root/.analysis-ok"
  exit 0
fi
exit 1
`)
  chmodSync(uv, 0o755)
  return bin
}

/** PATH overlay that prefers `bin` over the host interpreters. */
export function pathWithBin(bin: string): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  return { PATH: [bin, '/usr/bin', '/bin'].join(sep) }
}
