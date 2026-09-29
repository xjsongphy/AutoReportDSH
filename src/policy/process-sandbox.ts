/** Role-aware OS filesystem views for the foreground shell delegated to DSH. */
import { existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rolePolicy, type AutoReportRole } from '../roles.js'

const SEATBELT_SYSTEM_ROOTS = ['/System', '/bin', '/sbin', '/usr', '/Library/Frameworks', '/Library/Developer', '/Library/Fonts', '/Library/TeX', '/opt/homebrew', '/usr/local']
const NULL_DEVICE = '/dev/null'

function canonicalExisting(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function contained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function sbplQuote(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

function ensureExistingWorkspaceRoots(workspaceRoot: string, role: AutoReportRole): Array<{ relative: string; absolute: string }> {
  const policy = rolePolicy(role)
  const roots = new Map<string, string>()
  for (const relativeRoot of [...policy.readableRoots, ...policy.writableRoots]) {
    const lexical = resolve(workspaceRoot, relativeRoot === '.' ? '' : relativeRoot)
    const absolute = canonicalExisting(lexical)
    // Missing read roots contribute no files yet. A missing writable root is a
    // workspace initialization failure; fail closed instead of creating it.
    if (absolute === undefined) {
      if (policy.writableRoots.includes(relativeRoot)) {
        throw new Error(`AutoReport ${role} process sandbox cannot find writable root ${relativeRoot}; run /init`)
      }
      continue
    }
    if (!contained(workspaceRoot, absolute) || !contained(lexical, absolute)) {
      throw new Error(`AutoReport ${role} process sandbox root ${relativeRoot} resolves outside its declared workspace subtree`)
    }
    roots.set(relativeRoot, absolute)
  }
  return [...roots].map(([relative, absolute]) => ({ relative, absolute }))
}

function canonicalWorkdir(workspaceRoot: string, role: AutoReportRole, cwd: string): string {
  const target = canonicalExisting(cwd)
  if (target === undefined || !contained(workspaceRoot, target)) {
    throw new Error(`AutoReport ${role} process working directory is outside the experiment workspace`)
  }
  const roots = [...rolePolicy(role).readableRoots, ...rolePolicy(role).writableRoots]
    .map(root => canonicalExisting(resolve(workspaceRoot, root === '.' ? '' : root)))
    .filter((root): root is string => root !== undefined)
  if (!roots.some(root => contained(root, target))) {
    throw new Error(`AutoReport ${role} process working directory is outside its role roots`)
  }
  return target
}

function selectedPythonPrefix(dshEnv: Readonly<Record<string, string>>): string | undefined {
  const executable = dshEnv['DSH_AUTOREPORT_PYTHON']
  const bin = dshEnv['DSH_AUTOREPORT_PYTHON_BIN']
  const executableDirectory = executable !== undefined && isAbsolute(executable)
    ? canonicalExisting(dirname(executable))
    : bin !== undefined && isAbsolute(bin)
      ? canonicalExisting(bin)
      : undefined
  if (executableDirectory === undefined) return undefined
  // Expose the environment prefix, not just its `bin` directory: virtualenv
  // interpreters need pyvenv.cfg, the standard library, and site-packages too.
  const directoryName = basename(executableDirectory).toLowerCase()
  const prefix = directoryName === 'bin' || directoryName === 'scripts'
    ? dirname(executableDirectory)
    : executableDirectory
  return canonicalExisting(prefix)
}

function maskedUserRoots(workspaceRoot: string): string[] {
  const candidates = process.platform === 'darwin'
    ? ['/Users', '/Volumes', '/private/var/folders']
    : ['/home', '/root', '/mnt', '/media', '/run/user']
  const home = canonicalExisting(process.env['HOME'] ?? '')
  const workspaceParent = dirname(workspaceRoot)
  const systemRoots = process.platform === 'darwin'
    ? ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/opt', '/private/etc', '/private/tmp', '/tmp']
    : ['/bin', '/etc', '/lib', '/lib64', '/opt', '/sbin', '/usr', '/var', '/tmp']
  const maskWorkspaceParent = workspaceParent !== '/' && !systemRoots.some(path => contained(path, workspaceParent))
  const paths = [...new Set([
    ...candidates,
    ...(home === undefined ? [] : [home]),
    ...(maskWorkspaceParent ? [workspaceParent] : []),
  ])]
    .filter(path => existsSync(path))
  return paths.filter(path => !paths.some(parent => parent !== path && contained(parent, path)))
}

function externalReadPaths(
  role: AutoReportRole,
  workspaceRoot: string,
  dshEnv: Readonly<Record<string, string>>,
): string[] {
  const paths = new Set<string>()
  const pythonPrefix = selectedPythonPrefix(dshEnv)
  if (pythonPrefix !== undefined) {
    const inWorkspace = contained(workspaceRoot, pythonPrefix)
    const allowedRoots = [...rolePolicy(role).readableRoots, ...rolePolicy(role).writableRoots]
      .map(root => resolve(workspaceRoot, root === '.' ? '' : root))
    if (inWorkspace && !allowedRoots.some(root => contained(root, pythonPrefix))) {
      throw new Error(`AutoReport ${role} selected Python environment is inside an unreadable workspace subtree`)
    }
    paths.add(pythonPrefix)
  }
  const home = canonicalExisting(process.env['HOME'] ?? '')
  if (home !== undefined) {
    const fontDirectories = process.platform === 'darwin'
      ? [resolve(home, 'Library/Fonts'), resolve(home, '.fonts')]
      : [resolve(home, '.fonts'), resolve(home, '.local/share/fonts')]
    for (const directory of fontDirectories) {
      const fontRoot = canonicalExisting(directory)
      if (fontRoot !== undefined && !contained(workspaceRoot, fontRoot)) paths.add(fontRoot)
    }
  }
  return [...paths]
}

function pathComponentsToCreate(root: string, target: string): string[] {
  if (!contained(root, target) || root === target) return []
  const rel = relative(root, target)
  const parts = rel.split(sep).filter(Boolean)
  const output: string[] = []
  let cursor = root
  for (const part of parts) {
    cursor = resolve(cursor, part)
    output.push(cursor)
  }
  return output
}

function bwrapCommand(role: AutoReportRole, workspaceRoot: string, cwd: string, command: string, dshEnv: Readonly<Record<string, string>>): string {
  const executable = (process.env['PATH'] ?? '').split(delimiter)
    .map(directory => resolve(directory, 'bwrap'))
    .find(path => existsSync(path))
  if (executable === undefined) throw new Error('AutoReport role-aware process sandbox requires bubblewrap (bwrap); process execution is disabled')

  const policy = rolePolicy(role)
  const root = canonicalExisting(workspaceRoot)
  if (root === undefined) throw new Error('AutoReport process sandbox cannot resolve the experiment workspace')
  const workingDirectory = canonicalWorkdir(root, role, cwd)
  const roots = ensureExistingWorkspaceRoots(root, role)
  const alias = `/tmp/__autoreport_scope_${randomUUID()}`
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/__autoreport-home',
    '--dir', '/tmp/__autoreport-cache',
    '--dir', '/tmp/__autoreport-texmf-var',
    '--dir', '/tmp/__autoreport-texmf-cache',
    '--die-with-parent',
    '--unshare-pid',
    '--dir', alias,
  ]
  for (let index = 0; index < roots.length; index += 1) {
    const entry = roots[index]
    if (entry === undefined) continue
    const sourceAlias = `${alias}/root-${index}`
    args.push('--dir', sourceAlias)
    args.push(policy.writableRoots.includes(entry.relative) ? '--bind' : '--ro-bind', entry.absolute, sourceAlias)
  }
  const maskedHomes = maskedUserRoots(root)
  const maskedRoots = [...new Set([...maskedHomes, '/tmp'])]
  const externalReads = externalReadPaths(role, root, dshEnv)
  externalReads.forEach((path, index) => {
    const sourceAlias = `${alias}/external-${index}`
    args.push('--dir', sourceAlias, '--ro-bind', path, sourceAlias)
  })

  for (const home of maskedHomes) args.push('--tmpfs', home)

  const createDirs = new Set<string>()
  for (const home of maskedRoots) {
    if (contained(home, root)) for (const path of pathComponentsToCreate(home, root)) createDirs.add(path)
    for (const external of externalReads) {
      if (contained(home, external)) for (const path of pathComponentsToCreate(home, external)) createDirs.add(path)
    }
  }
  for (const path of [...createDirs].sort((a, b) => a.length - b.length)) args.push('--dir', path)
  args.push('--tmpfs', root)

  const createRootDirs = new Set<string>()
  for (const entry of roots) {
    for (const path of pathComponentsToCreate(root, resolve(root, entry.relative === '.' ? '' : entry.relative))) {
      createRootDirs.add(path)
    }
  }
  for (const external of externalReads) {
    if (contained(root, external)) {
      for (const path of pathComponentsToCreate(root, external)) createRootDirs.add(path)
    }
  }
  for (const path of [...createRootDirs].sort((a, b) => a.length - b.length)) args.push('--dir', path)
  for (let index = 0; index < roots.length; index += 1) {
    const entry = roots[index]
    if (entry === undefined) continue
    args.push(policy.writableRoots.includes(entry.relative) ? '--bind' : '--ro-bind', `${alias}/root-${index}`, resolve(root, entry.relative === '.' ? '' : entry.relative))
  }
  for (let index = 0; index < externalReads.length; index += 1) {
    const path = externalReads[index]
    if (path === undefined) continue
    args.push('--ro-bind', `${alias}/external-${index}`, path)
  }
  // Hide the source aliases after mounting only the role-authorized subtrees.
  args.push('--tmpfs', alias)
  args.push(
    '--chdir', workingDirectory,
    '--setenv', 'HOME', '/tmp/__autoreport-home',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'XDG_CACHE_HOME', '/tmp/__autoreport-cache',
    '--setenv', 'TEXMFVAR', '/tmp/__autoreport-texmf-var',
    '--setenv', 'TEXMFCACHE', '/tmp/__autoreport-texmf-cache',
    '--', '/bin/bash', '-c', command,
  )
  return `exec ${[executable, ...args].map(shellQuote).join(' ')}`
}

function seatbeltCommand(role: AutoReportRole, workspaceRoot: string, cwd: string, command: string, dshEnv: Readonly<Record<string, string>>): string {
  const executable = '/usr/bin/sandbox-exec'
  if (!existsSync(executable)) throw new Error('AutoReport role-aware process sandbox requires macOS sandbox-exec; process execution is disabled')
  const policy = rolePolicy(role)
  const root = canonicalExisting(workspaceRoot)
  if (root === undefined) throw new Error('AutoReport process sandbox cannot resolve the experiment workspace')
  const workingDirectory = canonicalWorkdir(root, role, cwd)
  const roots = ensureExistingWorkspaceRoots(root, role)
  const forms = ['(version 1)', '(allow default)', '(deny file-read*)']
  const allowedReads = new Set([
    ...SEATBELT_SYSTEM_ROOTS,
    '/tmp',
    '/private/tmp',
    ...roots.map(entry => entry.absolute),
    ...externalReadPaths(role, root, dshEnv),
  ])
  for (const path of allowedReads) {
    if (existsSync(path)) forms.push(`(allow file-read* (subpath ${sbplQuote(path)}))`)
  }
  forms.push('(deny file-write*)')
  forms.push(`(allow file-write* (subpath ${sbplQuote('/tmp')}) (subpath ${sbplQuote('/private/tmp')}) (literal ${sbplQuote(NULL_DEVICE)}))`)
  for (const relativeRoot of policy.writableRoots) {
    const target = canonicalExisting(resolve(root, relativeRoot === '.' ? '' : relativeRoot))
    if (target !== undefined) forms.push(`(allow file-write* (subpath ${sbplQuote(target)}))`)
  }
  // Access to cwd metadata is needed even when the role's cwd sits at the root
  // of multiple mounted subtrees.
  forms.push(`(allow file-read-metadata (literal ${sbplQuote(workingDirectory)}))`)
  const profile = forms.join(' ')
  const nestedCommand = `export HOME=/tmp/__autoreport-home TMPDIR=/tmp XDG_CACHE_HOME=/tmp/__autoreport-cache TEXMFVAR=/tmp/__autoreport-texmf-var TEXMFCACHE=/tmp/__autoreport-texmf-cache && mkdir -p "$HOME" "$XDG_CACHE_HOME" "$TEXMFVAR" "$TEXMFCACHE" && cd ${shellQuote(workingDirectory)} && ${command}`
  return `exec ${[executable, '-p', profile, '--', '/bin/bash', '-c', nestedCommand].map(shellQuote).join(' ')}`
}

/** Wrap user Bash with an OS profile that exposes only role-readable roots. */
export function roleProcessCommand(
  role: AutoReportRole,
  workspaceRoot: string,
  cwd: string,
  command: string,
  dshEnv: Readonly<Record<string, string>> = {},
): string {
  if (process.platform === 'linux') return bwrapCommand(role, workspaceRoot, cwd, command, dshEnv)
  if (process.platform === 'darwin') return seatbeltCommand(role, workspaceRoot, cwd, command, dshEnv)
  throw new Error(`AutoReport role-aware process execution is not supported on ${process.platform}`)
}
