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
  const processLine = policy.hasProcessTool
    ? (processToolVisible
      ? 'The shell starts at the workspace root (navigation only); the DSH sandbox confines its writes to your writable root.'
      : 'This role is assigned a shell, but it is unavailable in this session. Report the blocker through report_workflow; do not fall back to an unguarded tool.')
    : 'This role has no process tool. Use its dedicated capabilities or request execution work from an assigned specialist; there is no shell fallback.'
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
    'Path conventions: every path you exchange with any tool is experiment-workspace-relative, e.g. `Report/main.typ`, `Data/Processed/results.csv` — including `read`, `write`, `edit`, `list`, `grep`, manifest, report_workflow, and shell arguments.',
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
