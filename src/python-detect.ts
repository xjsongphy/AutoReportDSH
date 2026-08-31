/**
 * Discover local Python interpreters the way AutoReportCLI does, offer an
 * AutoReport-managed venv under the DSH home, and validate a user-typed path.
 * Detected candidates are already proven runnable; only a custom path needs a
 * separate check. Picking managed creates `$dshHome/autoreport/venv` with `uv`
 * on save; the directory is not created until then and may be deleted to
 * reclaim space.
 * @module autoreportdsh-python-detect
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/**
 * Stored `pythonExecutable` for the AutoReport-managed venv. The client
 * bundle cannot import this module; it spells the same string.
 */
export const MANAGED_PYTHON_SENTINEL = '__managed__'

/** One discovered interpreter the settings card can offer. */
export interface PythonCandidate {
  /** Human-facing row, including source and version. */
  readonly label: string
  /** `conda`, `virtualenv`, `pyenv`, `path`, or `managed`. */
  readonly source: string
  /**
   * Canonical absolute executable, or {@link MANAGED_PYTHON_SENTINEL} for
   * the AutoReport-managed row (created on save if missing).
   */
  readonly executable: string
  /** `python --version` first line, or `unknown version`. */
  readonly version: string
}

/** Inputs that change which prefixes are scanned. */
export interface PythonDetectOptions {
  /** Experiment workspace; workspace `.venv` / `.env` are probed when set. */
  readonly workspace?: string
  /** User home; absent uses `os.homedir()`. */
  readonly home?: string
  /**
   * DSH home; when set, the AutoReport-managed venv row is always first
   * (`$dshHome/autoreport/venv`), even before that directory exists.
   */
  readonly dshHome?: string
  /** Environment overlay; tests inject CONDA_PREFIX / VIRTUAL_ENV / PATH. */
  readonly env?: NodeJS.ProcessEnv
  /** Extra conda install prefixes (tests and unusual layouts). */
  readonly extraCondaRoots?: readonly string[]
  /** Scan `/Applications/miniforge3` and similar; tests turn this off. */
  readonly wellKnownConda?: boolean
  /** Run `conda env list`; tests turn this off so PATH conda cannot leak in. */
  readonly condaCli?: boolean
}

const HOME_CONDA_INSTALLS = ['miniconda3', 'anaconda3', 'mambaforge', 'miniforge3', 'micromamba'] as const

/** Packages Data Analysis and Plotting need in a healthy AutoReport interpreter. */
export const ANALYSIS_PACKAGES = ['numpy', 'scipy', 'pandas', 'matplotlib'] as const

const WELL_KNOWN_CONDA_ROOTS = [
  '/Applications/miniforge3',
  '/Applications/miniconda3',
  '/Applications/anaconda3',
  '/opt/homebrew/Caskroom/miniforge/base',
  '/opt/miniconda3',
  '/usr/local/miniconda3',
] as const

/**
 * Scan conda, virtualenv, pyenv, PATH, and workspace venvs for runnable
 * interpreters. Duplicates (same real path) are dropped.
 * @param options - workspace, home, and env overrides.
 * @returns candidates in discovery order.
 */
