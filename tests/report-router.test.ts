import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  effectiveSandboxMode,
  effectiveSandboxWorkspaceRoot,
} from '@deepseek-ai/dsh-sandbox-policy/src/session-mode.ts'
import { RoleRegistry } from '../src/workflow/role-registry.js'
import type { Config } from '../src/config.js'
import type { RoleBindingSnapshot } from '../src/workflow/events.js'
import { installRoutedReportTool } from '../src/tools/report-router.js'
import { installWorkflowReportTool } from '../src/tools/report-workflow.js'

const CONFIG: Config = {
  defaultReportLanguage: 'latex',
  defaultLatexEngine: 'latexmk',
  workspaceRoot: undefined,
  specialistModel: undefined,
  delegationWaitTimeoutMs: 600_000,
  executionTimeoutMs: 600_000,
}

function childContext(id = 'child-1', cwd?: string) {
  const tools: { name: string }[] = []
  const skills: { name: string }[] = []
  const sections: { name: string; text: string }[] = []
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: Date.now(),
    cwd: cwd ?? '/tmp/autoreport-workspace',
  })
  const ctx = {
    agent: { id: sessionId, session },
    tools: {
      register: (tool: { name: string }) => {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: { name: string; text: string }) => {
        sections.push(section)
        return () => {}
      },
    },
    skills: {
      register: (skill: { name: string }) => {
        skills.push(skill)
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as Context, tools, skills, sections, session }
}

function hostContext() {
  const reportFrom = vi.fn(async () => 'report-msg')
  return {
    ctx: {
      subagents: { reportFrom },
    } as unknown as Context,
    reportFrom,
  }
}

describe('report router', () => {
  it('installs stock report for ordinary DSH children', () => {
    const child = childContext()
    const host = hostContext()
    installRoutedReportTool(child.ctx, host.ctx, { roleRegistry: new RoleRegistry(), config: CONFIG, workflowForChild: () => undefined })
    expect(child.tools.map(tool => tool.name)).toEqual(['report'])
    expect(child.sections.some(section => section.name === 'tool:report')).toBe(true)
  })

  it('installs report_workflow and role sandbox for a pre-bound specialist', () => {
    const workspaceRoot = '/tmp/autoreport-theory-workspace'
    const child = childContext('child-1', workspaceRoot)
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    const binding: RoleBindingSnapshot = {
      version: 1,
      role: 'THEORY',
      childSessionId: SessionId('child-1'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    }
    roleRegistry.registerReserved(binding)
    installRoutedReportTool(child.ctx, host.ctx, { roleRegistry, config: CONFIG, workflowForChild: () => undefined })
    expect(child.tools.map(tool => tool.name)).toEqual(['report_workflow'])
    expect(child.skills).toEqual([])
    expect(child.sections.some(section => section.text.includes('THEORY'))).toBe(true)
    expect(child.tools.some(tool => tool.name === 'report')).toBe(false)
    expect(effectiveSandboxMode(child.session.events)).toBe('workspace-write')
    expect(effectiveSandboxWorkspaceRoot(child.session.events)).toBe(`${workspaceRoot}/Theory`)
  })

  it('installs report_workflow only for REPORT with compile skills', () => {
    const workspaceRoot = '/tmp/autoreport-report-workspace'
    const child = childContext('child-report', workspaceRoot)
    const host = hostContext()
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'REPORT',
      childSessionId: SessionId('child-report'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    installRoutedReportTool(child.ctx, host.ctx, { roleRegistry, config: CONFIG, workflowForChild: () => undefined })
    expect(child.tools.map(tool => tool.name)).toEqual(['report_workflow'])
    expect(child.sections.map(section => section.name)).toEqual(expect.arrayContaining([
      'autoreport:skill:experiment-report-writer',
      'autoreport:skill:latex-compile',
    ]))
    expect(effectiveSandboxWorkspaceRoot(child.session.events)).toBe(`${workspaceRoot}/Report`)
  })

  it('skips sandbox apply when the child has no session', () => {
    const tools: { name: string }[] = []
    const roleRegistry = new RoleRegistry()
    roleRegistry.registerReserved({
      version: 1,
      role: 'PLOTTING',
      childSessionId: SessionId('child-stock'),
      parentSessionId: SessionId('main'),
      workflowId: 'wf',
      provisioning: 'reserved',
    })
    const ctx = {
      agent: { id: SessionId('child-stock') },
      tools: {
        register: (tool: { name: string }) => {
          tools.push(tool)
          return () => {}
        },
      },
      systemPrompt: { section: () => () => {} },
      skills: { register: () => () => {} },
    } as unknown as Context
    installRoutedReportTool(ctx, hostContext().ctx, { roleRegistry, config: CONFIG, workflowForChild: () => undefined })
    expect(tools.map(tool => tool.name)).toEqual(['report_workflow'])
  })
})

describe('report_workflow', () => {
  it('serializes a validated envelope through reportFrom', async () => {
    const child = childContext()
    const host = hostContext()
    installWorkflowReportTool(child.ctx, host.ctx, 'REPORT')
    const tool = child.tools[0] as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ messageId: string }> }
    const result = await tool.execute({
      task_id: 'task-3',
      delegation_revision: 2,
      status: 'success',
      response: 'compiled',
      produced_files: ['Report/main.pdf'],
    }, { agent: { id: SessionId('child-1') }, signal: new AbortController().signal })
    expect(result).toEqual({ messageId: 'report-msg' })
    expect(host.reportFrom).toHaveBeenCalledOnce()
    const content = host.reportFrom.mock.calls[0]?.[1] as { type: string; text: string }[]
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({
      task_id: 'task-3',
      delegation_revision: 2,
      status: 'success',
      block_type: null,
      produced_files: ['Report/main.pdf'],
    })
  })

  it('rejects a blocked report missing block_type', async () => {
    const child = childContext()
    const host = hostContext()
    installWorkflowReportTool(child.ctx, host.ctx, 'PLOTTING')
    const tool = child.tools[0] as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }
    await expect(tool.execute({
      task_id: 'task-3',
      delegation_revision: 1,
      status: 'blocked',
      response: 'need data',
    }, { agent: { id: SessionId('child-1') }, signal: new AbortController().signal })).rejects.toThrow(/invalid workflow report/)
    expect(host.reportFrom).not.toHaveBeenCalled()
  })
})
