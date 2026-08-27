/**
 * Registers `DSH_AUTOREPORT_PYTHON` and `DSH_AUTOREPORT_PYTHON_BIN` through the
 * DSH shell-env registry so specialist bash calls can invoke a consistent
 * interpreter without hardcoding `python3`.
 * @module autoreportdsh-python-env
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Session ownership and frozen workflow settings for Python shell-env resolution. */
export interface AutoReportPythonEnvDeps {
  ownsSession(session: Session): boolean
  /** Frozen workflow snapshot python, or undefined when this session has no snapshot. */
  snapshotPythonExecutable(session: Session): string | undefined
  /** Whether a durable workflow snapshot exists (initialized), even when python is unset. */
  hasWorkflowSnapshot(session: Session): boolean
  /** Compatibility fallback used ONLY when no workflow snapshot exists yet. */
  fallbackPythonExecutable(): string | undefined
}

/**
 * Install the AutoReport Python shell-environment contributor.
 * @param ctx - preset or host context with optional `shellEnv` service.
 * @param deps - session ownership and frozen workflow python resolution.
 * @returns disposer removing the contributor; no-op when `shellEnv` is absent.
 */
export function installAutoReportPythonEnv(
  ctx: Context,
  deps: AutoReportPythonEnvDeps,
): () => void {
  if (ctx.get('shellEnv') === undefined) return () => {}

  return ctx.shellEnv.register({
    name: 'autoreport-python',
    variables: {
      DSH_AUTOREPORT_PYTHON: {
        description: 'Absolute path to the Python interpreter AutoReport specialists should use in bash.',
      },
      DSH_AUTOREPORT_PYTHON_BIN: {
        description: 'Directory containing the Python interpreter when the path ends in /bin/python.',
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

function resolvePythonExecutable(deps: AutoReportPythonEnvDeps, session: Session): string {
  const fromSnapshot = deps.snapshotPythonExecutable(session)
  if (fromSnapshot !== undefined && fromSnapshot.length > 0) return fromSnapshot

  if (!deps.hasWorkflowSnapshot(session)) {
    const fromFallback = deps.fallbackPythonExecutable()
    if (fromFallback !== undefined && fromFallback.length > 0) return fromFallback
  }

  const fromEnv = process.env.DSH_AUTOREPORT_PYTHON
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv

  const cwd = session.header.cwd
  if (cwd !== undefined) {
    for (const candidate of [join(cwd, '.venv/bin/python'), join(cwd, '.venv/bin/python3')]) {
      if (existsSync(candidate)) return candidate
    }
  }

  return 'python3'
}

/** Parent directory of `.../bin/python` style executables; absent for bare `python3`. */
function pythonBinDir(executable: string): string | undefined {
  if (/[/\\]bin[/\\]python\d*$/u.test(executable)) return dirname(executable)
  return undefined
}
