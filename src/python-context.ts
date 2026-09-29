/**
 * Dynamic Python-environment context on every AutoReport session (MAIN and
 * specialists): what interpreter is selected, where it came from, and how
 * MAIN manages packages through the approval-gated tool. Registered as a `systemPrompt.context()`,
 * so the DSH agent loop materializes it as a durable user-role snapshot that
 * is appended ONLY when the rendered text changes — the host owns the
 * "compare with the last snapshot, append on difference" choreography, and
 * the history keeps every past snapshot, letting the model see when the
 * environment changed mid-conversation.
 *
 * Rendering must be deterministic per environment state: the same selection
 * always renders byte-identical text so unchanged environments never append.
 * @module autoreport-python-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isManagedPythonSetting, managedPythonExecutable, pythonVersion } from './python-detect.js'

/** Session ownership and frozen workflow settings for Python context resolution. */
export interface AutoReportPythonContextDeps {
  ownsSession(session: Session): boolean
  /** Frozen workflow snapshot python, or undefined when unset or not yet snapshotted. */
  snapshotPythonExecutable(session: Session): string | undefined
}

/** Structural subset of the assemble context the renderer reads. */
interface PythonAssembleContext {
  agent?: { session?: Session }
}

/**
 * Point MAIN at the dedicated environment capability instead of exposing
 * package-manager commands in the prompt.
 * @returns the environment-tool guidance line.
 */
export function packageManagerGuidance(): string {
  return 'Use python_environment(action=inspect|list) to review this environment; use python_environment(action=install, packages=[...]) for approved package changes.'
}

/**
 * `python --version` results per canonical executable, cached for the process
 * lifetime. The context renders on every pre-step assembly, so an uncached
 * spawn per render would put a subprocess on each model step; a Python
 * interpreter's version never changes for a given path, so the cache keeps
 * rendering deterministic AND cheap.
 */
const versionCache = new Map<string, string | undefined>()

/** Cached {@link pythonVersion} lookup keyed by the executable path. */
function cachedPythonVersion(executable: string): string | undefined {
  if (!versionCache.has(executable)) versionCache.set(executable, pythonVersion(executable))
  return versionCache.get(executable)
}

/**
 * Render the environment context block. Deterministic per environment state:
 * unchanged inputs render byte-identical text, so the host snapshot diff
 * never appends.
 * @param executable - resolved interpreter path (empty when nothing is known).
 * @param sourceLabel - human-facing source line, or undefined for the fallback.
 * @returns the context text, or '' when nothing is known (contributes nothing).
 */
export function renderPythonContext(executable: string, sourceLabel: string | undefined): string {
  if (executable.length === 0) return ''
  const version = cachedPythonVersion(executable)
  const lines = [
    '# Python environment',
    `selected: ${executable}${version === undefined ? '' : ` (${version})`}`,
    ...(sourceLabel === undefined ? [] : [`source: ${sourceLabel}`]),
    `Role-aware process tools resolve \`python\`/\`python3\` to this interpreter — never activate it or pass an explicit interpreter path unless targeting another environment`,
    packageManagerGuidance(),
    'Only MAIN may install or change packages; specialists report `missing_dependency` through `report_workflow` instead.',
  ]
  return lines.join('\n')
}

/**
 * Install the AutoReport Python-environment context contribution.
 * @param ctx - preset or host context with the `systemPrompt` service.
 * @param deps - session ownership and frozen workflow python resolution.
 * @returns disposer removing the contribution; no-op when the service is absent.
 */
export function installAutoReportPythonContext(
  ctx: Context,
  deps: AutoReportPythonContextDeps,
): () => void {
  const systemPrompt = ctx.get('systemPrompt') as
    | {
        getContextOrder(name: string): number
        context(entry: { name: string; order: number; text: (assemble: unknown) => string }): () => void
      }
    | undefined
  if (systemPrompt === undefined) return () => {}
  return systemPrompt.context({
    name: 'autoreport:python-environment',
    order: systemPrompt.getContextOrder('SANDBOX_POLICY'),
    text: (assemble) => {
      const session = (assemble as PythonAssembleContext).agent?.session
      if (session === undefined || !deps.ownsSession(session)) return ''
      const executable = resolvePythonExecutable(deps, session)
      if (executable === undefined) return ''
      return renderPythonContext(executable, sourceLabel(deps, session, executable))
    },
  })
}

function resolvePythonExecutable(deps: AutoReportPythonContextDeps, session: Session): string | undefined {
  const fromSnapshot = deps.snapshotPythonExecutable(session)
  const setting = fromSnapshot !== undefined && fromSnapshot.length > 0
    ? fromSnapshot
    : process.env.DSH_AUTOREPORT_PYTHON
  if (setting === undefined || setting.length === 0) return undefined
  return isManagedPythonSetting(setting) ? managedPythonExecutable(resolveDshHome()) : setting
}

function sourceLabel(deps: AutoReportPythonContextDeps, session: Session, executable: string): string | undefined {
  const fromSnapshot = deps.snapshotPythonExecutable(session)
  if (fromSnapshot !== undefined && fromSnapshot.length > 0) {
    return isManagedPythonSetting(fromSnapshot) ? 'AutoReport managed venv' : 'workflow settings snapshot'
  }
  if (process.env.DSH_AUTOREPORT_PYTHON !== undefined) return 'deployment environment'
  return executable === 'python3' ? undefined : 'workspace .venv detection'
}
