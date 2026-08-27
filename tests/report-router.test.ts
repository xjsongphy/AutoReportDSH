import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
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
  executionTimeoutMs: 600_000,
}

function childContext() {
  const tools: { name: string }[] = []
  const skills: { name: string }[] = []
  const sections: { name: string; text: string }[] = []
  const ctx = {
    agent: { id: SessionId('child-1') },
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
  return { ctx: ctx as unknown as Context, tools, skills, sections }
}

function hostContext() {
  const reportFrom = vi.fn(async () => 'report-msg')
  return {
    ctx: {
      subagents: { reportFrom },
      subprocess: {
        resolveExecutable: async (command: string) => command,
        spawn: () => {
          throw new Error('spawn unused in routing tests')
        },
      },
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

  it('installs report_workflow and report_exec for a pre-bound specialist', () => {
    const child = childContext()
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
    expect(child.tools.map(tool => tool.name)).toEqual(['report_workflow', 'report_exec'])
    expect(child.skills).toEqual([])
    expect(child.sections.some(section => section.name === 'autoreport:skill:mineru')).toBe(true)
    expect(child.sections.some(section => section.text.includes('THEORY'))).toBe(true)
    expect(child.tools.some(tool => tool.name === 'report')).toBe(false)
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
