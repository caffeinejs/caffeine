import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../types.js'
import { coerceText } from './_coerce.js'

/** The environment as a plain record, or a function returning one — `() => Deno.env.toObject()`, say. */
export type EnvSource = Record<string, string | undefined> | (() => Record<string, string | undefined>)

export interface EnvConfigProviderOptions {
  /**
   * Where the variables are read from. Defaults to `process.env`, which Node and Bun both provide.
   *
   * This is the host seam: pass the runtime's own accessor and the provider never reaches for a global, so the
   * same code runs anywhere. It is also what a test supplies instead of mutating the real environment.
   */
  env?: EnvSource
  prefix?: string
  separator?: string
  transformKey?: (key: string) => string
}

/**
 * `HEALTH__DRAIN_DELAY` becomes `health.drainDelay`: the separator splits path segments, and underscores
 * *within* a segment fold into camelCase so that an environment variable can address a key spelled the way
 * TypeScript spells it. A single-word segment is unaffected, so `SERVER__PORT` is still `server.port`.
 *
 * An acronym does not survive the round trip — `CACHE_TTL` yields `cacheTtl`, not `cacheTTL` — because nothing
 * in an all-uppercase name says where an acronym starts. Reach those keys with a file or command-line source,
 * or supply {@link EnvConfigProviderOptions.transformKey}.
 */
function defaultTransformKey(key: string, separator: string): string {
  return key
    .split(separator)
    .map(segment => camelCase(segment.toLowerCase()))
    .join('.')
}

function camelCase(segment: string): string {
  return segment
    .split('_')
    .map((word, i) => (i === 0 || word === '' ? word : word[0].toUpperCase() + word.slice(1)))
    .join('')
}

export class EnvConfigProvider implements ConfigProvider {
  readonly id = 'env'
  readonly #env: EnvSource | undefined
  readonly #prefix: string | undefined
  readonly #separator: string
  readonly #transformKey: (key: string) => string

  constructor(options: EnvConfigProviderOptions = {}) {
    this.#env = options.env
    this.#prefix = options.prefix
    this.#separator = options.separator ?? '__'
    this.#transformKey
      = options.transformKey
        ?? (key => defaultTransformKey(key, this.#separator))
  }

  async load(_ctx: ResolutionContext): Promise<PropertySource[]> {
    const env = this.#env === undefined
      ? process.env
      : typeof this.#env === 'function' ? this.#env() : this.#env
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
        value: coerceText(rawValue),
        origin: `env:${rawKey}`,
      })
    }

    return [{ name: 'env', entries }]
  }
}
