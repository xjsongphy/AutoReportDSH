/**
 * Specialist-only exact-argv scientific execution over DSH's subprocess seam.
 *
 * AutoReport owns role policy and network-denial wrapping; DSH owns executable
 * lookup, output collection, cancellation, process-tree teardown, and service
 * disposal. This module never calls Node child_process.
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RoleRegistry } from '../workflow/role-registry.js'
import type { IsolationBackend } from '../policy/isolation/index.js'
import { createPlatformIsolationBackend } from '../policy/isolation/index.js'

const DEFAULT_OUTPUT_BYTES = 65_536
const MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 3_600_000
const MAX_ARGV = 256
const MAX_ARG_BYTES = 32_768
const TERMINATION_GRACE_MS = 1_000

/** Dependencies and tunables for one report_exec registration. */
export interface ReportExecOptions {
  /** Synchronous specialist-role registry. */
  readonly registry: RoleRegistry
  /** Explicit workspace override; defaults to the session cwd. */
  readonly workspaceRoot?: string | undefined
  /** Injectable isolation backend for tests/remote worlds. */
  readonly isolation?: IsolationBackend | undefined
  /** Injectable DSH subprocess runtime. */
  readonly subprocess?: SubprocessRuntime | undefined
  /** Per-stream in-memory output cap. */
  readonly maxOutputBytes?: number | undefined
  /** Default process deadline. */
  readonly timeoutMs?: number | undefined
  /** Test hook for private temp creation. */
  readonly createTemp?: (() => Promise<string>) | undefined
  /** Test hook for private temp cleanup. */
  readonly removeTemp?: ((path: string) => Promise<void>) | undefined
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value) || value > max) {
    throw new Error(`report_exec timeout_ms must be an integer between 1 and ${max}`)
  }
  return value
}

function validateArgv(argv: readonly string[]): void {
  if (argv.length === 0 || argv.length > MAX_ARGV) throw new Error(`report_exec argv must contain 1-${MAX_ARGV} entries`)
  let bytes = 0
  for (const part of argv) {
    if (part.length === 0 || part.includes('\0')) throw new Error('report_exec argv entries must be non-empty and NUL-free')
    bytes += Buffer.byteLength(part)
  }
  if (bytes > MAX_ARG_BYTES) throw new Error(`report_exec argv exceeds ${MAX_ARG_BYTES} UTF-8 bytes`)
}

/** Shared execution dependencies used by report_exec and compile_report. */
export interface IsolatedRunDependencies {
  /** DSH subprocess runtime owning lifecycle and output collection. */
  readonly subprocess: SubprocessRuntime
  /** Isolation backend wrapping exact argv under role policy. */
  readonly isolation: IsolationBackend
  /** Per-stream in-memory output cap. */
  readonly maxOutputBytes: number
  /** Private temp creation hook. */
  readonly createTemp: () => Promise<string>
  /** Private temp cleanup hook. */
  readonly removeTemp: (path: string) => Promise<void>
}

/** One fully resolved isolated run request; every path must be absolute. */
export interface IsolatedRunRequest {
  /** Resolved executable plus exact arguments (never shell-interpreted). */
  readonly argv: readonly string[]
  /** Absolute working directory. */
  readonly cwd: string
  /** Absolute readable roots. */
  readonly readableRoots: readonly string[]
  /** Absolute writable roots. */
  readonly writableRoots: readonly string[]
}

/** Collected outcome of one isolated run. */
export interface IsolatedRunResult {
  readonly exit_code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timed_out: boolean
}

/**
 * Run one exact-argv command through isolation and DSH's subprocess seam.
 * The single execution path shared by `report_exec` and `compile_report`:
 * neither tool spawns processes directly.
 * @param deps - runtime, isolation, and temp hooks.
 * @param request - resolved argv plus policy paths.
 * @param control - external cancellation plus bounded timeout.
 * @returns collected outcome with exit/signal classification.
 */
