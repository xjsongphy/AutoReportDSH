/**
 * In-memory DSH settings provider for tests: proves the out-of-tree
 * `autoreport` namespace seam (install, resolve, write, describe) without
 * touching the developer's real settings document.
 * @module tests/helpers/memory-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** One process-local settings document. */
export class MemorySettings extends SettingsProvider {
  private readonly doc: Record<string, unknown>

  constructor(ctx: Context, options: { doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.doc = structuredClone(options.doc ?? {})
  }

  get writable(): boolean { return true }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[String(namespace)] = structuredClone(section)
    return Promise.resolve()
  }
}
