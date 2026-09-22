/**
 * Browser half of AutoReportDSH: the settings card for the `autoreport`
 * namespace, registered into DSH's plugin-configuration tab, a
 * conversation-window model picker for AutoReport subagents, and the two
 * dedicated tool rows for the workflow-bearing tools.
 *
 * Host registration of the namespace already lives in `src/runtime.ts`. This
 * file only owns chrome, controls, and copy. Cross-plugin collaboration is
 * type-only: a value import of ui-settings-plugins fails the client
 * bundle-purity gate. The tool rows additionally require ui-primitives, which
 * is a shell platform module rather than a plugin bundle.
 */

import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { AutoReportCard } from './AutoReportCard.js'
import { AUTOREPORT_SETTINGS_NAMESPACE, AutoReportCardController } from './controller.js'
import { en, toolRowEn, toolRowZh, zh, type AutoReportLocaleKey, type ToolRowLocaleKey } from './locales.js'
import { SubagentModelSelect, type SubagentModelChoice, type SubagentModelInjected } from './SubagentModelSelect.js'
import { installCardStyles } from './styles.js'
import { SendToAgentRow, TOOL_NS, WorkflowTaskRow } from './tool-rows.js'

export type { AutoReportCardProps } from './AutoReportCard.js'
export type { AutoReportCardFace, AutoReportCardSettings, AutoReportCardState } from './controller.js'
export { AUTOREPORT_SETTINGS_NAMESPACE } from './controller.js'
export type { AutoReportLocaleKey, ToolRowLocaleKey } from './locales.js'
export { TOOL_NS } from './tool-rows.js'

/** Dictionary namespace owned by this card. */
export const SETTINGS_NS = 'settings.autoreport'

/** Agent preset whose children get the conversation-window model picker. */
const AUTOREPORT_PRESET = 'autoreport'

/** Wire tool names this plugin renders itself, paired with their row. */
const TOOL_ROWS = [
  ['send_to_agent', SendToAgentRow],
  ['workflow_task', WorkflowTaskRow],
] as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The AutoReport settings card's copy. */
    'settings.autoreport': AutoReportLocaleKey
    /** The AutoReport tool rows' copy. */
    'autoreport.tools': ToolRowLocaleKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Where the card sits in the Plugins page's Official group. */
const CARD_ORDER = 50

/**
 * Register the AutoReport card into the Plugins page's `plugins.item` slot.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  installCardStyles()
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'AutoReportDSH: settings dictionaries')
  ctx.effect(() => ctx.locale.register(TOOL_NS, { zh: toolRowZh, en: toolRowEn }), 'AutoReportDSH: tool-row dictionaries')
  const t = ctx.locale.bind(SETTINGS_NS)
  const card = new AutoReportCardController(ctx.settingsScope.bind({ namespace: AUTOREPORT_SETTINGS_NAMESPACE }))
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: AUTOREPORT_SETTINGS_NAMESPACE,
    order: CARD_ORDER,
    label: () => t('title'),
    locale: SETTINGS_NS,
    inject: () => card.inject(),
  }, AutoReportCard))
  ctx.inject(['sessions'], (scope: ClientContext) => {
    installSubagentModelSeat(scope)
  })
  installToolRows(ctx)
}

/**
 * Claim the keyed `tool.call.toolview` entry for each AutoReport tool.
 *
 * The slot is declared by ui-tool; `slots.inject` waits for that declaration,
 * so these land whether or not the chat node mounted first. Keys DSH already
 * ships would be taken over, not shared — neither of these two is shipped.
 * @param ctx - the browser plugin context.
 */
function installToolRows(ctx: ClientContext): void {
  for (const [key, Row] of TOOL_ROWS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key,
      locale: TOOL_NS,
    }, Row))
  }
}

function installSubagentModelSeat(ctx: ClientContext): void {
  const sessions = ctx.get('sessions') as ISessions
  const connection = ctx.get('connection') as { api: { sessions: SessionModelsApi } }
  const modelsApi = connection.api.sessions
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'autoreport-subagent-model',
    order: 40,
    locale: SETTINGS_NS,
    inject: (sessionId: SessionId): SubagentModelInjected => {
      const available = isAutoReportSubagent(sessions, sessionId)
      return {
        available,
        load: () => available ? loadDirectory(modelsApi, sessionId) : Promise.resolve(undefined),
        select: (selection) => available ? selectModel(modelsApi, sessionId, selection) : Promise.resolve(false),
      }
    },
  }, SubagentModelSelect))
}

function isAutoReportSubagent(sessions: ISessions, sessionId: SessionId): boolean {
  const address = sessions.subagentAddress(sessionId)
  if (address === undefined) return false
  const parent = sessions.list.getSnapshot().byId[address.parentSessionId]
  return parent?.agentPreset === AUTOREPORT_PRESET
}

interface SessionModelsApi {
  models(payload: { sessionId: SessionId }): Promise<{
    result: {
      ok: boolean
      value?: {
        current: { provider: string; model: string; reasoningEffort?: string }
        groups: readonly {
          id: string
          name: string
          models: readonly {
            id: string
            name: string
            reasoning?: { defaultEffort?: string; efforts: readonly { id: string; name: string }[] }
          }[]
        }[]
      }
      error?: { message: string }
    }
  }>
  selectModel(payload: {
    sessionId: SessionId
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{ result: { ok: boolean; value?: { selected: { provider: string; model: string; reasoningEffort?: string } } } }>
}

async function loadDirectory(
  api: SessionModelsApi,
  sessionId: SessionId,
): Promise<{ current: { provider: string; model: string; reasoningEffort?: string } | null; choices: readonly SubagentModelChoice[] } | undefined> {
  const { result } = await api.models({ sessionId })
  if (!result.ok || result.value === undefined) return undefined
  const choices: SubagentModelChoice[] = []
  for (const group of result.value.groups) {
    for (const model of group.models) {
      choices.push({
        provider: group.id,
        model: model.id,
        label: `${group.name} · ${model.name}`,
        ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
        efforts: model.reasoning?.efforts ?? [],
      })
    }
  }
  return { current: result.value.current, choices }
}

async function selectModel(
  api: SessionModelsApi,
  sessionId: SessionId,
  selection: { provider: string; model: string; reasoningEffort?: string },
): Promise<boolean> {
  const { result } = await api.selectModel({
    sessionId,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  })
  return result.ok
}
