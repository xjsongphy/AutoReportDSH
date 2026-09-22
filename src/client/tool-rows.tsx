/**
 * Dedicated tool rows for AutoReport's two workflow-bearing tools.
 *
 * DSH dispatches each tool call to a keyed `tool.call.toolview` entry by wire
 * tool name, and falls back to its generic "Tool call" row when nothing claims
 * the name. Claiming `send_to_agent` and `workflow_task` is therefore additive:
 * a call reads as who was dispatched and which task it touched, instead of an
 * anonymous row whose only clue is the argument JSON.
 *
 * The collapsed chrome is DSH's own `DisclosureRow` (ui-primitives is a shell
 * platform module, so it is required, never bundled). ui-tool is imported for
 * TYPES only — its rows are package-internal and its CSS modules would not
 * survive this plugin's plain esbuild bundle.
 *
 * @module autoreportdsh/tool-rows
 */

import { useState, type ReactNode } from 'react'
import {
  DisclosureRow, IconChecklistOutline14, IconPaperPlaneOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { css } from './styles.js'
import {
  callArgs, parseArgs, sendToAgentSummary, toolRowFacts, workflowTaskSummary,
  type ToolRowFacts, type ToolRowState, type ToolRowText,
} from './tool-rows-model.js'

/** Dictionary namespace shared by both rows. */
export const TOOL_NS = 'autoreport.tools'

/** Props of a registered row: the slot's owner currency plus this plugin's copy. */
type RowProps = ToolCallViewProps & PropsLocale<typeof TOOL_NS>

/** Leading slot for one lifecycle. The host's own sweep is ui-tool-internal,
 *  so a running call wears the primitive's ongoing dot instead. */
function leadingFor(state: ToolRowState, idle: ReactNode): ReactNode {
  switch (state) {
    case 'running': return <StateDot state="ongoing" />
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return idle
  }
}

/** Visually hidden lifecycle copy: the dots carry colour only. */
function statusText(state: ToolRowState, t: ToolRowText): string | undefined {
  switch (state) {
    case 'running': return t('running')
    case 'error': return t('failed')
    case 'stopped': return t('stopped')
    default: return undefined
  }
}

/** The call's arguments, pretty-printed; unreadable or absent arguments read as null. */
function prettyArgs(argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  return parsed === undefined ? argsRaw : JSON.stringify(parsed, null, 2)
}

/** One labelled block of the expanded card. */
function IoBlock({ label, body }: { label: string, body: string | null }) {
  if (body === null) return null
  return (
    <div className={css.toolIoBlock}>
      <span className={css.toolIoLabel}>{label}</span>
      <pre className={css.toolIoBody}>{body}</pre>
    </div>
  )
}

interface RowShellProps {
  /** Always-visible row label. */
  readonly title: string
  /** Collapsed label; replaced by the failure's first line when the call failed. */
  readonly summary: string | undefined
  readonly facts: ToolRowFacts
  readonly argsRaw: string
  readonly t: ToolRowText
  /** Idle leading icon. */
  readonly icon: ReactNode
  /** Trajectory jump, when the owning chat node offers one. */
  readonly inspect: (() => void) | undefined
}

/** One AutoReport tool call: summary row plus the disclosure it owns. */
function RowShell({ title, summary, facts, argsRaw, t, icon, inspect }: RowShellProps) {
  const [expanded, setExpanded] = useState(false)
  const args = prettyArgs(argsRaw)
  const expandable = args !== null || facts.output !== null
  const open = expanded && expandable
  const label = facts.errorSummary ?? summary
  const status = statusText(facts.state, t)
  return (
    <DisclosureRow
      icon={leadingFor(facts.state, icon)}
      title={title}
      open={open}
      expandable={expandable}
      expandOnRowClick
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={label === undefined && status === undefined ? undefined : (
        <span className={facts.errorSummary === null ? css.toolSummary : `${css.toolSummary} ${css.toolSummaryFailed}`}>
          {label}
          {status === undefined ? null : <span className={css.toolState}>{status}</span>}
        </span>
      )}
    >
      <div className={css.toolIo}>
        <IoBlock label={t('in')} body={args} />
        <IoBlock label={t('out')} body={facts.output} />
        {inspect === undefined ? null : (
          <button type="button" className={css.toolInspect} onClick={inspect}>{t('inspect')}</button>
        )}
      </div>
    </DisclosureRow>
  )
}

/**
 * Render one `send_to_agent` delegation.
 * @param props - the slot's owner currency plus this plugin's copy.
 * @returns the delegation row.
 */
export function SendToAgentRow({ block, inspect, t }: RowProps) {
  const argsRaw = callArgs(block)
  return (
    <RowShell
      title={t('sendToAgentTitle')}
      summary={sendToAgentSummary(argsRaw, t)}
      facts={toolRowFacts(block)}
      argsRaw={argsRaw}
      t={t}
      icon={<IconPaperPlaneOutline14 />}
      inspect={inspect}
    />
  )
}

/**
 * Render one `workflow_task` board operation.
 * @param props - the slot's owner currency plus this plugin's copy.
 * @returns the board row.
 */
export function WorkflowTaskRow({ block, inspect, t }: RowProps) {
  const argsRaw = callArgs(block)
  const facts = toolRowFacts(block)
  return (
    <RowShell
      title={t('workflowTaskTitle')}
      summary={workflowTaskSummary(argsRaw, facts.output, t)}
      facts={facts}
      argsRaw={argsRaw}
      t={t}
      icon={<IconChecklistOutline14 />}
      inspect={inspect}
    />
  )
}
