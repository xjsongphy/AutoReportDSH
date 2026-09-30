/** Hide inherited process tools that AutoReport does not give a role. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ROLE_PROCESS_TOOL, rolePolicy, type AutoReportRole } from '../roles.js'

/** Scope-local restrictions are in place before the agent's first prompt. */
export function restrictInheritedShell(ctx: Context, agent: Agent, role: AutoReportRole): () => void {
  if (typeof ctx.tools?.get !== 'function' || typeof ctx.tools.restrict !== 'function') return () => {}
  const otherProcessTool = ROLE_PROCESS_TOOL === 'bash' ? 'pwsh' : 'bash'
  const names = rolePolicy(role).hasProcessTool ? [otherProcessTool] : ['bash', 'pwsh']
  const inherited = names.filter(name => ctx.tools.get(name, agent) !== undefined)
  return inherited.length === 0 ? () => {} : ctx.tools.restrict({ deny: inherited })
}
