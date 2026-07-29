import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../types.js'

export interface EnvProviderOptions {
  prefix?: string
  separator?: string
  transformKey?: (key: string) => string
}

export class EnvProvider implements ConfigProvider {
  readonly id = 'env'
  readonly #prefix: string | undefined
  readonly #separator: string
  readonly #transformKey: (key: string) => string

  constructor(options: EnvProviderOptions = {}) {
    this.#prefix = options.prefix
    this.#separator = options.separator ?? '__'
    this.#transformKey
      = options.transformKey
        ?? (key => key.toLowerCase().split(this.#separator).join('.'))
  }

  async load(ctx: ResolutionContext): Promise<PropertySource[]> {
    const env = ctx.env ?? process.env
    const entries = new Map<string, ConfigEntry>()

    for (const [rawKey, rawValue] of Object.entries(env)) {
      if (rawValue === undefined) {
        continue
      }
      if (this.#prefix && !rawKey.startsWith(this.#prefix)) {
        continue
      }

      const noPrefix = this.#prefix ? rawKey.slice(this.#prefix.length) : rawKey
      const key = this.#transformKey(noPrefix)

      entries.set(key, {
        key,
        value: coerceEnv(rawValue),
        origin: `env:${rawKey}`,
      })
    }

    return [{ name: 'env', entries }]
  }
}

function parseBoolean(value: string): boolean | undefined {
  const n = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(n)) {
    return true
  }
  if (['false', '0', 'no', 'off'].includes(n)) {
    return false
  }
  return undefined
}

function coerceEnv(value: string): string | boolean | number {
  const bool = parseBoolean(value)
  if (bool !== undefined) {
    return bool
  }
  const n = Number(value)
  if (!Number.isNaN(n) && value.trim() !== '') {
    return n
  }
  return value
}
