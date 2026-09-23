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

import type { ClientContext, ISessions, ModelProviderGroup, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { AutoReportCard } from './AutoReportCard.js'
import { AUTOREPORT_SETTINGS_NAMESPACE, AutoReportCardController, type SpecialistChoice } from './controller.js'
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
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'settingsScope', 'sessions', 'modelDirectories']

/** Bundle id the Plugins page keys a bundle's own configuration by. */
export const BUNDLE_ID = 'dsh-autoreport'

/**
 * Register the AutoReport configuration page on the bundle's own page.
 *
 * `plugins.bundle.config` is the slot the Plugins page documents for a bundle's
 * own configuration; `plugins.item` is reserved for the host-plane plugins the
 * harness ships, and registering there is why the page listed AutoReport both
 * as a card in the Official group and as an installed bundle.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  try {
    installCardStyles()
    ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'AutoReportDSH: settings dictionaries')
    ctx.effect(() => ctx.locale.register(TOOL_NS, { zh: toolRowZh, en: toolRowEn }), 'AutoReportDSH: tool-row dictionaries')
    // 'sessions' is declared on the plugin's own inject: the dynamic-package
    // guard only forwards lifecycle verbs and declared services, so a dynamic
    // bundle reads the service directly instead of calling ctx.inject.
    const card = new AutoReportCardController(
      ctx.settingsScope.bind({ namespace: AUTOREPORT_SETTINGS_NAMESPACE }),
      ctx.sessions.list,
      () => loadSpecialistChoices(ctx),
    )
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_ID,
      locale: SETTINGS_NS,
      inject: () => card.inject(),
    }, AutoReportCard))
    installSubagentModelSeat(ctx)
    installToolRows(ctx)
  } catch (error) {
    console.error('[dsh-autoreport] apply failed', error)
    throw error
  }
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
  const sessions = ctx.sessions
  // The shared modelDirectories service (provided by ui-model-selection)
  // owns per-session catalogs and the selectModel write; reading it through
  // the declared-inject facade keeps the dynamic guard happy.
  const models = ctx.modelDirectories
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'autoreport-subagent-model',
    order: 40,
    locale: SETTINGS_NS,
    inject: (sessionId: SessionId): SubagentModelInjected => {
      const available = isAutoReportSubagent(sessions, sessionId)
      const directory = models.directoryFor(sessionId)
      return {
        available,
        load: () => available
          ? directory.load().then(state => directoryOf(state))
          : Promise.resolve(undefined),
        select: (selection) => available
          ? directory.select(selection).then(result => result.ok)
          : Promise.resolve(false),
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

function directoryOf(state: {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  groups: readonly ModelProviderGroup[]
}): { current: { provider: string; model: string; reasoningEffort?: string } | null; choices: readonly SubagentModelChoice[] } {
  const choices: SubagentModelChoice[] = []
  for (const group of state.groups) {
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
  return { current: state.current, choices }
}

/**
 * Load the deployment-wide model catalog for the settings card's default
 * subagent picker. The settings page has no Session, so this reads the
 * Host's global catalog RPC rather than a per-session model directory.
 */
async function loadSpecialistChoices(ctx: ClientContext): Promise<readonly SpecialistChoice[]> {
  const response = await ctx.remote.session.modelCatalog()
  if (!response.ok) throw new Error(response.error.message.length > 0 ? response.error.message : response.error.code)
  return response.value.groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    model: model.id,
    label: group.name + ' · ' + model.name,
    ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
  })))
}
