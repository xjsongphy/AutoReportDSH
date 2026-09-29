/** MAIN-only, fixed-argument PDF reference extraction into Outline/.cache. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { normalizeWorkspaceRelativePath, type DirectoryFileSystem } from './list-directory.js'

const MAX_STDOUT = 256 * 1024
const MAX_STDERR = 64 * 1024

interface ShellEnvironment {
  collect(execution: ToolExecution): Readonly<Record<string, string>>
}

interface ReferenceFileSystem extends DirectoryFileSystem {
  stat(target: { displayPath: string }, signal?: AbortSignal): Promise<{ type: string } | undefined>
}

async function resolveReferenceWithoutSymlinks(
  fs: ReferenceFileSystem,
  workspace: { displayPath: string },
  logicalPath: string,
  signal: AbortSignal,
): Promise<{ displayPath: string }> {
  let current = workspace
  for (const part of logicalPath.split('/')) {
    const entry = await fs.lstat(part, { cwd: current.displayPath }, signal)
    if (entry?.type === 'symlink') throw new Error('reference_extract does not follow symbolic links')
    const next = await fs.resolve(part, { cwd: current.displayPath, signal })
    if (!fs.contains(workspace, next)) throw new Error('reference_extract input is outside the experiment workspace')
    current = next
  }
  return current
}

function outputStem(path: string): string {
  const stem = basename(path, extname(path)).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/u, '').slice(0, 80)
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 12)
  return `${stem || 'reference'}-${hash}`
}

function ensureSafeOutputPath(outputDirectory: string, outlineRoot: string): void {
  const outline = realpathSync.native(outlineRoot)
  if (existsSync(outputDirectory) && lstatSync(outputDirectory).isSymbolicLink()) {
    throw new Error('reference_extract refuses a symlink output directory')
  }
  let ancestor = outputDirectory
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, '..')
    if (parent === ancestor) throw new Error('reference_extract output has no existing parent')
    ancestor = parent
  }
  const canonicalAncestor = realpathSync.native(ancestor)
  const rel = relative(outline, canonicalAncestor)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('reference_extract output resolves outside Outline/')
  }
}

/** Register the fixed-argv `reference_extract` capability in MAIN's preset. */
export function createReferenceExtractTool(ctx: Context, workspaceRootOf: (execution: ToolExecution) => string | undefined): ToolDefinition {
  return defineTool({
    name: 'reference_extract',
    description: 'Extract one PDF from References/ into Outline/.cache/mineru/ using the configured MinerU client. MAIN only; paths are fixed to these input and output areas.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Workspace-relative PDF path under References/.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          source: { type: 'string', required: true },
          output_directory: { type: 'string', required: true },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 15 * 60 * 1000,
    async execute(args, execution) {
      const subprocess = ctx.get('subprocess') as SubprocessRuntime | undefined
      const shellEnv = ctx.get('shellEnv') as ShellEnvironment | undefined
      const fs = ctx.get('fs') as ReferenceFileSystem | undefined
      if (subprocess === undefined || shellEnv === undefined || fs === undefined) {
        throw new Error('Reference extraction requires the DSH subprocess, shell environment, and filesystem providers')
      }
      const workspaceRoot = workspaceRootOf(execution)
      if (workspaceRoot === undefined) throw new Error('reference_extract requires an AutoReport MAIN workspace')
      const logicalPath = normalizeWorkspaceRelativePath(args.file_path)
      if (!logicalPath.startsWith('References/') || extname(logicalPath).toLowerCase() !== '.pdf') {
        throw new Error('reference_extract accepts only PDF files under References/')
      }
      const workspace = await fs.resolve(workspaceRoot, { signal: execution.signal })
      const references = await resolveReferenceWithoutSymlinks(fs, workspace, 'References', execution.signal)
      const source = await resolveReferenceWithoutSymlinks(fs, workspace, logicalPath, execution.signal)
      if (!fs.contains(workspace, references) || !fs.contains(references, source)) {
        throw new Error('reference_extract input is outside References/')
      }
      if ((await fs.stat(source, execution.signal))?.type !== 'file') throw new Error('reference_extract input must be a regular file')

      const base = resolve(workspaceRoot, 'Outline', '.cache', 'mineru')
      const outputDirectory = resolve(base, outputStem(logicalPath))
      const outputRelative = relative(base, outputDirectory)
      if (outputRelative === '..' || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)) {
        throw new Error('reference_extract output resolves outside Outline/.cache/mineru/')
      }
      ensureSafeOutputPath(outputDirectory, resolve(workspaceRoot, 'Outline'))
      const env = shellEnv.collect(execution)
      const executable = await subprocess.resolveExecutable('mineru-open-api', env, execution.signal)
      const cwd = resolve(workspaceRoot, 'Outline')
      const spec: SubprocessSpawnSpec = {
        argv: [executable, 'extract', source.displayPath, '-o', outputDirectory],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_STDOUT }, stderr: { maxBytes: MAX_STDERR } },
        graceMs: 2_000,
        signal: execution.signal,
        env: { ...env },
      }
      const processHandle = subprocess.spawn(spec)
      const outcome = await processHandle.done
      execution.signal.throwIfAborted()
      const stdout = processHandle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = processHandle.collected.stderr?.readFrom(0).text ?? ''
      return {
        status: outcome.exitCode === 0 ? 'success' : 'failed',
        source: logicalPath,
        output_directory: `Outline/.cache/mineru/${outputStem(logicalPath)}`,
        exitCode: outcome.exitCode ?? -1,
        stdout,
        stderr: outcome.signal === null ? stderr : `${stderr}\nProcess ended by signal ${outcome.signal}`,
      }
    },
  })
}
