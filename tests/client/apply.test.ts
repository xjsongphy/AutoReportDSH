/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
// DSH's published `/client` entry is a window.__ModuleLoader__ bundle; tests
// load the TypeScript service (the package exports `./src/*` for this).
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { apply, inject, BUNDLE_ID, SETTINGS_NS, TOOL_NS } from '../../src/client/index.js'
import { stubSettingsScope } from './stub-scope.js'
import type { AutoReportCardSettings } from '../../src/client/controller.js'

/** Dictionary-only locale face: the published locale `/client` bundle is not Node-loadable. */
function fakeLocale() {
  let active = 'zh'
  const dicts = new Map<string, Record<string, Record<string, string>>>()
  return {
    register(ns: string, dictsByLocale: Record<string, Record<string, string>>) {
      dicts.set(ns, dictsByLocale)
      return () => { dicts.delete(ns) }
    },
    bind(ns: string) {
      return (key: string) => dicts.get(ns)?.[active]?.[key]
        ?? dicts.get(ns)?.en?.[key]
        ?? key
    },
    setLocale(id: string) {
      active = id
    },
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = fakeLocale()
  ctx.provide('locale', locale)
  const host = stubSettingsScope<AutoReportCardSettings>()
  host.publish({
    status: 'ready',
    writable: true,
    value: { defaultReportLanguage: 'latex', delegationIdleTimeoutMs: 60_000, delegationWaitTimeoutMs: 600_000 },
    base: { defaultReportLanguage: 'latex', delegationIdleTimeoutMs: 60_000, delegationWaitTimeoutMs: 600_000 },
    user: {},
  })
  ctx.provide('connection', { isLoopback: true, api: {} })
  ctx.provide('remote', { $on: () => () => {} })
  ctx.provide('settingsScope', { bind: () => host.scope })
  // The card lists projects from the session store, so the card registration
  // itself waits for this service.
  ctx.provide('sessions', {
    subagentAddress: () => undefined,
    list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, host }
}

/** Stand in for the DSH shell and chat node that own the slots under test. */
function declareCards(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
}

describe('autoreport settings card apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('registers one configuration page keyed on the bundle', async () => {
    const { ctx, slots, locale } = await bench()
    declareCards(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('plugins.bundle.config').map(entry => entry.options.key))
      .toEqual([BUNDLE_ID])
    expect(locale.bind(SETTINGS_NS)('title')).toBe('AutoReport')
    locale.setLocale('en')
    expect(locale.bind(SETTINGS_NS)('description')).toContain('Defaults for new physics-report workflows')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareCards(slots)

    await Promise.resolve()
    expect(slots.entries('plugins.bundle.config')).toHaveLength(1)
  })

  it('takes the configuration page down with the fiber', async () => {
    const { ctx, slots } = await bench()
    declareCards(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('plugins.bundle.config')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('plugins.bundle.config')).toHaveLength(0)
  })
})

describe('autoreport tool rows', () => {
  it('claims one keyed tool view per workflow-bearing tool', async () => {
    const { ctx, slots, locale } = await bench()
    declareCards(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('tool.call.toolview').map(entry => entry.options.key).sort())
      .toEqual(['send_to_agent', 'workflow_task'])
    expect(locale.bind(TOOL_NS)('board')).toBe('任务板')
    locale.setLocale('en')
    expect(locale.bind(TOOL_NS)('board')).toBe('Board')
  })

  it('takes the tool views down with the fiber', async () => {
    const { ctx, slots } = await bench()
    declareCards(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('tool.call.toolview')).toHaveLength(2)

    await fiber.dispose()

    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
  })
})
