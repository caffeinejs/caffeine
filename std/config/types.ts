export type ConfigPrimitive = string | number | boolean | null
export type ConfigValue
  = | ConfigPrimitive
    | ConfigValue[]
    | { [k: string]: ConfigValue }

export interface ConfigEntry {
  key: string
  value: ConfigValue
  origin: string
  profile?: string
  label?: string
}

export interface PropertySource {
  name: string
  entries: Map<string, ConfigEntry>
}

/**
 * What a provider is told about the resolution it is taking part in: which application, which profiles, which
 * label, and whether the caller has given up waiting.
 *
 * Deliberately free of host input. The environment and the command line used to travel here, which made every
 * provider's `load` signature carry two fields only one provider each ever read, and put the host seam in the
 * wrong place — a source that reads *somewhere* should be handed that somewhere by whoever constructed it.
 * {@link EnvConfigProvider} and {@link ArgsConfigProvider} take theirs as constructor options instead.
 */
export interface ResolutionContext {
  app: string
  profiles: string[]
  label?: string
  signal?: AbortSignal
}

export interface ConfigSnapshot {
  sources: PropertySource[]
  values: Map<string, ConfigEntry>
}

export interface ConfigProvider {
  readonly id: string

  /**
   * Whether `load()` can ever return data differing from the last load. **Defaults to `false`.**
   *
   * Most sources cannot: the environment a process was started with, the arguments it was given and an inline
   * object are all fixed for its lifetime. A refresh with no reloadable source at all does nothing — it loads
   * nothing, re-validates nothing, and replaces no object — so declaring this is what buys a cheap refresh
   * rather than a pointless full resolve.
   *
   * Opt-in rather than opt-out on purpose: one source wrongly claiming it can change defeats the optimization
   * for the whole application, whereas one wrongly claiming it cannot is a visible bug in that source.
   */
  readonly reloadable?: boolean

  /**
   * A cheap stamp that changes whenever this source's data might have. When every reloadable source reports
   * the same stamp as last time, the refresh is skipped entirely.
   *
   * A source that cannot answer without doing the work — anything remote — should leave this undefined and be
   * reloaded every time.
   */
  revision?(): unknown

  load(ctx: ResolutionContext): Promise<PropertySource[]>
  dispose?(): void | Promise<void>
}
