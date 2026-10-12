/** In-memory RC2 configuration forms for domain-runtime unit tests. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { AUTO_REPORT_USER_SETTINGS_SCHEMA, autoReportUserSettingsBase, validatePythonExecutableSetting } from '../../src/settings.js'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export class MemorySettings extends Service {
  private readonly doc: Record<string, unknown>
  private readonly owner: Context
  constructor(ctx: Context, options: { doc?: Record<string, unknown> } = {}) {
    super(ctx, 'settings')
    this.owner = ctx
    this.doc = structuredClone(options.doc?.['autoreport-host'] ?? {}) as Record<string, unknown>
  }
  get writable(): boolean { return true }
  configure(): () => void { return () => {} }
  describe() {
    const config = this.owner.get('autoreportWorkflow')?.config
    const value = { ...autoReportUserSettingsBase(config ?? { defaultReportLanguage: 'latex', workspaceRoot: undefined, specialistModel: undefined, delegationIdleTimeoutMs: 60_000, delegationWaitTimeoutMs: 600_000 }), ...this.doc }
    return [{ ns: 'autoreport-host' as SettingsNamespace, value }]
  }
  async update(_ns: SettingsNamespace | string, patch: Record<string, unknown>): Promise<void> {
    const next = { ...this.doc, ...patch }
    const parsed = AUTO_REPORT_USER_SETTINGS_SCHEMA(next)
    validatePythonExecutableSetting(parsed, resolveDshHome())
    Object.assign(this.doc, next)
    this.owner.emit('settings/document-updated', 'autoreport-host' as SettingsNamespace, 1)
  }
  async mutate(ns: SettingsNamespace | string, ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]): Promise<void> {
    const next = structuredClone(this.doc)
    for (const op of ops) {
      let target = next
      for (const key of op.path.slice(0, -1)) target = (target[key] ??= {}) as Record<string, unknown>
      const key = op.path.at(-1)!
      if (op.op === 'set') target[key] = op.value
      else delete target[key]
    }
    await this.update(ns, next)
  }
}
