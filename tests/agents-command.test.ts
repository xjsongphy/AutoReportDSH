import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { AUTOREPORT_MAIN_PRESET } from '../src/membership.js'
import { createAgentsCommand } from '../src/agents-command.js'

function invocation(agentPreset: string | undefined = AUTOREPORT_MAIN_PRESET): CommandInvocation {
  const id = SessionId('agents-command')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: 0,
    cwd: '/tmp/autoreport-command',
    ...(agentPreset === undefined ? {} : { agentPreset }),
  })
  return {
    commandId: 'command-1' as CommandInvocation['commandId'],
    agent: { id, session } as Agent,
    rawInput: '',
    attachments: [],
    signal: new AbortController().signal,
  }
}

describe('/agents command', () => {
  it('activates all residents through the runtime seam', async () => {
    const activate = vi.fn(async () => undefined)
    const command = createAgentsCommand({ activateResidentRoles: activate })
    const result = await command.handler(invocation())

    expect(result).toEqual({ kind: 'success', text: 'AutoReport subagents are ready.' })
    expect(activate).toHaveBeenCalledOnce()
  })

  it('does not activate a stock session', async () => {
    const activate = vi.fn(async () => undefined)
    const command = createAgentsCommand({ activateResidentRoles: activate })
    const result = await command.handler(invocation('standard'))

    expect(result).toEqual({
      kind: 'error',
      text: "agents is available only in an 'autoreport' session.",
    })
    expect(activate).not.toHaveBeenCalled()
  })
})
