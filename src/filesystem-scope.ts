/** Dynamic, role-derived filesystem capability context for AutoReport agents. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { rolePolicy, type AutoReportRole } from './roles.js'

interface ScopeAssembly {
  readonly agent?: {
    readonly session?: Session
    readonly ctx?: {
      readonly tools?: {
        get(name: string, scope?: unknown): unknown
        schemas?(scope?: unknown): readonly { readonly name: string }[]
      }
    }
  }
}

export interface FilesystemScopeDependencies {
  roleOf(session: Session): AutoReportRole | undefined
  workspaceRootOf(session: Session): string | undefined
}

/** Filesystem usage principles shared by every role that can see the file tools. */
function usageLines(toolNames: readonly string[]): string[] {
  const visible = new Set(toolNames)
  const lines = [
    'Filesystem tool usage:',
    '- `read` and `read_image` open regular files only; they do not enumerate directories and do not expand wildcard characters such as `*` or `?` in a path.',
  ]
  if (visible.has('list') && visible.has('grep')) {
    lines.push('- Discover directories with `list`; search file contents with `grep`.')
  } else if (visible.has('list')) {
    lines.push('- Discover directories with `list`.')
  }
  lines.push(
    visible.has('list')
      ? '- Do not use failed `read` calls to probe for existence. After a not-found or wrong-type error, inspect the containing directory with `list` instead of trying more guessed paths.'
      : '- Do not use failed `read` calls to probe for existence; do not continue with more guessed paths after a not-found or wrong-type error.',
  )
  if (visible.has('skill')) {
    // Same-source with the surface: a role without the loader has no catalog,
    // so the warning would point at a tool it cannot call.
    lines.push('- Never invent skill names; invoke `skill` only with a name shown in your skill catalog. If no catalog skill matches the task, continue without one.')
  }
  return lines
}

/** Render the single workspace authorization statement from the fixed role table. */
export function renderFilesystemScope(
  role: AutoReportRole,
  workspaceRoot: string,
  processToolVisible: boolean,
  visibleToolNames?: readonly string[],
): string {
  const policy = rolePolicy(role)
  const toolNames = visibleToolNames ?? policy.tools.filter(name =>
    name !== (process.platform === 'win32' ? 'pwsh' : 'bash') || processToolVisible)
  const processLine = processToolVisible
    ? 'The shell starts at the workspace root (navigation only); the DSH sandbox confines its writes to your writable root.'
    : ''
  const pathToolNames = toolNames.filter(name =>
    ['read', 'read_image', 'write', 'edit', 'list', 'grep', 'manifest', 'report_workflow'].includes(name))
  return [
    '# AutoReport workspace scope',
    `Role: ${role}`,
    `Workspace root: ${workspaceRoot}`,
    `Writable root: ${policy.writableRoot}/ (the only directory you may mutate; enforced by the DSH sandbox and tool guards)`,
    'Read scope: the entire experiment workspace. Read permission is context, not duty — your persona defines what you produce.',
    `AutoReport tools: ${toolNames.join(', ')}`,
    'Other DSH tools are not available to this role.',
    '',
    processLine,
    '',
    ...usageLines(toolNames),
    '',
    `Path conventions: paths passed to ${pathToolNames.join(', ')} are experiment-workspace-relative, e.g. \`Report/main.typ\`, \`Data/Processed/results.csv\`.`,
    'Cross-role manifest and workflow handoff metadata remain an explicitly permitted coordination channel; metadata does not grant access to the referenced file contents.',
    'Skill bodies delivered through this role\'s skill catalog are a separate trusted instruction channel, not experiment-workspace file access.',
  ].join('\n')
}

/** Install a per-session dynamic context sourced only from `rolePolicy()`. */
export function installFilesystemScopeContext(ctx: Context, deps: FilesystemScopeDependencies): () => void {
  const prompt = ctx.get('systemPrompt') as {
    getContextOrder(name: string): number
    context(entry: { name: string; order: number; text(assembly: unknown): string }): () => void
  } | undefined
  if (prompt === undefined) return () => {}
  return prompt.context({
    name: 'autoreport:filesystem-scope',
    order: prompt.getContextOrder('SANDBOX_POLICY'),
    text: (raw) => {
      const assembly = raw as ScopeAssembly
      const session = assembly.agent?.session
      if (session === undefined) return ''
      const role = deps.roleOf(session)
      const root = deps.workspaceRootOf(session)
      if (role === undefined || root === undefined) return ''
      const shellName = rolePolicy(role).hasProcessTool
        ? (process.platform === 'win32' ? 'pwsh' : 'bash')
        : undefined
      const shellVisible = shellName !== undefined
        && assembly.agent?.ctx?.tools?.get(shellName, assembly.agent) !== undefined
      const visibleTools = assembly.agent?.ctx?.tools?.schemas?.(assembly.agent).map(tool => tool.name)
      return renderFilesystemScope(role, root, shellVisible, visibleTools)
    },
  })
}
