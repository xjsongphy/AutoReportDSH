/** Main-only, approval-backed installation into the selected Python environment. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import { resolvePythonExecutable } from '../python-env.js'
import { isManagedPythonSetting } from '../python-detect.js'
import type AutoReportWorkflowRuntime from '../runtime.js'
import { genericCall } from './presentation.js'
import { packageInstallArgv, validPackageRequirement } from './python-package-requirement.js'

const INSTALL_TIMEOUT_MS = 300_000

export function installPythonPackageTool(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'install_python_package',
    description: 'Install one named Python package into the selected environment after user approval. Use when a specialist reports a missing dependency.',
    parameters: { package: { type: 'string', required: true, description: 'One package requirement, e.g. pandas or scipy==1.14.1. No flags or URLs.' } },
    timeoutMs: INSTALL_TIMEOUT_MS + 20_000,
    presentCall: args => genericCall('Install Python package', args.package),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent as Agent | undefined
      if (agent?.session === undefined) throw new Error('install_python_package requires a MAIN session')
      if (!validPackageRequirement(args.package)) throw new Error('package must be one named requirement without flags, paths, or URLs')
      const workflow = ctx.get('autoreportWorkflow') as AutoReportWorkflowRuntime | undefined
      if (workflow === undefined) throw new Error('install_python_package requires AutoReport workflow state')
      const python = resolvePythonExecutable({
        ownsSession: () => true,
        snapshotPythonExecutable: session => workflow.projectionFor(String(session.id))?.meta?.settings?.pythonExecutable,
      }, agent.session)
      const selected = workflow.projectionFor(String(agent.session.id))?.meta?.settings?.pythonExecutable
      const managed = selected !== undefined && isManagedPythonSetting(selected)
      const approver = ctx.get('approval') as { request: (request: { agent: Agent; toolName: string; callId: typeof exec.callId; reason: string; signal: AbortSignal }) => Promise<string> } | undefined
      if (approver === undefined) throw new Error('package installation requires a user approval channel')
      const decision = await approver.request({
        agent,
        toolName: 'install_python_package',
        callId: exec.callId,
        reason: `Install ${args.package} into Python environment ${python}`,
        signal: exec.signal,
      })
      if (decision !== 'allowed-once') throw new Error(`package installation ${decision}`)
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('package installation needs DSH subprocess')
      const deadline = AbortSignal.timeout(INSTALL_TIMEOUT_MS)
      const handle = subprocess.spawn({
        argv: packageInstallArgv(python, args.package, managed),
        cwd: workflow.config.workspaceRoot ?? agent.session.header.cwd ?? process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32_000 }, stderr: { maxBytes: 32_000 } },
        graceMs: 5_000,
        signal: AbortSignal.any([exec.signal, deadline]),
      })
      const outcome = await handle.done
      return {
        status: deadline.aborted ? 'timeout' : outcome.exitCode === 0 ? 'success' : 'failed',
        exitCode: outcome.exitCode,
        python,
        diagnostics: [handle.collected.stdout?.readFrom(0).text, handle.collected.stderr?.readFrom(0).text]
          .filter(Boolean).join('\n').slice(0, 32_000),
      }
    },
  }))
}
