/**
 * The pending-call view each AutoReport tool declares.
 *
 * DSH's `GenericCallView.rawInput` is the SALIENT input, explicitly not the
 * whole argument object, and `title` is what a reader sees on the collapsed
 * row. The built-in Web client derives its rows from the wire call instead of
 * reading these values, but they are the provider-neutral vocabulary another
 * client (a CLI log line, an editor card) reads — so they stay honest.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installManifestTool } from '../src/tools/manifest.js'
import { genericCall } from '../src/tools/presentation.js'
import { installWorkflowReportTool } from '../src/tools/report-workflow.js'
import { installWorkflowTaskTool } from '../src/tools/workflow-task.js'

/** One registered tool as these specs read it. */
interface PresentedTool {
  readonly name: string
  readonly presentCall?: (args: unknown) => unknown
}

/** Minimal scope that records registered tools and absorbs prompt sections. */
function toolsScope(): { ctx: Context, host: Context, tools: PresentedTool[] } {
  const tools: PresentedTool[] = []
  const ctx = {
    tools: {
      register: (tool: PresentedTool) => {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: () => () => {},
      getSectionOrder: () => 2900,
    },
  } as unknown as Context
  // Install functions resolve their runtime lazily, inside `execute`.
  return { ctx, host: {} as Context, tools }
}

/** The presenter of one installed tool. */
function presentationOf(tools: readonly PresentedTool[], name: string): (args: unknown) => unknown {
  const tool = tools.find(entry => entry.name === name)
  if (tool?.presentCall === undefined) throw new Error(`${name} declared no presentCall`)
  return tool.presentCall
}

describe('genericCall', () => {
  it('carries the one salient argument', () => {
    expect(genericCall('workflow_task read', 'task-2'))
      .toEqual({ card: 'generic', kind: 'other', title: 'workflow_task read', rawInput: 'task-2' })
  })

  it('omits the input key entirely when the call has nothing salient to show', () => {
    expect(genericCall('workflow_task read', undefined))
      .toEqual({ card: 'generic', kind: 'other', title: 'workflow_task read' })
  })
})

describe('workflow_task presentation', () => {
  it('shows the task id, not the checklist the call carries', () => {
    const { ctx, host, tools } = toolsScope()
    installWorkflowTaskTool(ctx, host)

    expect(presentationOf(tools, 'workflow_task')({
      action: 'update',
      task_id: 'task-2',
      steps: [{ description: 'a', done: true }],
    })).toEqual({ card: 'generic', kind: 'other', title: 'workflow_task update', rawInput: 'task-2' })
  })

  it('shows only the action for a whole-board read', () => {
    const { ctx, host, tools } = toolsScope()
    installWorkflowTaskTool(ctx, host)

    expect(presentationOf(tools, 'workflow_task')({ action: 'read' }))
      .toEqual({ card: 'generic', kind: 'other', title: 'workflow_task read' })
  })
})

describe('manifest presentation', () => {
  it('shows the role whose manifest the call reads or writes', () => {
    const { ctx, host, tools } = toolsScope()
    installManifestTool(ctx, host, 'THEORY')

    expect(presentationOf(tools, 'manifest')({
      action: 'update',
      agent: 'theory',
      files: [{ path: 'Theory/model.md', description_new: 'model' }],
    })).toEqual({ card: 'generic', kind: 'other', title: 'manifest update', rawInput: 'theory' })
  })
})

describe('report_workflow presentation', () => {
  it('shows the task the subagent is reporting on', () => {
    const { ctx, host, tools } = toolsScope()
    installWorkflowReportTool(ctx, host, 'REPORT')

    expect(presentationOf(tools, 'report_workflow')({
      task_id: 'task-2',
      delegation_revision: 1,
      status: 'success',
      response: 'done',
    })).toEqual({ card: 'generic', kind: 'other', title: 'report_workflow success', rawInput: 'task-2' })
  })
})
