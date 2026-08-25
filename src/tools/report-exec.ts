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
      const tempRoot = await createTemp()
      try {
        const executable = await runtime.resolveExecutable(command, {}, signal)
        const isolated = await isolation.wrap({
          argv: [executable, ...args.argv.slice(1)],
          cwd,
          readableRoots,
          writableRoots,
          tempRoot: resolve(tempRoot),
        }, signal)
        const handle = runtime.spawn({
          argv: isolated.argv,
          cwd,
          env: { ...isolated.env },
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: maxOutputBytes },
            stderr: { maxBytes: maxOutputBytes },
          },
          graceMs: TERMINATION_GRACE_MS,
          signal,
        })
        const outcome = await handle.done
        await handle.waitForExit()
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        if (stdout === undefined || stderr === undefined) {
          throw new Error('report_exec subprocess did not provide collected output')
        }
        return {
          exit_code: outcome.exitCode,
          signal: outcome.signal,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: stdout.lossy || stderr.lossy,
          timed_out: timeout.aborted && !exec.signal.aborted,
        }
      } finally {
        await removeTemp(tempRoot)
      }
    },
    presentCall: args => ({ card: 'terminal', title: args.argv.join(' ') }),
  })
}
