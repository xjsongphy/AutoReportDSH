/**
 * Dedicated tool rows for AutoReport's own tools.
 *
 * DSH dispatches each tool call to a keyed `tool.call.toolview` entry by wire
 * tool name, and falls back to its generic "Tool call" row when nothing claims
 * the name. Claiming a name is therefore additive: a call reads as what it did
 * — who was dispatched, which task it touched, which directory was listed —
 * instead of an anonymous row whose only clue is the argument JSON.
 *
 * Every row differs from its siblings in exactly three facts (title key, idle
 * glyph, summary function), so `toolRow` builds them from that triple and the
 * shell — lifecycle, disclosure, argument/result panes, inspector — is written
 * once. A tool DSH already ships a row for is deliberately left alone; the wire
 * names claimed here are the ones only this plugin registers.
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
  DisclosureRow, IconBrowseOutline16, IconChecklistOutline14, IconDownloadOutline16,
  IconFolderOpenOutline16, IconListPenOutline16, IconPaperclipOutline16, IconPlayOutline16,
  IconPaperPlaneOutline14, JsonTree, StateDot, type JsonTreeLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { IconFlagOutline14 } from './icons.js'
import { css } from './styles.js'
import {
  callArgs, compileReportSummary, installPackageSummary, listSummary, manifestSummary,
  manifestTitle, parseArgs, referenceExtractSummary, renderPageSummary, reportWorkflowSummary,
  sendToAgentSummary, toolRowFacts, workflowTaskSummary, workflowTaskTitle,
  type ToolRowFacts, type ToolRowState, type ToolRowText,
} from './tool-rows-model.js'
import type { ToolRowLocaleKey } from './locales.js'

/** Dictionary namespace shared by both rows. */
export const TOOL_NS = 'autoreport.tools'

/** Props of a registered row: the slot's owner currency plus this plugin's copy. */
type RowProps = ToolCallViewProps & PropsLocale<typeof TOOL_NS>

/** Leading slot for one finished lifecycle. A running call keeps its idle
 *  glyph: the fade over the row is the running cue, as it is on host rows. */
