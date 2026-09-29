/** Dynamic, role-derived filesystem capability context for AutoReport agents. */
import { existsSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { rolePolicy, type AutoReportRole } from './roles.js'

interface ScopeAssembly {
  readonly agent?: {
    readonly session?: Session
    readonly ctx?: { readonly tools?: { get(name: string, scope?: unknown): unknown } }
  }
}

export interface FilesystemScopeDependencies {
  roleOf(session: Session): AutoReportRole | undefined
  workspaceRootOf(session: Session): string | undefined
}

function listRoots(roots: readonly string[]): string {
  return roots.length === 0 ? '(none)' : roots.map(root => root === '.' ? './' : `${root}/`).join(', ')
}

function hasLocalProcessBackend(): boolean {
  // On Windows the product requires DSH's pwsh-sandbox + Windows ACL policy;
  // the host only exposes pwsh after that sandboxPolicy is present.
  if (process.platform === 'win32') return true
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec')
  if (process.platform !== 'linux') return false
  return (process.env['PATH'] ?? '').split(delimiter).some(entry => existsSync(resolve(entry, 'bwrap')))
}

/** Render the single workspace authorization statement from the fixed role table. */
export function renderFilesystemScope(
  role: AutoReportRole,
  workspaceRoot: string,
  processBackend = hasLocalProcessBackend(),
): string {
  const policy = rolePolicy(role)
  const platformShell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const processAvailable = policy.process === 'role-aware' && processBackend
  const availableTools = policy.tools.filter(name =>
    (name !== 'bash' && name !== 'pwsh') || (processAvailable && name === platformShell))
  return [
    '# AutoReport filesystem scope',
    `Role: ${role}`,
    `Workspace root: ${workspaceRoot}`,
    '',
    'Discoverable roots (names only):',
    `- ${listRoots(policy.discoverableRoots)}`,
    '',
    'Readable roots (file contents):',
    `- ${listRoots(policy.readableRoots)}`,
    '',
    'Writable roots:',
    `- ${listRoots(policy.writableRoots)}`,
    '',
    `AutoReport tools: ${availableTools.join(', ')}`,
    'Other DSH tools are not available to this role.',
    '',
    `Network: ${policy.network}; temporary files: ${policy.temp}.`,
    'Within the experiment workspace, read/write tools enforce these role capabilities. Workspace mutations performed indirectly must remain in the writable roots. System files and explicitly exposed runtime paths remain outside this workspace scope.',
    processAvailable && process.platform === 'win32'
      ? 'PowerShell is constrained to this role, starts in its writable root, and uses DSH Windows ACL write confinement plus AutoReport command/path preflight. Windows does not enforce the readable-root boundary for arbitrary process reads; treat the preflight as a guardrail, not a security boundary.'
      : processAvailable
        ? 'Bash uses the role filesystem sandbox for this role and its descendants; if the operating-system backend cannot start, the call fails closed.'
        : policy.process === 'role-aware'
          ? 'This role needs a process backend for execution tasks, but none is available on this platform. Report the blocker through report_workflow; do not fall back to an unguarded tool.'
          : 'This role has no general process tool. Use its dedicated AutoReport capabilities or request help from the assigned specialist; no shell fallback is provided.',
    'Cross-role manifest and workflow handoff metadata remain an explicitly permitted coordination channel; metadata does not grant access to the referenced file contents.',
    'Skill bodies delivered through this role\'s skill catalog are a separate trusted instruction channel, not experiment-workspace file access.',
    '',
    `Path conventions: \`read\`/\`read_image\`/\`list\`/\`grep\` use workspace-root-relative paths; \`write\`/\`edit\` use the role writable root when sandboxed; \`str_replace_editor\` requires absolute workspace paths; ${processAvailable ? `role-aware \`${platformShell}\` starts in the writable root and resolves relative \`workdir\` there` : 'general process path conventions do not apply to this role'}; manifest and \`report_workflow\` paths are workspace-relative. \`glob\` is disabled for AutoReport.`,
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
      const platformShell = process.platform === 'win32' ? 'pwsh' : 'bash'
      const shellVisible = assembly.agent?.ctx?.tools?.get(platformShell, assembly.agent) !== undefined
      return renderFilesystemScope(role, root, shellVisible && hasLocalProcessBackend())
    },
  })
}
