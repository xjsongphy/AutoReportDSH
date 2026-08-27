/** In-memory settings-scope double for card-form specs. */

import { vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** Handle over one stubbed scope. */
export interface StubSettingsScope<T> {
  /** The scope face handed to the form under test. */
  scope: SettingsScope<T>
  /** Spy behind `scope.set`. */
  set: ReturnType<typeof vi.fn>
  /** Spy behind `scope.unset`. */
  unset: ReturnType<typeof vi.fn>
  /**
   * Replace part of the snapshot and notify subscribers.
   * @param next - snapshot fields to replace.
   */
  publish(next: Partial<SettingsScopeSnapshot<T>>): void
}

/**
 * Build an in-memory settings scope: starts loading, records writes, and
 * lets the spec publish Host acceptances.
 * @returns the stub handle.
 */
export function stubSettingsScope<T>(): StubSettingsScope<T> {
  let snapshot: SettingsScopeSnapshot<T> = {
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(() => Promise.resolve())
  const unset = vi.fn(() => Promise.resolve())
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
      unset,
    },
    set,
    unset,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Make the stub behave like a Host that accepts every write.
 * @param host - the stub to wire.
 */
export function acceptWrites<T>(host: StubSettingsScope<T>): void {
  const section = (): Record<string, unknown> => ({ ...(host.scope.getSnapshot().value as object) })
  const layer = (): Record<string, unknown> => ({ ...(host.scope.getSnapshot().user as object) })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    const nextSection = { ...section() }
    if (base !== undefined && Object.hasOwn(base, field)) nextSection[field] = base[field]
    else delete nextSection[field]
    host.publish({ value: nextSection as T, user })
  })
}
