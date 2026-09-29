/** Purpose-specific MAIN capability for inspecting and managing its selected Python environment. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_PACKAGES = 20
const MAX_STDOUT = 256 * 1024
const MAX_STDERR = 64 * 1024
const PROCESS_GRACE_MS = 2_000

interface ShellEnvironment {
  collect(execution: ToolExecution): Readonly<Record<string, string>>
}

interface ApprovalService {
  request(input: {
    agent: Agent
    toolName: string
    callId?: ToolExecution['callId']
    reason: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

interface PythonEnvironmentResult {
  readonly action: string
  readonly status: string
  readonly python: string
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  readonly packages?: string[]
}

function validatePackages(packages: unknown): string[] {
  if (!Array.isArray(packages) || packages.length === 0 || packages.length > MAX_PACKAGES) {
    throw new Error(`packages must contain 1–${MAX_PACKAGES} package names`)
  }
  return packages.map((value, index) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\[[A-Za-z0-9._,-]{1,128}\])?(?:\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+(?:,\s*(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]+)*)?$/u.test(value)) {
      throw new Error(`packages[${index}] must be a package requirement, not a URL, path, or installer option`)
    }
    return value
  })
}

async function run(
  subprocess: SubprocessRuntime,
  executable: string,
  args: readonly string[],
  execution: ToolExecution,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  execution.signal.throwIfAborted()
  const spec: SubprocessSpawnSpec = {
    argv: [executable, ...args],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_STDOUT }, stderr: { maxBytes: MAX_STDERR } },
    graceMs: PROCESS_GRACE_MS,
    signal: execution.signal,
    env: { ...env },
  }
  const processHandle = subprocess.spawn(spec)
  const outcome = await processHandle.done
  execution.signal.throwIfAborted()
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: processHandle.collected.stdout?.readFrom(0).text ?? '',
    stderr: processHandle.collected.stderr?.readFrom(0).text ?? '',
  }
}

function environmentResult(
  action: string,
  python: string,
  result: Awaited<ReturnType<typeof run>>,
  packages?: readonly string[],
): PythonEnvironmentResult {
  return {
    action,
    status: result.exitCode === 0 ? 'success' : 'failed',
    python,
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.signal === null
      ? result.stderr
      : result.stderr + '\nProcess ended by signal ' + result.signal,
    ...(packages === undefined ? {} : { packages: [...packages] }),
  }
}

/** Register the fixed `python_environment` tool in MAIN's preset scope. */
export function createPythonEnvironmentTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'python_environment',
    description: 'Inspect, list, or install packages in AutoReport MAIN’s selected Python environment. Installs request user approval and accept package names only.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'list', 'install'] },
      packages: { type: 'array', items: { type: 'string' }, description: 'Package names for install. URLs, paths, options, and version selectors are rejected.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          status: { type: 'string', required: true },
          python: { type: 'string', required: true },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          packages: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 10 * 60 * 1000,
    async execute(args, execution) {
      const subprocess = ctx.get('subprocess') as SubprocessRuntime | undefined
      const shellEnv = ctx.get('shellEnv') as ShellEnvironment | undefined
      if (subprocess === undefined || shellEnv === undefined) throw new Error('Python environment capability is unavailable in this DSH composition')
      const agent = execution.agent
      const session = agent?.session
      if (agent === undefined || session === undefined) throw new Error('python_environment requires the MAIN agent')
      const action = args.action
      const env = shellEnv.collect(execution)
      const selected = env['DSH_AUTOREPORT_PYTHON'] ?? 'python3'
      const python = await subprocess.resolveExecutable(selected, env, execution.signal)
      const cwd = session.header.cwd ?? process.cwd()

      if (action === 'inspect') {
        const result = await run(subprocess, python, ['--version'], execution, cwd, env)
        return environmentResult(action, python, result)
      }
      if (action === 'list') {
        const result = await run(subprocess, python, ['-m', 'pip', 'list', '--format=freeze'], execution, cwd, env)
        return environmentResult(action, python, result)
      }
      if (action !== 'install') throw new Error('action must be inspect, list, or install')

      const packages = validatePackages(args.packages)
      const approvals = ctx.get('approval') as ApprovalService | undefined
      if (approvals === undefined) throw new Error('Installing Python packages requires the DSH user-approval service')
      const reason = `Install ${packages.join(', ')} in the selected AutoReport Python environment (${python}).`
      const decision = await approvals.request({
        agent,
        toolName: 'python_environment',
        reason,
        ...(execution.callId === undefined ? {} : { callId: execution.callId }),
        signal: execution.signal,
      })
      if (decision !== 'allowed-once') {
        return { action, status: decision, python, packages }
      }

      const uv = await subprocess.resolveExecutable('uv', env, execution.signal).catch(() => undefined)
      const executable = uv ?? python
      const argv = uv === undefined
        ? ['-m', 'pip', 'install', ...packages]
        : ['pip', 'install', '--python', python, ...packages]
      const result = await run(subprocess, executable, argv, execution, cwd, env)
      return environmentResult(action, python, result, packages)
    },
  })
}