export function detectPythonEnvironments(options: PythonDetectOptions = {}): PythonCandidate[] {
  const env = options.env ?? process.env
  const home = options.home ?? tryHomedir()
  const seen = new Set<string>()
  const candidates: PythonCandidate[] = []
  const managedReal = options.dshHome === undefined
    ? undefined
    : canonicalize(pythonInPrefix(managedVenvDir(options.dshHome)))

  const add = (path: string, source: string, label: string): void => {
    const resolved = canonicalize(path)
    if (resolved === undefined || seen.has(resolved)) return
    if (managedReal !== undefined && resolved === managedReal) return
    if (!isFile(resolved)) return
    const version = pythonVersion(resolved) ?? 'unknown version'
    seen.add(resolved)
    candidates.push({ label, source, executable: resolved, version })
  }

  const condaPrefix = env.CONDA_PREFIX
  if (condaPrefix !== undefined && condaPrefix.length > 0) {
    add(pythonInPrefix(condaPrefix), 'conda', condaLabel(condaPrefix))
  }
  const virtualEnv = env.VIRTUAL_ENV
  if (virtualEnv !== undefined && virtualEnv.length > 0) {
    add(pythonInPrefix(virtualEnv), 'virtualenv', `Virtualenv · ${virtualEnv}`)
  }
  if (options.workspace !== undefined && options.workspace.length > 0) {
    for (const name of ['.venv', '.env']) {
      const prefix = join(options.workspace, name)
      add(pythonInPrefix(prefix), 'virtualenv', `Workspace venv · ${name}`)
    }
  }
  if (home !== undefined) {
    addPyenvChildren(join(home, '.pyenv', 'versions'), add)
    for (const dirname of HOME_CONDA_INSTALLS) {
      addCondaInstall(join(home, dirname), add)
    }
    addCondaChildren(join(home, '.conda', 'envs'), add)
    add(pythonInPrefix(join(home, '.autoreport', 'venv')), 'virtualenv', 'AutoReportCLI · venv')
  }
  if (options.wellKnownConda !== false) {
    for (const root of WELL_KNOWN_CONDA_ROOTS) addCondaInstall(root, add)
  }
  for (const root of options.extraCondaRoots ?? []) addCondaInstall(root, add)
  if (options.condaCli !== false) addCondaCliEnvs(env, add)
  for (const command of ['python3', 'python']) {
    const found = whichCommand(command, env)
    if (found !== undefined) add(found, 'path', `PATH · ${command}`)
  }
  if (options.dshHome !== undefined) {
    return [managedCandidate(options.dshHome), ...candidates]
  }
  return candidates
}

/** Whether a stored pythonExecutable selects the AutoReport-managed venv. */
export function isManagedPythonSetting(value: string): boolean {
  return value.trim() === MANAGED_PYTHON_SENTINEL
}

/** Directory of the DSH-owned AutoReport venv (`$dshHome/autoreport/venv`). */
export function managedVenvDir(dshHome: string): string {
  return join(dshHome, 'autoreport', 'venv')
}

/** Interpreter path that `ensureManagedPython` creates under `dshHome`. */
export function managedPythonExecutable(dshHome: string): string {
  return pythonInPrefix(managedVenvDir(dshHome))
}

/** Error when the managed venv needs `uv` and it is not on PATH. */
const UV_REQUIRED =
  'AutoReport managed Python requires uv on PATH. Install it from https://docs.astral.sh/uv/ then choose the managed environment again.'

/**
 * Create `$dshHome/autoreport/venv` with `uv venv` when missing, install
 * analysis packages with `uv pip`, and return its interpreter. Not created
 * until the user selects the managed row. Idempotent when already runnable
 * with numpy/scipy/pandas/matplotlib. Delete the directory to reclaim space;
 * selecting managed again recreates it.
 * @param options - DSH home and an optional env overlay (tests isolate PATH).
 * @returns the managed interpreter path.
 */
