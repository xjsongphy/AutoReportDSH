/** Hide inherited process tools that AutoReport does not give a role. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { rolePolicy, type AutoReportRole } from '../roles.js'

/** Scope-local restrictions are in place before the agent's first prompt. */
export function restrictInheritedShell(ctx: Context, agent: Agent, role: AutoReportRole): () => void {
  if (typeof ctx.tools?.get !== 'function' || typeof ctx.tools.restrict !== 'function') return () => {}
  const names = rolePolicy(role).execution === 'shell' ? ['pwsh'] : ['bash', 'pwsh']
  const inherited = names.filter(name => ctx.tools.get(name, agent) !== undefined)
  return inherited.length === 0 ? () => {} : ctx.tools.restrict({ deny: inherited })
}
