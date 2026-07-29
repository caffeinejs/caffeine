import { ErrConfigProvider } from './errors.js'
import type { ConfigProvider, ConfigSnapshot, ResolutionContext } from './types.js'

export interface ConfigEngineOptions {
  providers: ConfigProvider[]
  failFast?: boolean
}

export class ConfigEngine {
  readonly #options: ConfigEngineOptions

  constructor(options: ConfigEngineOptions) {
    this.#options = options
  }

  async resolve(ctx: ResolutionContext): Promise<ConfigSnapshot> {
    const loaded = await Promise.all(
      this.#options.providers.map(async provider => {
        try {
          return await provider.load(ctx)
        } catch (error) {
          if (this.#options.failFast !== false) {
            throw error instanceof ErrConfigProvider ? error : new ErrConfigProvider(provider.id, error)
          }
          return []
        }
      }),
    )

    const sources = loaded.flat()

    const values: ConfigSnapshot['values'] = new Map()
    for (const source of sources) {
      for (const [key, entry] of source.entries) {
        if (!values.has(key)) {
          values.set(key, entry)
        }
      }
    }

    return { sources, values }
  }
}
