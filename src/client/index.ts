/**
 * Browser half of AutoReportDSH: the settings card for the `autoreport`
 * namespace, registered into DSH's plugin-configuration tab.
 *
 * Host registration of the namespace already lives in `src/runtime.ts`. This
 * file only owns chrome, controls, and copy. Cross-plugin collaboration is
 * type-only: a value import of ui-settings-plugins fails the client
 * bundle-purity gate.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { AutoReportCard } from './AutoReportCard.js'
import { AUTOREPORT_SETTINGS_NAMESPACE, AutoReportCardController } from './controller.js'
import { en, zh, type AutoReportLocaleKey } from './locales.js'
import { installCardStyles } from './styles.js'

export type { AutoReportCardProps } from './AutoReportCard.js'
export type { AutoReportCardFace, AutoReportCardSettings, AutoReportCardState } from './controller.js'
export { AUTOREPORT_SETTINGS_NAMESPACE } from './controller.js'
export type { AutoReportLocaleKey } from './locales.js'

/** Dictionary namespace owned by this card. */
export const SETTINGS_NS = 'settings.autoreport'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The AutoReport settings card's copy. */
    'settings.autoreport': AutoReportLocaleKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Register the AutoReport settings card into the plugin-configuration tab.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  installCardStyles()
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'autoreportdsh: settings dictionaries')
  const card = new AutoReportCardController(ctx.settingsScope.bind({ namespace: AUTOREPORT_SETTINGS_NAMESPACE }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: AUTOREPORT_SETTINGS_NAMESPACE,
    locale: SETTINGS_NS,
    inject: () => card.inject(),
  }, AutoReportCard))
}
