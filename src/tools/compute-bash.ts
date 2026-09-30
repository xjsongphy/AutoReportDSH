/** Compute-role bash without the generic tool's unavailable escalation path. */
import { realpathSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { roleWritableRoot } from '../policy/sandbox-roots.js'
import type { SpecialistRole } from '../roles.js'
import { existingWorkspacePath } from '../workspace/path.js'
import { genericCall } from './presentation.js'

/** Install the full foreground shell capability only for Data and Plotting. */
export function installComputeBashTool(ctx: Context, role: SpecialistRole, workspaceRootOverride?: string): () => void {
  if (role !== 'DATA_ANALYSIS' && role !== 'PLOTTING') throw new Error(`${role} has no compute shell capability`)
  // This installer runs from a child scope that checks service availability
  // with `get()`, but does not inject the `shell` property. Cordis throws when
  // an uninjected service is read as `ctx.shell`; resolve both services through
  // the same scope-aware lookup used by the router instead.
  const shell = ctx.get('shell') as typeof ctx.shell | undefined
  if (shell === undefined || shell.sandboxMode === undefined) {
    throw new Error('AutoReport compute bash requires a sandboxing DSH shell executor')
  }
  const shellEnv = ctx.get('shellEnv') as typeof ctx.shellEnv | undefined
  if (shellEnv === undefined) throw new Error('AutoReport compute bash requires the DSH shell environment service')
  return ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Run a foreground bash command for data analysis or plotting. Each call has a fresh shell. Check exitCode and stderr; if sandbox denies an operation or a dependency is missing, report the blocker to MAIN. Writes are confined to your role directory. This tool has no sandbox escalation or background mode.',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command to run.' },
      description: { type: 'string', required: true, description: 'Short purpose of this command.' },
      workdir: { type: 'string', description: 'Existing directory relative to the experiment workspace; defaults to the workspace root.' },
      timeoutMs: { type: 'number', description: 'Optional command timeout in milliseconds.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => genericCall('Run bash', args.description),
    async execute(args, exec) {
      const session = exec.agent?.session
      const workspace = workspaceRootOverride ?? session?.header.cwd
      if (session === undefined || workspace === undefined) throw new Error('bash requires a workspace-bound compute session')
      if (args.command.trim().length === 0 || args.description.trim().length === 0) {
        throw new Error('bash command and description must be non-empty')
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error('timeoutMs must be positive')
      }
      const workdir = args.workdir === undefined ? realpathSync(workspace) : existingWorkspacePath(workspace, args.workdir).absolute
      if (!statSync(workdir).isDirectory()) throw new Error('bash workdir must be a directory')
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const sandbox = ctx.get('sandbox')
      if (sandboxPolicy === undefined || sandbox === undefined) {
        throw new Error('bash requires DSH sandbox and sandbox policy services')
      }
      const policy = sandboxPolicy.resolve({ session })
      const expectedRoot = roleWritableRoot(workspace, role)
      if (policy.mode !== 'workspace-write' || canonicalPath(policy.workspaceRoot) !== canonicalPath(expectedRoot)) {
        throw new Error(`bash requires the ${role} workspace-write sandbox root`)
      }
      // Refuse a backend that cannot enforce the promised write boundary
      // before running the model's command.
      const probe = await sandbox.confine(
        ['bash', '-c', 'true'],
        { ...policy, mode: 'workspace-write' },
        exec.signal,
      )
      if (probe.enforcement !== 'full') throw new Error('bash requires full DSH file-sandbox enforcement')
      const request = {
        command: args.command,
        workdir,
        dshEnv: shellEnv.collect(exec),
        sandboxPolicy: policy,
        signal: exec.signal,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }
      const result = await shell.run(shell.resolve(request))
      if (result.aborted) throw new Error('bash call was aborted')
      if (result.sandbox?.enforcement !== 'full') throw new Error('bash lost full DSH file-sandbox enforcement')
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        sandbox: { enforcement: result.sandbox?.enforcement ?? 'unknown' },
      }
    },
  }))
}
