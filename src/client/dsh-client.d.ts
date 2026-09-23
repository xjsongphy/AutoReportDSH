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

  /** One adapter-owned reasoning effort for an exact model route. */
  export interface ModelReasoningEffort {
    readonly id: string
    readonly name: string
  }

  /** Selectable reasoning metadata for one exact model route. */
  export interface ModelReasoning {
    readonly defaultEffort?: string
    readonly efforts: readonly ModelReasoningEffort[]
  }

  /** One model displayed inside its provider group. */
  export interface ModelCatalogModel {
    readonly id: string
    readonly name: string
    readonly reasoning?: ModelReasoning
  }

  /** One provider and its successfully loaded model catalog. */
  export interface ModelProviderGroup {
    readonly id: string
    readonly name: string
    readonly models: readonly ModelCatalogModel[]
  }

  /** Host-generation model catalog with the default used by unconfigured Sessions. */
  export interface ModelCatalog {
    readonly default: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
    readonly routableProviders: readonly string[]
    readonly groups: readonly ModelProviderGroup[]
    readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
  }

  /** Typert RPC envelope: the value, or one Host-reported failure. */
  export type RemoteResult<T> = { readonly ok: true; readonly value: T } | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string }
  }

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

  /** The Host-facing remote namespaces a Client apply may call. */
  export interface IRemote {
    readonly session: {
      /** The deployment-wide model catalog, answerable without a Session. */
      modelCatalog(): Promise<RemoteResult<ModelCatalog>>
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
    remote: IRemote
    sessions: ISessions
    modelDirectories: {
      directoryFor(sessionId: SessionId): {
        load(): Promise<{
          current: { provider: string; model: string; reasoningEffort?: string } | null
          groups: readonly ModelProviderGroup[]
        }>
        select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<RemoteResult<unknown>>
      }
    }
    slots: {
      inject(slot: string, register: () => unknown): void
      register(declaration: Record<string, unknown>, component: unknown): unknown
    }
  }
}