export function ensureManagedPython(options: {
  dshHome: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = options.env ?? process.env
  const dest = managedVenvDir(options.dshHome)
  const existing = pythonInPrefix(dest)
  if (isFile(existing)) {
    const version = pythonVersion(existing)
    if (version !== undefined) {
      const executable = canonicalize(existing) ?? existing
      ensureAnalysisPackages(executable, env)
      return executable
    }
  }

  const uv = requireUv(env)
  mkdirSync(join(options.dshHome, 'autoreport'), { recursive: true })
  runCreate(uv, ['venv', dest], env, `uv venv ${dest}`)

  const created = pythonInPrefix(dest)
  if (!isFile(created) || pythonVersion(created) === undefined) {
    throw new Error(`AutoReport managed venv did not produce a runnable Python at ${created}`)
  }
  const executable = canonicalize(created) ?? created
  ensureAnalysisPackages(executable, env)
  return executable
}

/**
 * Delete `$dshHome/autoreport/venv`. No-op when the directory is already gone.
 * Does not change settings; choosing managed later recreates it with `uv`.
 * @param dshHome - DSH home that owns the AutoReport venv.
 */
export function removeManagedPython(dshHome: string): void {
  rmSync(managedVenvDir(dshHome), { recursive: true, force: true })
}

/**
 * Import names that failed to load in `executable`, in {@link ANALYSIS_PACKAGES}
 * order. An interpreter that cannot run the probe is treated as missing all.
 * @param executable - absolute interpreter path.
 * @returns missing package names; empty when all import.
 */
export function missingAnalysisPackages(executable: string): string[] {
  const mods = ANALYSIS_PACKAGES.map(name => JSON.stringify(name)).join(', ')
  const script = [
    'import importlib.util',
    `missing=[m for m in [${mods}] if importlib.util.find_spec(m) is None]`,
    'print("OK" if not missing else "MISSING:"+ ",".join(missing))',
  ].join('; ')
  try {
    const result = spawnCli(executable, ['-c', script], { timeout: 20_000 })
    if (result.error !== undefined || result.status !== 0) return [...ANALYSIS_PACKAGES]
    const text = firstLine(result.stdout)
    if (text === 'OK') return []
    if (text.startsWith('MISSING:')) {
      return text.slice('MISSING:'.length).split(',').filter(name => name.length > 0)
    }
    return [...ANALYSIS_PACKAGES]
  } catch {
    return [...ANALYSIS_PACKAGES]
  }
}

function requireUv(env: NodeJS.ProcessEnv): string {
  const uv = whichCommand('uv', env)
  if (uv === undefined) throw new Error(UV_REQUIRED)
  return uv
}

/**
 * Install {@link ANALYSIS_PACKAGES} into `executable` when any are missing.
 * Uses `uv pip install --python`; does not write into user conda/venv paths
 * unless that path is the AutoReport-managed interpreter.
 * @param executable - interpreter that should receive the packages.
 * @param env - PATH overlay for locating `uv`.
 * @returns packages that were missing before install.
 */
export function ensureAnalysisPackages(executable: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = missingAnalysisPackages(executable)
  if (missing.length === 0) return []
  const uv = requireUv(env)
  runCreate(
    uv,
    ['pip', 'install', '--python', executable, ...ANALYSIS_PACKAGES],
    env,
    `uv pip install --python ${executable} ${ANALYSIS_PACKAGES.join(' ')}`,
    300_000,
  )
  const stillMissing = missingAnalysisPackages(executable)
  if (stillMissing.length > 0) {
    throw new Error(
      `AutoReport managed venv is missing analysis packages after install: ${stillMissing.join(', ')}`,
    )
  }
  return missing
}

function managedCandidate(dshHome: string): PythonCandidate {
  const executable = pythonInPrefix(managedVenvDir(dshHome))
  const version = isFile(executable) ? pythonVersion(executable) : undefined
  return {
    label: 'AutoReport managed venv',
    source: 'managed',
    executable: MANAGED_PYTHON_SENTINEL,
    version: version ?? 'created on save',
  }
}

function spawnCli(
  command: string,
  args: readonly string[],
  options: {
    timeout?: number
    env?: NodeJS.ProcessEnv
  } = {},
): SpawnSyncReturns<string> {
  const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command)
  return spawnSync(
    windowsScript ? `"${command.replace(/"/gu, '')}"` : command,
    [...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeout,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(windowsScript ? { shell: true } : {}),
    },
  )
}