function leadingFor(state: ToolRowState, idle: ReactNode): ReactNode {
  switch (state) {
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

/**
 * A body that is a JSON object or array, or undefined for anything else.
 *
 * AutoReport's tools answer with one text block holding a JSON document, so
 * this is what decides between the structured tree and the plain text block —
 * a failure message or a truncated argument prefix stays plain text.
 * @param body - the section's text.
 * @returns the parsed container, or undefined.
 */
function jsonContainer(body: string): object | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** DSH's JSON-tree chrome, assembled from this plugin's flat dictionary. */
function jsonTreeLabels(t: ToolRowText): JsonTreeLabels {
  return {
    copyValue: t('copyValue'),
    copyJson: t('copyJson'),
    copyPath: t('copyPath'),
    copyPrettyJson: t('copyPrettyJson'),
    copyCompactJson: t('copyCompactJson'),
    copied: t('copied'),
    copyFailed: t('copyFailed'),
    collapseNode: t('collapseNode'),
    expandNode: t('expandNode'),
    // The one label DSH builds from the action's own name.
    copyButtonTitle: action => t('copyButtonTitle').replace('{action}', action),
  }
}

/**
 * One gutter-labelled section of the expanded card.
 *
 * A JSON document renders as DSH's own inspector tree, so a long diagnostic or
 * log string folds instead of flooding the card; anything else stays a text
 * block.
 */
function IoSection({ label, body, labels, error = false }: {
  label: string
  body: string | null
  labels: JsonTreeLabels
  error?: boolean
}) {
  if (body === null) return null
  const data = jsonContainer(body)
  return (
    <section className={css.toolIoSection}>
      <span className={css.toolIoLabel}>{label}</span>
      {data === undefined
        ? <pre className={css.toolIoText} data-error={error ? '' : undefined}>{body}</pre>
        : <JsonTree className={css.toolIoTree} data={data} label={label} labels={labels} copyable expandTopLevel />}
    </section>
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
  const labels = jsonTreeLabels(t)
  const expandable = args !== null || facts.output !== null
  const open = expanded && expandable
  const label = facts.errorSummary ?? summary
  const status = statusText(facts.state, t)
  return (
    // The state rides the wrapper as well: it is what the running fade keys off,
    // and the sr-only copy stays a sibling of the row so it never joins the
    // summary's own text.
    <div className={css.toolRow} data-ar-state={facts.state}>
      {status === undefined ? null : <span className={css.toolState}>{status}</span>}
      <DisclosureRow
        icon={leadingFor(facts.state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={label === undefined ? undefined : (
          /* The separator is part of the summary, not of the row: a row with
             nothing to summarise shows its title alone, with no trailing dot. */
          <>
            <span className={css.toolSep} aria-hidden />
            <span className={facts.errorSummary === null ? css.toolSummary : `${css.toolSummary} ${css.toolSummaryFailed}`}>
              {label}
            </span>
          </>
        )}
      >
        <div className={css.toolIo}>
          <IoSection label={t('in')} body={args} labels={labels} />
          {facts.output === null ? null : (
            <>
              <span className={css.toolIoDivider} />
              <IoSection label={t('out')} body={facts.output} labels={labels} error={facts.state === 'error'} />
            </>
          )}
        </div>
        {inspect === undefined ? null : (
          <button type="button" className={css.toolInspect} onClick={inspect}>{t('inspect')}</button>
        )}
      </DisclosureRow>
    </div>
  )
}

/**
 * Collapsed summary of one call, from its arguments and any settled result.
 *
 * A tool that reads nothing back from its result simply ignores the second
 * argument, so every row shares one signature.
 */
type RowSummary = (argsRaw: string, output: string | null, t: ToolRowText) => string | undefined

/**
 * Row label: a fixed locale key, or one the call's own arguments decide — a
 * tool whose verb is an argument (`manifest` reads or updates) says so in the
 * label, where every other row already leads with its verb.
 */
type RowTitle = ToolRowLocaleKey | ((argsRaw: string, t: ToolRowText) => string)

/** The three facts that distinguish one AutoReport tool row from another. */
interface RowSpec {
  /** The always-visible row label. */
  readonly title: RowTitle
  /** Idle glyph for the leading slot. */
  readonly icon: ReactNode
  /** What the row says while collapsed. */
  readonly summary: RowSummary
}

/**
 * Build the row component for one AutoReport tool.
 * @param spec - the row's title, idle glyph, and summary function.
 * @returns the component to register against the tool's wire name.
 */
function toolRow(spec: RowSpec) {
  return function AutoReportToolRow({ block, inspect, t }: RowProps) {
    const argsRaw = callArgs(block)
    const facts = toolRowFacts(block)
    return (
      <RowShell
        title={typeof spec.title === 'string' ? t(spec.title) : spec.title(argsRaw, t)}
        summary={spec.summary(argsRaw, facts.output, t)}
        facts={facts}
        argsRaw={argsRaw}
        t={t}
        icon={spec.icon}
        inspect={inspect}
      />
    )
  }
}

/** One `send_to_agent` delegation. */
export const SendToAgentRow = toolRow({
  title: 'sendToAgentTitle',
  icon: <IconPaperPlaneOutline14 />,
  summary: (argsRaw, _output, t) => sendToAgentSummary(argsRaw, t),
})

/** One `workflow_task` board operation. */
export const WorkflowTaskRow = toolRow({
  title: workflowTaskTitle,
  icon: <IconChecklistOutline14 />,
  summary: workflowTaskSummary,
})

/** One `list` directory listing. */
export const ListRow = toolRow({
  title: 'listTitle',
  icon: <IconFolderOpenOutline16 />,
  summary: listSummary,
})

/** One `manifest` read or update. */
export const ManifestRow = toolRow({
  title: manifestTitle,
  icon: <IconListPenOutline16 />,
  summary: manifestSummary,
})

/** One `extract_pdf` PDF extraction. */
export const ReferenceExtractRow = toolRow({
  title: 'referenceExtractTitle',
  icon: <IconPaperclipOutline16 />,
  summary: referenceExtractSummary,
})

/** One `report_workflow` task-outcome report. */
export const ReportWorkflowRow = toolRow({
  title: 'reportWorkflowTitle',
  icon: <IconFlagOutline14 />,
  summary: reportWorkflowSummary,
})

/** One `install_python_package` install. */
export const InstallPackageRow = toolRow({
  title: 'installPackageTitle',
  icon: <IconDownloadOutline16 />,
  summary: installPackageSummary,
})

/** One `compile_report` run. */
export const CompileReportRow = toolRow({
  title: 'compileReportTitle',
  icon: <IconPlayOutline16 />,
  summary: compileReportSummary,
})

/** One `render_report_page` preview. */
export const RenderPageRow = toolRow({
  title: 'renderPageTitle',
  icon: <IconBrowseOutline16 />,
  summary: renderPageSummary,
})
