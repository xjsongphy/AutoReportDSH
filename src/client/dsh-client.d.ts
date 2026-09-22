/**
 * Ambient declarations for the browser-half context contracts AutoReportDSH's
 * card consumes. The former `@deepseek-ai/dsh-client-runtime` package was
 * split upstream into the `ui-*` client packages; these imports are type-only,
 * so the structural shapes below keep the card compiling against the running
 * DSH client services (`slots`, `locale`, `settingsScope`, `sessions`,
 * `connection`) without importing any browser bundle. Runtime wiring is the
 * `dsh.client` manifest plus the `inject` array, unchanged. Store and settings
 * types come from their real owners (`@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-settings/client`).
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** Branded session identifier as surfaced to client slots. */
  export type SessionId = string

  /** Session listing face: subagent membership plus the project-list rows. */
  export interface ISessions {
    subagentAddress(sessionId: SessionId): { parentSessionId: SessionId } | undefined
    list: {
      getSnapshot(): {
        byId: Record<string, {
          agentPreset?: string
          cwd?: string
          parentId?: string
          blank?: boolean
          displayTitle?: string
          projectionValues?: { agentPreset?: string | null }
        } & Record<string, unknown>>
      }
      subscribe(listener: () => void): () => void
    }
  }

  /** The browser-half cordis context a `/client` entry's `apply` receives. */
  export interface ClientContext {
    get<T = unknown>(name: string): T | undefined
    inject<const K extends readonly string[]>(
      names: K,
      handler: (scope: ClientContext) => void,
    ): void
    effect(fn: () => (() => void) | void, name?: string): void
    locale: {
      register(namespace: string, dictionaries: Record<string, unknown>): void
      /** Bind a translation function to a registered namespace (alpha.2 client locale contract). */
      bind(namespace: string): (key: string) => string
    }
    settingsScope: {
      bind<T>(options: { namespace: string }): import('@deepseek-ai/dsh-client-ui-settings/client').SettingsScope<T>
    }
    slots: {
      inject(slot: string, register: () => unknown): void
      register(declaration: Record<string, unknown>, component: unknown): unknown
    }
  }
}
