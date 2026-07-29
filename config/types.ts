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

export interface ResolutionContext {
  app: string
  profiles: string[]
  label?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

export interface ConfigSnapshot {
  sources: PropertySource[]
  values: Map<string, ConfigEntry>
}

export interface ConfigProvider {
  readonly id: string
  load(ctx: ResolutionContext): Promise<PropertySource[]>
  dispose?(): void | Promise<void>
}

export interface SchemaIssue {
  path: string
  message: string
  code?: string
}