function runCreate(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  what: string,
  timeoutMs = 120_000,
): void {
  const result = spawnCli(command, args, { timeout: timeoutMs, env })
  if (result.error !== undefined) {
    throw new Error(`AutoReport managed venv: ${what} failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${String(result.status)}`
    throw new Error(`AutoReport managed venv: ${what} failed: ${detail}`)
  }
}

/**
 * Whether a typed path is an existing runnable Python. Detected executables
 * skip this: they already ran `--version` during discovery.
 * @param path - user-typed interpreter path.
 * @returns undefined when the path is a runnable interpreter; otherwise why not.
 */
export function invalidCustomPythonPath(path: string): string | undefined {
  const trimmed = path.trim()
  if (trimmed.length === 0) return undefined
  if (!isAbsolute(trimmed)) return 'Python path must be absolute.'
  const resolved = canonicalize(trimmed)
  if (resolved === undefined || !isFile(resolved)) {
    return `Python executable does not exist: ${trimmed}`
  }
  if (pythonVersion(resolved) === undefined) {
    return `${resolved} is not a runnable Python interpreter`
  }
  return undefined
}

/**
 * Parent directory of an absolute interpreter, used as PATH prepend.
 * Bare commands such as `python3` have no bin dir.
 * @param executable - interpreter path or command name.
 * @returns the directory to prepend, when the path has a directory component.
 */
export function pythonBinDir(executable: string): string | undefined {
  if (!executable.includes('/') && !executable.includes('\\')) return undefined
  return dirname(executable)
}

/**
 * First line of `python --version`, or undefined when the file is not Python.
 * @param executable - absolute interpreter path.
 * @returns version text, or undefined when the process failed.
 */
export function pythonVersion(executable: string): string | undefined {
  try {
    const result = spawnCli(executable, ['--version'], { timeout: 3_000 })
    if (result.error !== undefined) return undefined
    const text = firstLine(result.stdout) || firstLine(result.stderr)
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

function pythonInPrefix(prefix: string): string {
  if (process.platform === 'win32') {
    const scripts = join(prefix, 'Scripts')
    for (const name of ['python.exe', 'python.cmd', 'python3.exe', 'python3.cmd']) {
      const candidate = join(scripts, name)
      if (isFile(candidate)) return candidate
    }
    return join(scripts, 'python.exe')
  }
  const python = join(prefix, 'bin', 'python')
  return isFile(python) ? python : join(prefix, 'bin', 'python3')
}

function addCondaInstall(root: string, add: (path: string, source: string, label: string) => void): void {
  if (!existsSync(root)) return
  add(pythonInPrefix(root), 'conda', condaLabel(root))
  addCondaChildren(join(root, 'envs'), add)
}

function addPyenvChildren(root: string, add: (path: string, source: string, label: string) => void): void {
  for (const name of listDirs(root)) {
    add(pythonInPrefix(join(root, name)), 'pyenv', `pyenv · ${name}`)
  }
}

function addCondaChildren(root: string, add: (path: string, source: string, label: string) => void): void {
  for (const name of listDirs(root)) {
    add(pythonInPrefix(join(root, name)), 'conda', `Conda · ${name}`)
  }
}

function addCondaCliEnvs(env: NodeJS.ProcessEnv, add: (path: string, source: string, label: string) => void): void {
  for (const command of ['conda', 'mamba', 'micromamba']) {
    const found = whichCommand(command, env)
    if (found === undefined) continue
    try {
      const result = spawnCli(found, ['env', 'list', '--json'], { timeout: 2_000, env })
      if (result.error !== undefined || result.status !== 0) continue
      const parsed: unknown = JSON.parse(result.stdout)
      const envs = condaEnvList(parsed)
      if (envs === undefined) continue
      for (const prefix of envs) add(pythonInPrefix(prefix), 'conda', condaLabel(prefix))
      return
    } catch {
      continue
    }
  }
}

function condaEnvList(parsed: unknown): readonly string[] | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const envs = (parsed as { envs?: unknown }).envs
  if (!Array.isArray(envs)) return undefined
  return envs.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function condaLabel(prefix: string): string {
  const normalized = prefix.replace(/\\/gu, '/')
  const envMatch = /\/envs\/([^/]+)\/?$/u.exec(normalized)
  if (envMatch?.[1] !== undefined) return `Conda · ${envMatch[1]}`
  return `Conda · ${basename(prefix)}`
}

function whichCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathEnv = env.PATH ?? env.Path
  if (pathEnv === undefined || pathEnv.length === 0) return undefined
  const sep = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathEnv.split(sep)) {
    if (dir.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function canonicalize(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return existsSync(path) ? path : undefined
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function firstLine(text: string | null | undefined): string {
  if (text === undefined || text === null) return ''
  return text.split(/\r?\n/u)[0]?.trim() ?? ''
}

function tryHomedir(): string | undefined {
  try {
    const home = homedir()
    return home.length > 0 ? home : undefined
  } catch {
    return undefined
  }
}