export async function runIsolated(
  deps: IsolatedRunDependencies,
  request: IsolatedRunRequest,
  control: { externalSignal: AbortSignal; timeoutMs: number },
): Promise<IsolatedRunResult> {
  const timeout = AbortSignal.timeout(control.timeoutMs)
  const signal = AbortSignal.any([control.externalSignal, timeout])
  const tempRoot = await deps.createTemp()
  try {
    const executable = request.argv[0]
    if (executable === undefined) throw new Error('isolated run requires an executable')
    const isolated = await deps.isolation.wrap({
      argv: [executable, ...request.argv.slice(1)],
      cwd: request.cwd,
      readableRoots: request.readableRoots,
      writableRoots: request.writableRoots,
      tempRoot: resolve(tempRoot),
    }, signal)
    const handle = deps.subprocess.spawn({
      argv: isolated.argv,
      cwd: request.cwd,
      env: { ...isolated.env },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: deps.maxOutputBytes },
        stderr: { maxBytes: deps.maxOutputBytes },
      },
      graceMs: TERMINATION_GRACE_MS,
      signal,
    })
    const outcome = await handle.done
    await handle.waitForExit()
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined) {
      throw new Error('report subprocess did not provide collected output')
    }
    return {
      exit_code: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.lossy || stderr.lossy,
      timed_out: timeout.aborted && !control.externalSignal.aborted,
    }
  } finally {
    await deps.removeTemp(tempRoot)
  }
}

/**
 * Build the model-facing report executor. Registration belongs to specialist
 * child setup; the role guard remains an independent final authority.
 */
export function createReportExecTool(ctx: Context, options: ReportExecOptions): ToolDefinition {
  const runtime = options.subprocess ?? ctx.subprocess
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`report_exec maxOutputBytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}`)
  }
  const defaultTimeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const isolation = options.isolation ?? createPlatformIsolationBackend(
    (command, signal) => runtime.resolveExecutable(command, {}, signal),
  )
  const createTemp = options.createTemp ?? (() => mkdtemp(resolve(tmpdir(), 'autoreportdsh-')))
  const removeTemp = options.removeTemp ?? (path => rm(path, { recursive: true, force: true }))

  return defineTool({
    name: 'report_exec',
    description: 'Run one exact-argv scientific command under the current AutoReport role write policy and mandatory network denial. No shell parsing is performed.',
    parameters: {
      argv: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Executable followed by arguments. Each entry is passed exactly; shell syntax is not interpreted.',
      },
      timeout_ms: { type: 'integer', description: `Process deadline, at most ${MAX_TIMEOUT_MS} ms.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          timed_out: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('report_exec requires an owning specialist agent')
      const entry = options.registry.lookup(session.id)
      if (entry === undefined) throw new Error('report_exec denied: agent has no valid specialist role binding')
      validateArgv(args.argv)
      const command = args.argv[0]
      if (command === undefined) throw new Error('report_exec argv must not be empty')
      const timeoutMs = boundedPositive(args.timeout_ms, defaultTimeoutMs, MAX_TIMEOUT_MS)
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([exec.signal, timeout])
      const configuredRoot = options.workspaceRoot ?? session.header.cwd
      if (configuredRoot === undefined) throw new Error('report_exec requires a workspace root or session cwd')
      const workspaceRoot = resolve(configuredRoot)
      const cwd = resolve(workspaceRoot, entry.policy.cwd)
      const readableRoots = entry.policy.readableRoots.map(root => resolve(workspaceRoot, root))
      const writableRoots = entry.policy.writableRoots.map(root => resolve(workspaceRoot, root))
      const executable = await runtime.resolveExecutable(command, {}, signal)
      return runIsolated(
        {
          subprocess: runtime,
          isolation,
          maxOutputBytes,
          createTemp,
          removeTemp,
        },
        {
          argv: [executable, ...args.argv.slice(1)],
          cwd,
          readableRoots,
          writableRoots,
        },
        { externalSignal: exec.signal, timeoutMs },
      )
    },
    presentCall: args => ({ card: 'terminal', title: args.argv.join(' ') }),
  })
}
