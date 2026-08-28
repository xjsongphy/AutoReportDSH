/**
 * Registers `DSH_AUTOREPORT_PYTHON` and `DSH_AUTOREPORT_PYTHON_BIN` through the
 * DSH shell-env registry, and prepends that interpreter's bin directory to
 * PATH on owned bash/pwsh calls so `python` / `python3` resolve to the selected
 * environment without requiring the agent to type the `$DSH_*` names.
 * @module autoreportdsh-python-env
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isManagedPythonSetting, managedPythonExecutable, pythonBinDir } from './python-detect.js'

/** Session ownership and frozen workflow settings for Python shell-env resolution. */
export interface AutoReportPythonEnvDeps {
  ownsSession(session: Session): boolean
  /** Frozen workflow snapshot python, or undefined when unset or not yet snapshotted. */
  snapshotPythonExecutable(session: Session): string | undefined
}

/** Ordinary env plus trusted dshEnv as bash/pwsh pass them to `ctx.shell.resolve`. */
export interface PythonPathRequest {
  env?: Record<string, string>
  dshEnv?: Record<string, string>
}

/**
 * Install the AutoReport Python shell-environment contributor and PATH overlay.
 * @param ctx - preset or host context with optional `shellEnv` / `shell` services.
 * @param deps - session ownership and frozen workflow python resolution.
 * @returns disposer removing both contributions; no-op pieces when services are absent.
 */
export function installAutoReportPythonEnv(
  ctx: Context,
  deps: AutoReportPythonEnvDeps,
): () => void {
  const disposeEnv = installPythonShellFacts(ctx, deps)
  const disposePath = installPythonPathOverlay(ctx)
  return () => {
    disposePath()
    disposeEnv()
  }
}

/**
 * Prepend `DSH_AUTOREPORT_PYTHON_BIN` to PATH (and set VIRTUAL_ENV for
 * `.../bin` layouts) so a `python3` the agent types still hits the selected env.
 * Trusted `dshEnv` is collected before `ctx.shell.resolve`, so the overlay
 * can read it off the request.
 * @param request - shell request about to be resolved.
 * @returns the same request, or a copy with PATH rewritten.
 */
export function overlayPythonPath<T extends PythonPathRequest>(request: T): T {
  const bin = request.dshEnv?.DSH_AUTOREPORT_PYTHON_BIN
  if (bin === undefined || bin.length === 0) return request
  const sep = process.platform === 'win32' ? ';' : ':'
  const inherited = request.env?.PATH ?? process.env.PATH ?? ''
  const path = inherited.length > 0 ? `${bin}${sep}${inherited}` : bin
  const env: Record<string, string> = { ...request.env, PATH: path }
  if (/(?:^|[/\\])bin$/u.test(bin) || /(?:^|[/\\])Scripts$/u.test(bin)) {
    env.VIRTUAL_ENV = dirname(bin)
  }
  return { ...request, env }
}

function installPythonShellFacts(ctx: Context, deps: AutoReportPythonEnvDeps): () => void {
  if (ctx.get('shellEnv') === undefined) return () => {}

  return ctx.shellEnv.register({
    name: 'autoreport-python',
    variables: {
      DSH_AUTOREPORT_PYTHON: {
        description: 'Absolute path to the Python interpreter AutoReport subagents should use in bash.',
      },
      DSH_AUTOREPORT_PYTHON_BIN: {
        description: 'Directory containing the selected Python interpreter; prepended to PATH on owned bash.',
      },
    },
    resolve(execution: ToolExecution) {
      const session = execution.agent?.session
      if (session === undefined) return {}
      if (!deps.ownsSession(session)) return {}

      const executable = resolvePythonExecutable(deps, session)
      const binDir = pythonBinDir(executable)
      return {
        DSH_AUTOREPORT_PYTHON: executable,
        ...(binDir === undefined ? {} : { DSH_AUTOREPORT_PYTHON_BIN: binDir }),
      }
    },
  })
}

function installPythonPathOverlay(ctx: Context): () => void {
  if (typeof ctx.inject !== 'function') {
    return wrapShellResolve(ctx.get('shell') as { resolve: (request: PythonPathRequest) => unknown } | undefined)
  }
  ctx.inject(['shell'], (scope) => wrapShellResolve(
    scope.get('shell') as { resolve: (request: PythonPathRequest) => unknown } | undefined,
  ))
  return () => {}
}

function wrapShellResolve(
  shell: { resolve: (request: PythonPathRequest) => unknown } | undefined,
): () => void {
  if (shell === undefined) return () => {}
  const original = shell.resolve.bind(shell)
  shell.resolve = (request: PythonPathRequest) => original(overlayPythonPath(request))
  return () => {
    shell.resolve = original
  }
}

function resolvePythonExecutable(deps: AutoReportPythonEnvDeps, session: Session): string {
  const fromSnapshot = deps.snapshotPythonExecutable(session)
  if (fromSnapshot !== undefined && fromSnapshot.length > 0) {
    return isManagedPythonSetting(fromSnapshot)
      ? managedPythonExecutable(resolveDshHome())
      : fromSnapshot
  }

  const fromEnv = process.env.DSH_AUTOREPORT_PYTHON
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv

  const cwd = session.header.cwd
  if (cwd !== undefined) {
    for (const candidate of [
      join(cwd, '.venv/bin/python'),
      join(cwd, '.venv/bin/python3'),
      join(cwd, '.venv/Scripts/python.exe'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }

  return 'python3'
}
